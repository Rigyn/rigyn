import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  authorizeAnthropic,
  authorizeGitHubCopilot,
  authorizeOAuthRegistration,
  authorizeOpenAICodex,
  assertCredentialProfileName,
  createOpenRouterLoopback,
  type ProviderAuthMethod,
  type ProviderAuthRegistry,
  type ProviderAuthState,
} from "../auth/index.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import { TrustStore } from "../config/trust.js";
import { SettingsManager } from "../core/settings-manager.js";
import type { EventEnvelope, ToolProgress } from "../core/events.js";
import type { ImageBlock, ModelInfo, ProviderAdapter, ProviderId } from "../core/types.js";
import {
  MODEL_REASONING_EFFORTS,
  modelMatchesScope,
  modelReasoningEfforts,
  normalizeModelReasoningEffort,
  orderModelsForScope,
  parseModelScope,
  resolveModelsForScope,
  SCOPED_MODELS_NONE,
  type ModelReasoningEffort,
  type ProviderRegistry,
} from "../providers/index.js";
import { providerModelToInfo } from "../providers/internal-runtime-bridge.js";
import { manageLlamaRouter } from "../providers/llama-management.js";
import { LlamaRouterClient } from "../providers/llama-router.js";
import { runShellShortcut, shellShortcutEnvironment } from "../process/user-shell.js";
import {
  withGracefulTermination,
  type GracefulTerminationContext,
} from "../process/graceful-termination.js";
import { renderExtensionCommand, renderExtensionPrompt } from "../extensions/index.js";
import type { InlineExtension } from "../extensions/direct.js";
import type {
  RuntimeAdvancedUiOperation,
  RuntimeCommandUi,
  RuntimeInitialUiOperation,
} from "../extensions/runtime.js";
import { SessionManager } from "../storage/session-manager.js";
import { exportSessionFile } from "../storage/session-export.js";
import {
  AgentSessionRuntime,
  type AgentSessionRuntimeServices,
  type SessionStartEvent as RuntimeSessionStartEvent,
} from "../service/agent-session-runtime.js";
import {
  byteTruncate,
  ConfiguredKeybindings as Keybindings,
  createInteractiveDirectUiContext,
  createNativeUiHost,
  createUnsafeTerminalHost,
  loadKeybindings,
  sanitizeTerminalText,
  TuiController,
  TuiSelectionCancelledError,
  type KeybindingAction,
  type PickerItem,
  type TuiAction,
  type TuiInputImageAttachment,
} from "../tui/index.js";
import { TerminalController, type TerminalChoice, type TerminalPrompter } from "../interfaces/terminal.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { InteractiveCommandCoordinator } from "../modes/interactive-command-coordinator.js";
import { runInteractiveShell } from "../modes/interactive-shell.js";
import { InteractiveSessionOperations, parseInteractivePathArgument } from "../modes/interactive-session-operations.js";
import { RELOAD_RESOURCE_SUMMARY } from "../interactive/commands.js";
import { AnthropicSubscriptionWarning } from "../interactive/anthropic-warning.js";
import { bindInteractiveSessionPresentation } from "../interactive/session-presentation.js";
import { presentStartupChangelog, readPackageChangelog } from "../modes/startup-changelog.js";
import {
  applyInteractiveSetting,
  interactiveSettingItems,
  tuiOperatorPreferences,
} from "./interactive-settings.js";
import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
} from "./active-submission.js";
import { resolveRuntimeShortcuts } from "./extension-shortcuts.js";
import { installInteractiveEmergencyRecovery } from "./interactive-emergency.js";
import { resolveRequestedModel } from "./model-resolution.js";
import { combinePromptImages, expandPromptReferences } from "./prompt-input.js";
import { parseArgs, type Args } from "./args.js";
import {
  flagBoolean,
  flagString,
  flagStrings,
  parseManagementArguments,
  type ManagementArguments,
} from "./management-args.js";
import { loadRuntime, preactivateProjectTrustExtensions, type LoadedRuntime } from "./runtime.js";
import { persistDefaultSelection } from "./setup.js";
import { renderCliHelp } from "./help.js";
import { runRpcServer } from "./rpc.js";
import { runDiagnosticsCommand } from "./diagnostics-command.js";
import { runExtensionsCommand, runPackageCommand, runPackageConfigCommand, runProjectPackageCommand } from "./extensions-command.js";
import { runProductInstallAction } from "./product-install.js";
import { runSessionsCommand } from "./sessions-command.js";
import { createStartupSession } from "./session-startup.js";
import { selectStartupSession } from "./session-picker.js";
import { ThemeHotReloader } from "./theme-hot-reload.js";
import { applyRuntimeExtensionFlags } from "./extension-flags.js";
import { agentPaths, expandPath } from "./paths.js";
import { ProjectTrustResolver } from "./project-trust.js";
import { RIGYN_VERSION } from "../version.js";
import { defaultTools, selectedTools } from "./tool-selection.js";
import { runSettingsConfigCommand } from "./config-settings-command.js";

export { defaultTools, selectedTools };

class ScopedTrustPrompter implements TerminalPrompter {
  async question(prompt: string, signal?: AbortSignal): Promise<string> {
    const terminal = new TerminalController();
    try { return await terminal.question(prompt, signal); }
    finally { terminal.close(); }
  }

  async choose<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T> {
    const terminal = new TerminalController();
    try { return await terminal.choose(prompt, choices, signal); }
    finally { terminal.close(); }
  }
}

interface InvocationTrustOptions {
  workspace: string;
  override?: boolean;
  terminal?: TerminalPrompter;
  extensions: boolean;
  extensionPaths: readonly string[];
  extensionFactories: readonly InlineExtension[];
}

async function createInvocationTrustResolver(options: InvocationTrustOptions): Promise<ProjectTrustResolver> {
  const paths = agentPaths();
  const settings = SettingsManager.create(resolve(options.workspace), paths.agentDirectory, { projectTrusted: false });
  await settings.reload();
  return new ProjectTrustResolver(new TrustStore(paths.trustStore), {
    ...(options.override === undefined ? {} : { override: options.override ? "approve" : "deny" }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    defaultProjectTrust: settings.getDefaultProjectTrust(),
    cwd: process.cwd(),
    preactivate: async (workspace) => await preactivateProjectTrustExtensions(paths, workspace, {
      extensions: options.extensions,
      extensionPaths: options.extensionPaths,
      extensionFactories: options.extensionFactories,
      extensionRuntime: true,
    }),
  });
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort?: ModelReasoningEffort;
}

export function parseInteractiveModelReference(
  reference: string | undefined,
  provider: ProviderId | undefined,
  providers: readonly string[],
): { provider: ProviderId | undefined; model: string | undefined } {
  if (reference === undefined) return { provider, model: undefined };
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return { provider, model: reference };
  const candidate = reference.slice(0, separator);
  return providers.includes(candidate)
    ? { provider: candidate, model: reference.slice(separator + 1) }
    : { provider, model: reference };
}

export const THINKING_LEVELS = MODEL_REASONING_EFFORTS;
export type ThinkingLevel = ModelReasoningEffort;

export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  openai: "gpt-5.6-sol",
  "openai-codex": "gpt-5.6-sol",
  anthropic: "claude-opus-4-8",
  gemini: "gemini-3.1-pro-preview",
  mistral: "devstral-medium-latest",
  openrouter: "moonshotai/kimi-k2.6",
  groq: "openai/gpt-oss-120b",
  cerebras: "zai-glm-4.7",
  xai: "grok-4.20-0309-reasoning",
  deepseek: "deepseek-v4-pro",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  together: "moonshotai/Kimi-K2.6",
  "vercel-ai-gateway": "anthropic/claude-sonnet-4.6",
  zai: "glm-5.1",
  "zai-coding-cn": "glm-5.1",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k2.6",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  xiaomi: "mimo-v2.5-pro",
  "xiaomi-token-plan-cn": "mimo-v2.5-pro",
  "xiaomi-token-plan-ams": "mimo-v2.5-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
  "kimi-coding": "kimi-for-coding",
  minimax: "MiniMax-M3",
  "minimax-cn": "MiniMax-M3",
});

export { modelMatchesScope, orderModelsForScope, parseModelScope, SCOPED_MODELS_NONE };

export function thinkingLevelsForModel(model: ModelInfo | undefined): readonly ThinkingLevel[] {
  if (model === undefined) return THINKING_LEVELS;
  if (model.compatibility?.reasoningEfforts === undefined && model.capabilities.reasoning.value === "unknown") return ["off"];
  return modelReasoningEfforts(model);
}

export function compatibleThinkingLevel(requested: ThinkingLevel, model: ModelInfo | undefined): ThinkingLevel {
  const supported = thinkingLevelsForModel(model);
  return supported.includes(requested) ? requested : supported[0] ?? "off";
}

export function selectDefaultModelAfterLogin(
  provider: ProviderId,
  models: readonly Pick<ModelInfo, "id" | "provider">[],
  configured?: ModelSelection,
  active?: ModelSelection,
): ModelSelection | undefined {
  if (active !== undefined) return undefined;
  const preferred = configured?.provider === provider ? configured.model : DEFAULT_MODEL_PER_PROVIDER[provider];
  return preferred !== undefined && models.some((model) => model.provider === provider && model.id === preferred)
    ? { provider, model: preferred }
    : undefined;
}

export function selectAutomaticModel(
  models: readonly Pick<ModelInfo, "id" | "provider">[],
  configured?: ModelSelection,
): ModelSelection | undefined {
  if (configured !== undefined && models.some((model) => model.provider === configured.provider && model.id === configured.model)) return configured;
  for (const [provider, model] of Object.entries(DEFAULT_MODEL_PER_PROVIDER)) {
    if (models.some((candidate) => candidate.provider === provider && candidate.id === model)) return { provider, model };
  }
  return models[0] === undefined ? undefined : { provider: models[0].provider, model: models[0].id };
}

export function isAgentOpenAIModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (id === "" || /^(?:babbage|davinci)(?:-|$)/u.test(id) || /^text-(?:babbage|davinci)(?:-|$)/u.test(id)) return false;
  if (/^gpt-3\.5(?:-|$)/u.test(id) || /^gpt-4(?:$|-(?:\d|turbo))/u.test(id)) return false;
  if (id.startsWith("dall-e-") || id.startsWith("gpt-image-") || id.startsWith("chatgpt-image-")) return false;
  return !/(?:^|[-_.])(?:embedding|image|audio|realtime|transcribe|transcription|tts|whisper|moderation|search)(?:[-_.]|$)/u.test(id);
}

export interface ProviderModelCatalogStatus {
  provider: string;
  status: "available" | "unverified" | "empty" | "disconnected" | "authentication" | "network" | "timeout" | "unavailable";
  authStatus?: ProviderAuthState["status"];
  authSource?: ProviderAuthState["source"];
}

export function modelCatalogEmptyMessage(statuses: readonly ProviderModelCatalogStatus[]): string | undefined {
  const unavailable = statuses.filter((entry) =>
    entry.authStatus === "connected" && entry.authSource !== "local" &&
    entry.status !== "available" && entry.status !== "authentication");
  if (unavailable.length === 0) return undefined;
  const shown = unavailable.slice(0, 6).map((entry) => `${byteTruncate(sanitizeTerminalText(entry.provider), 96)} (${entry.status})`);
  return `Connected provider catalogs are unavailable: ${shown.join(", ")}${unavailable.length > shown.length ? `, +${unavailable.length - shown.length} more` : ""}. Retry /model or /reload; use /login only to change credentials.`;
}

export function classifyModelCatalogFailure(error: unknown): "authentication" | "network" | "timeout" | "unavailable" {
  const category = error !== null && typeof error === "object" && "category" in error
    ? String(error.category)
    : undefined;
  if (category === "authentication" || category === "permission") return "authentication";
  if (category === "timeout" || category === "cancelled") return "timeout";
  if (category === "network") return "network";
  const message = error instanceof Error ? error.message : String(error);
  if (/(?:unauthori[sz]ed|forbidden|credential|api[ _-]?key|access token|\b401\b|\b403\b)/iu.test(message)) return "authentication";
  if (/(?:timed? ?out|abort)/iu.test(message)) return "timeout";
  if (/(?:network|fetch failed|econn|enotfound|dns|socket)/iu.test(message)) return "network";
  return "unavailable";
}

function modelItem(model: ModelInfo): PickerItem<ModelSelection> {
  return {
    id: `${model.provider}\0${model.id}`,
    label: `${model.provider} / ${model.id}`,
    value: { provider: model.provider, model: model.id },
    keywords: [model.provider, model.id, model.displayName ?? "", model.description ?? ""],
    ...(() => {
      const detail = [model.displayName, model.description, model.contextTokens === undefined ? undefined : `${model.contextTokens.toLocaleString()} context`]
        .filter(Boolean).join(" · ");
      return detail === "" ? {} : { detail };
    })(),
  };
}

export async function refreshModelPicker(
  providers: readonly Pick<ProviderAdapter, "id" | "listModels">[],
  terminal: Pick<TuiController, "setPickerItems" | "addPickerItems"> & Partial<Pick<TuiController,
    "setModelCycleItems" | "setModelPickerItems" | "addModelPickerItems" | "setModelPickerLoading" | "notify">>,
  current: ModelSelection | undefined,
  signal: AbortSignal,
  patterns: readonly string[] = [],
  auth?: Pick<ProviderAuthRegistry, "state">,
  onStatus?: (statuses: readonly ProviderModelCatalogStatus[]) => void,
  catalog?: Pick<ProviderRegistry, "listModels"> & Partial<Pick<ProviderRegistry, "catalogStatus">>,
  options: { refresh?: boolean } = {},
): Promise<ModelInfo[]> {
  type CatalogResult = {
    provider: ProviderId;
    models: ModelInfo[];
    authState?: ProviderAuthState;
    status: ProviderModelCatalogStatus["status"];
  };
  const loadCatalog = async (provider: Pick<ProviderAdapter, "id" | "listModels">): Promise<CatalogResult> => {
    let authState: ProviderAuthState | undefined;
    try {
      authState = await auth?.state(provider.id);
      const disconnected = authState !== undefined && (
        authState.status === "unavailable" ||
        (authState.status === "available" && (authState.source === undefined || authState.error !== undefined))
      );
      if (disconnected) return { provider: provider.id, models: [], ...(authState === undefined ? {} : { authState }), status: "disconnected" };
      const catalogSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let models: ModelInfo[];
      if (catalog === undefined) models = options.refresh === false ? [] : await provider.listModels(catalogSignal);
      else {
        models = await catalog.listModels(provider.id, catalogSignal, { refresh: options.refresh !== false, verifiedOnly: true });
        const state = (await catalog.catalogStatus?.(provider.id))?.[0];
        if (state?.provenance !== "live" || state.error !== undefined || state.stale) {
          return { provider: provider.id, models: [], ...(authState === undefined ? {} : { authState }), status: classifyModelCatalogFailure(state?.error?.message) };
        }
      }
      return { provider: provider.id, models, ...(authState === undefined ? {} : { authState }), status: models.length === 0 ? "empty" : "available" };
    } catch (error) {
      return { provider: provider.id, models: [], ...(authState === undefined ? {} : { authState }), status: classifyModelCatalogFailure(error) };
    }
  };
  const pickerItems = (entry: CatalogResult): PickerItem<ModelSelection>[] => entry.status !== "available"
    ? []
    : entry.models.filter((model) => entry.provider !== "openai" || isAgentOpenAIModel(model.id)).map(modelItem);
  const scopedItems = (entries: readonly PickerItem<ModelSelection>[], models: readonly ModelInfo[]) => {
    const byKey = new Map(entries.map((item) => [`${item.value.provider}\0${item.value.model}`, item]));
    const metadata = new Map(models.map((model) => [`${model.provider}\0${model.id}`, model]));
    return resolveModelsForScope(entries.map((item) => item.value), patterns, (selection) => {
      const model = metadata.get(`${selection.provider}\0${selection.model}`);
      return model === undefined ? undefined : modelReasoningEfforts(model);
    }).models.flatMap((selection) => {
      const item = byKey.get(`${selection.provider}\0${selection.model}`);
      return item === undefined ? [] : [{
        ...item,
        value: selection,
        ...(selection.reasoningEffort === undefined ? {} : { detail: [item.detail, `thinking ${selection.reasoningEffort}`].filter(Boolean).join(" · ") }),
      }];
    });
  };
  terminal.setModelPickerLoading?.(true);
  try {
    const catalogs = await Promise.all(providers.map(async (provider) => {
      const result = await loadCatalog(provider);
      if (!signal.aborted && result.status === "available") {
        const available = pickerItems(result);
        const scoped = scopedItems(available, result.models);
        if (terminal.addModelPickerItems !== undefined) terminal.addModelPickerItems(available, patterns.length === 0 ? undefined : scoped);
        else terminal.addPickerItems("model", patterns.length === 0 ? available : scoped);
      }
      return result;
    }));
    const discovered = catalogs.filter((entry) => entry.status === "available").flatMap((entry) => entry.models);
    if (signal.aborted) return discovered;
    const statuses = catalogs.map((entry): ProviderModelCatalogStatus => ({
      provider: entry.provider,
      status: entry.status,
      ...(entry.authState === undefined ? {} : { authStatus: entry.authState.status }),
      ...(entry.authState?.source === undefined ? {} : { authSource: entry.authState.source }),
    }));
    onStatus?.(statuses);
    const unavailable = catalogs.filter((entry) => entry.status !== "available" && entry.status !== "disconnected" && (
      entry.provider === current?.provider || (current === undefined && entry.authState?.status === "connected" && entry.authState.source !== "local")
    ));
    if (unavailable.length > 0) terminal.notify?.(`Model catalogs: ${unavailable.map((entry) => `${entry.provider} (${entry.status})`).join(", ")}`, "warning");
    const allAvailable = catalogs.flatMap(pickerItems);
    const scoped = resolveModelsForScope(allAvailable.map((item) => item.value), patterns, (selection) => {
      const model = discovered.find((entry) => entry.provider === selection.provider && entry.id === selection.model);
      return model === undefined ? undefined : modelReasoningEfforts(model);
    });
    if (scoped.omittedCount > 0) terminal.notify?.(`Model scope ignored ${scoped.omittedCount} unsupported thinking selection${scoped.omittedCount === 1 ? "" : "s"}`, "warning");
    const cycleItems = scopedItems(allAvailable, discovered);
    terminal.setModelCycleItems?.(cycleItems);
    const currentItem = current === undefined ? undefined : allAvailable.find((item) => item.value.provider === current.provider && item.value.model === current.model);
    const ordered = currentItem === undefined ? allAvailable.sort((left, right) => left.label.localeCompare(right.label)) : [currentItem, ...allAvailable.filter((item) => item !== currentItem).sort((left, right) => left.label.localeCompare(right.label))];
    if (terminal.setModelPickerItems !== undefined) terminal.setModelPickerItems(ordered, patterns.length === 0 ? undefined : cycleItems);
    else terminal.setPickerItems("model", patterns.length === 0 ? ordered : cycleItems);
    return discovered;
  } finally { terminal.setModelPickerLoading?.(false); }
}

export { runShellShortcut, shellShortcutEnvironment };

function elapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function shellShortcutProgressStatus(command: string, progress?: ToolProgress): string {
  const shown = byteTruncate(sanitizeTerminalText(defaultSecretRedactor.redact(command)).replace(/\s+/gu, " ").trim(), 160);
  if (progress === undefined || progress.type !== "output") return `Shell running · $ ${shown}`;
  return byteTruncate(`Shell running · $ ${shown} · ${elapsed(progress.elapsedMs ?? 0)} elapsed · ${progress.stream} · ${progress.stdoutBytes} B stdout · ${progress.stderrBytes} B stderr`, 768);
}

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({ escape: "Esc", enter: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", up: "Up", down: "Down", left: "Left", right: "Right" });

export function displayKeybinding(value: string): string {
  return value.split("+").map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join("+");
}

function bindingHint(keybindings: Keybindings, action: KeybindingAction, maximum = 3): string {
  return keybindings.keys(action).slice(0, maximum).map(displayKeybinding).join("/");
}

export function formatHotkeys(keybindings: Keybindings): string {
  return [
    `${bindingHint(keybindings, "app.interrupt")} interrupt`,
    `${bindingHint(keybindings, "app.clear")} clear/exit`,
    `${bindingHint(keybindings, "app.exit")} exit`,
    "/ commands",
  ].filter((value) => !value.startsWith(" ")).join(" · ");
}

export interface StartupInventory {
  providers?: readonly string[];
  models?: readonly string[];
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
  themes?: readonly string[];
  instructions?: readonly string[];
  warnings?: readonly string[];
}

export function formatStartupReport(inventory: StartupInventory, workspace: string, keybindings = new Keybindings()): string {
  const loaded = [
    inventory.extensions?.length ? `${inventory.extensions.length} extensions` : undefined,
    inventory.skills?.length ? `${inventory.skills.length} skills` : undefined,
    inventory.prompts?.length ? `${inventory.prompts.length} prompts` : undefined,
  ].filter(Boolean).join(" · ");
  return [`Rigyn ${RIGYN_VERSION} · Ready`, formatHotkeys(keybindings), `Workspace: ${workspace}`, loaded === "" ? undefined : `Loaded: ${loaded}`]
    .filter((value): value is string => value !== undefined).join("\n");
}

export function formatCompactStartupReport(inventory: StartupInventory, workspace: string, keybindings = new Keybindings()): string {
  return formatStartupReport(inventory, workspace, keybindings);
}

function shellArgument(value: string): string {
  return value !== "" && !/[^a-zA-Z0-9_\-./~:@]/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
  if (process.stdout.isTTY !== true || !sessionManager.isPersisted()) return undefined;
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile === undefined || !existsSync(sessionFile)) return undefined;
  const argumentsValue = ["rigyn"];
  if (!sessionManager.usesDefaultSessionDir()) {
    argumentsValue.push("--session-dir", shellArgument(sessionManager.getSessionDir()));
  }
  argumentsValue.push("--session", sessionManager.getSessionId());
  return argumentsValue.join(" ");
}

export { parseInteractivePathArgument };

export function latestAssistantText(events: readonly EventEnvelope[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type !== "message_appended" || event.message.role !== "assistant") continue;
    const text = event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
    if (text !== "") return text;
  }
  return undefined;
}

export type LoginPath = "subscription" | "api_key";

export function authMethodLoginPath(method: ProviderAuthMethod): LoginPath {
  return ["oauth", "managed_oauth", "openai_codex_browser", "openai_codex_device", "anthropic_browser", "github_copilot_device"].includes(method.kind)
    ? "subscription"
    : "api_key";
}

function managedAuthText(value: unknown, label: string, maximum = 4_096): string {
  if (
    typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function managedAuthUrl(value: string | URL): URL {
  const url = new URL(String(value));
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" || url.password !== "" || Buffer.byteLength(url.toString(), "utf8") > 16 * 1024
  ) throw new TypeError("Managed provider authorization URL is invalid");
  return url;
}

function openBrowser(url: URL, disabled: boolean): void {
  if (disabled) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function pickLoginProvider(runtime: LoadedRuntime, terminal: TerminalPrompter, path: LoginPath, signal?: AbortSignal): Promise<ProviderId> {
  const providerIds = new Set([
    ...runtime.providers.list().map((provider) => provider.id),
    ...runtime.modelRegistry.models().getProviders().map((provider) => provider.id),
  ]);
  const choices = (await Promise.all([...providerIds].map(async (provider) => {
    const legacy = runtime.auth.has(provider)
      ? (await runtime.auth.loginMethods(provider)).some((method) => authMethodLoginPath(method) === path)
      : false;
    const direct = runtime.modelRegistry.getProvider(provider);
    const native = path === "subscription" ? direct?.auth.oauth !== undefined : direct?.auth.apiKey !== undefined;
    return legacy || native ? { label: runtime.modelRegistry.getProviderDisplayName(provider), value: provider } : undefined;
  }))).filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (choices.length === 0) throw new Error(`No ${path === "subscription" ? "subscription" : "API-key"} login is registered`);
  return await terminal.choose("Select provider", choices, signal) as ProviderId;
}

async function loginDirectProvider(
  runtime: LoadedRuntime,
  terminal: TuiController,
  provider: ProviderId,
  path: LoginPath,
  signal: AbortSignal | undefined,
  noBrowser: boolean,
): Promise<void> {
  await runtime.modelRegistry.models().login(provider, path === "subscription" ? "oauth" : "api_key", {
    ...(signal === undefined ? {} : { signal }),
    async prompt(prompt) {
      const selectedSignal = prompt.signal ?? signal;
      if (prompt.type === "secret") return await terminal.readSecret(`${prompt.message}: `, selectedSignal);
      if (prompt.type === "select") {
        return await terminal.choose(prompt.message, prompt.options.map((entry) => ({
          label: entry.label,
          ...(entry.description === undefined ? {} : { detail: entry.description }),
          value: entry.id,
        })), selectedSignal);
      }
      return await terminal.question(prompt.message, selectedSignal);
    },
    notify(event) {
      if (event.type === "auth_url") {
        const url = new URL(event.url);
        terminal.notify(`${event.instructions ?? "Open this URL to sign in:"}\n${url}`);
        openBrowser(url, noBrowser);
      } else if (event.type === "device_code") {
        const url = new URL(event.verificationUri);
        terminal.notify(`Open ${url} and enter code ${event.userCode}`);
        openBrowser(url, noBrowser);
      } else {
        const links = event.links?.map((link) => `${link.label ?? link.url}: ${link.url}`).join("\n");
        terminal.notify(links === undefined ? event.message : `${event.message}\n${links}`);
      }
    },
  });
  await runtime.modelRegistry.refresh({ force: true, ...(signal === undefined ? {} : { signal }) });
}

type InteractiveLoginProfile =
  | { action: "authenticate"; profile?: string }
  | { action: "selected"; profile: string };

async function chooseInteractiveLoginProfile(
  runtime: LoadedRuntime,
  terminal: TuiController,
  provider: ProviderId,
  signal?: AbortSignal,
): Promise<InteractiveLoginProfile> {
  signal?.throwIfAborted();
  let state: Awaited<ReturnType<LoadedRuntime["auth"]["profileState"]>>;
  try { state = await runtime.auth.profileState(provider); }
  catch { return { action: "authenticate" }; }
  if (state.profiles.length === 0) return { action: "authenticate" };
  const choices: Array<{ label: string; detail: string; value: InteractiveLoginProfile }> = state.profiles.flatMap((profile) => [
    ...(profile.present && profile.usable ? [{
      label: `Use saved profile ${profile.name}`,
      detail: profile.active ? "active · ready" : "ready",
      value: { action: "selected" as const, profile: profile.name },
    }] : []),
    {
      label: `Sign in again to profile ${profile.name}`,
      detail: profile.error ?? "Replace only this profile after authentication succeeds",
      value: { action: "authenticate" as const, profile: profile.name },
    },
  ]);
  const selected = await terminal.choose(`Credential profile for ${provider}`, [...choices, {
    label: "Add a new profile",
    detail: "Keep every existing profile",
    value: { action: "authenticate" as const },
  }], signal);
  if (selected.action === "selected") {
    await runtime.auth.selectProfile(provider, selected.profile);
    return selected;
  }
  if (selected.profile !== undefined) return selected;
  const profile = (await terminal.question("New credential profile name: ", signal)).trim();
  assertCredentialProfileName(profile);
  if (state.profiles.some((entry) => entry.name === profile)) throw new Error(`Credential profile already exists: ${profile}`);
  return { action: "authenticate", profile };
}

export async function pickModel(runtime: LoadedRuntime, provider: ProviderId, terminal: TerminalPrompter): Promise<string> {
  try {
    const signal = AbortSignal.timeout(30_000);
    const refresh = await runtime.providers.refreshModels(provider, signal);
    if (!refresh.ok) throw new Error(refresh.status.error?.message ?? "model discovery failed");
    const models = await runtime.providers.listModels(provider, signal, { verifiedOnly: true });
    const selectable = provider === "openai" ? models.filter((model) => isAgentOpenAIModel(model.id)) : models;
    if (selectable.length > 0) return await terminal.choose(`Select ${provider} model`, selectable.map((model) => ({ label: model.id, value: model.id })));
  } catch (error) {
    if (terminal instanceof TuiController) terminal.notify(`Could not load ${provider} models: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
  const exact = (await terminal.question("Exact model/deployment ID: ")).trim();
  if (exact === "") throw new Error("Model is required");
  return exact;
}

export async function loginInteractively(
  runtime: LoadedRuntime,
  terminal: TuiController,
  requested?: string,
  signal?: AbortSignal,
  noBrowser = false,
): Promise<ProviderId> {
  let path: LoginPath | undefined;
  const provider = requested === undefined || requested === ""
    ? await (async () => {
        path = await terminal.choose("Select authentication method", [
          { label: "Use a subscription", value: "subscription" as const },
          { label: "Use an API key", value: "api_key" as const },
        ], signal);
        return await pickLoginProvider(runtime, terminal, path, signal);
      })()
    : requested;
  runtime.providers.get(provider);
  if (!runtime.auth.has(provider)) {
    const direct = runtime.modelRegistry.getProvider(provider);
    if (direct === undefined) throw new Error(`Unknown provider: ${provider}`);
    const paths: LoginPath[] = [
      ...(direct.auth.oauth === undefined ? [] : ["subscription" as const]),
      ...(direct.auth.apiKey === undefined ? [] : ["api_key" as const]),
    ];
    path ??= paths.length === 1
      ? paths[0]
      : await terminal.choose(`Connect ${direct.name}`, paths.map((value) => ({
          label: value === "subscription" ? direct.auth.oauth?.loginLabel ?? "Use a subscription" : "Use an API key",
          value,
        })), signal);
    if (path === undefined || !paths.includes(path)) throw new Error(`${provider} does not expose an interactive login method`);
    await loginDirectProvider(runtime, terminal, provider, path, signal, noBrowser);
    return provider;
  }
  const profile = await chooseInteractiveLoginProfile(runtime, terminal, provider, signal);
  if (profile.action === "selected") return provider;
  const storeOptions = profile.profile === undefined ? {} : { profile: profile.profile, select: true };
  const available = await runtime.auth.loginMethods(provider);
  const paths = [...new Set(available.map(authMethodLoginPath))];
  if (paths.length === 0) throw new Error(`${provider} does not expose an interactive login method`);
  path ??= paths.length === 1 ? paths[0] : await terminal.choose(`Connect ${provider}`, paths.map((value) => ({ label: value === "subscription" ? "Use a subscription" : "Use an API key", value })), signal);
  const methods = available.filter((method) => authMethodLoginPath(method) === path);
  if (methods.length === 0) throw new Error(`${provider} does not expose an interactive login method`);
  const method = methods.length === 1 ? methods[0]! : await terminal.choose(`Connect ${provider}`, methods.map((value) => ({ label: value.label, detail: value.detail, value })), signal);
  const binding = runtime.auth.binding(provider);
  if (method.kind === "local" || method.kind === "external") { terminal.notify(method.detail); return provider; }
  if (method.kind === "environment" || method.kind === "ambient") { await runtime.auth.selectFallback(provider); return provider; }
  if (method.kind === "openrouter_browser") {
    const session = await createOpenRouterLoopback({ fetch: runtime.network.fetch, ...(signal === undefined ? {} : { signal }) });
    terminal.notify(`Open this URL to sign in:\n${session.authorizationUrl.toString()}`); openBrowser(session.authorizationUrl, noBrowser);
    await runtime.auth.storeCredential(provider, { kind: "api_key", provider: binding.credentialId, apiKey: await session.waitForKey() }, storeOptions); return provider;
  }
  const authorizationUi = {
    showAuthorization: ({ url, userCode }: { url: URL; userCode?: string }) => {
      terminal.notify(userCode === undefined ? `Open this URL to sign in:\n${url}` : `Open ${url} and enter code ${userCode}`); openBrowser(url, noBrowser);
    },
    openUrl: (url: URL) => openBrowser(url, noBrowser),
    requestManualAuthorization: async (_value: unknown, selectedSignal: AbortSignal) => {
      const answer = (await terminal.question("Paste the callback URL or authorization code, or press Enter to keep waiting: ", selectedSignal)).trim();
      return answer === "" ? undefined : answer;
    },
  };
  if (method.kind === "openai_codex_browser" || method.kind === "openai_codex_device") {
    const credential = await authorizeOpenAICodex({ flow: method.kind === "openai_codex_browser" ? "browser" : "device", ...authorizationUi, ...(signal === undefined ? {} : { signal }), fetch: runtime.network.fetch });
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "anthropic_browser") {
    const credential = await authorizeAnthropic({ ...authorizationUi, ...(signal === undefined ? {} : { signal }), fetch: runtime.network.fetch });
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "github_copilot_device") {
    const credential = await authorizeGitHubCopilot({
      requestHost: async () => undefined,
      showDeviceCode: ({ url, userCode }) => authorizationUi.showAuthorization({ url, userCode }),
      openUrl: authorizationUi.openUrl,
      showProgress: (message) => terminal.notify(message),
      ...(signal === undefined ? {} : { signal }), fetch: runtime.network.fetch,
    });
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "oauth") {
    const credential = await authorizeOAuthRegistration(runtime.auth.registration(method.registrationId), binding.credentialId, { ...authorizationUi, ...(signal === undefined ? {} : { signal }), fetch: runtime.network.fetch });
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "managed_oauth") {
    const interaction = signal ?? new AbortController().signal;
    const credential = await runtime.auth.authorizeManaged(provider, method.methodId, {
      signal: interaction,
      showAuthorization: async ({ url }) => { const selected = managedAuthUrl(url); terminal.notify(`Open this URL to sign in:\n${selected}`); openBrowser(selected, noBrowser); },
      showDeviceCode: async ({ verificationUri, userCode }) => {
        const selected = managedAuthUrl(verificationUri);
        const code = managedAuthText(userCode, "Managed provider device code", 1_024);
        terminal.notify(`Open ${selected} and enter code ${code}\nWaiting for authentication...`);
        openBrowser(selected, noBrowser);
      },
      showProgress: (message) => terminal.notify(managedAuthText(message, "Managed provider progress")),
      prompt: async (input) => await terminal.question(managedAuthText(input.message, "Managed provider prompt"), interaction),
      select: async (input) => {
        const message = managedAuthText(input.message, "Managed provider selection prompt");
        if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 64) {
          throw new TypeError("Managed provider selection options are invalid");
        }
        return await terminal.choose(message, input.options.map((option) => ({
          label: managedAuthText(option.label, "Managed provider selection label", 256),
          ...(option.detail === undefined ? {} : { detail: managedAuthText(option.detail, "Managed provider selection detail", 2_048) }),
          value: managedAuthText(option.id, "Managed provider selection ID", 128),
        })), interaction);
      },
    });
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  const secret = await terminal.readSecret(`${provider} ${method.kind === "api_key" ? "API key" : "bearer token"}: `, signal);
  if (secret === "") throw new Error("Credential is empty");
  defaultSecretRedactor.register(secret);
  await runtime.auth.storeCredential(provider, method.kind === "api_key"
    ? { kind: "api_key", provider: binding.credentialId, apiKey: secret }
    : { kind: "bearer", provider: binding.credentialId, accessToken: secret }, storeOptions);
  return provider;
}

export function runtimeUi(terminal: TuiController, extensionId: string, lifecycleSignal?: AbortSignal, interactionSignal = lifecycleSignal): RuntimeCommandUi {
  const key = (value: string) => `${extensionId}:${value}`;
  const current = (): void => { if (lifecycleSignal?.aborted === true) throw new Error(`Extension UI context is no longer active: ${extensionId}`); };
  const combined = (signal?: AbortSignal): AbortSignal | undefined => interactionSignal === undefined ? signal : signal === undefined ? interactionSignal : AbortSignal.any([interactionSignal, signal]);
  const cancelled = (error: unknown, signal?: AbortSignal) => error instanceof TuiSelectionCancelledError || signal?.aborted === true;
  return {
    notify: (message, kind = "status") => { current(); terminal.notify(message, kind); },
    setStatus: (name, value) => { current(); terminal.setExtensionStatus(key(name), value); },
    setWidget: (name, value) => { current(); terminal.setExtensionWidget(key(name), value); },
    setHeader: (name, value) => { current(); terminal.setExtensionHeader(key(name), value); },
    setFooter: (name, value) => { current(); terminal.setExtensionFooter(key(name), value); },
    setWorkingMessage: (value) => { current(); terminal.setExtensionWorkingMessage(extensionId, value); },
    setWorkingVisible: (value) => { current(); terminal.setExtensionWorkingVisible(extensionId, value); },
    setTitle: (value) => { current(); terminal.setTitle(value); },
    getTheme: async (signal) => { current(); combined(signal)?.throwIfAborted(); return { name: terminal.selectedThemeName(), available: terminal.themeNames() }; },
    setTheme: async (name, signal) => { current(); combined(signal)?.throwIfAborted(); terminal.setTheme(name); return { name: terminal.selectedThemeName(), available: terminal.themeNames() }; },
    select: async (prompt, options, signal) => await terminal.choose(prompt, options.map((option) => ({ ...option })), combined(signal)),
    confirm: async (title, message, signal) => { const selected = combined(signal); try { return await terminal.choose(`${title}: ${message}`, [{ label: "Yes", value: true }, { label: "No", value: false }], selected); } catch (error) { if (cancelled(error, selected)) return false; throw error; } },
    input: async (title, placeholder, signal) => { const selected = combined(signal); try { return await terminal.requestInput(title, placeholder, selected); } catch (error) { if (cancelled(error, selected)) return undefined; throw error; } },
    editor: async (title, prefill, signal) => { const selected = combined(signal); try { return await terminal.editor(title, prefill, selected); } catch (error) { if (cancelled(error, selected)) return undefined; throw error; } },
    setEditorText: (value) => { current(); terminal.setEditorText(value); },
    getEditorText: () => { current(); return terminal.getEditorText(); },
    custom: async (factory, options, signal) => await terminal.custom(factory, options, combined(signal)),
    showOverlay: (factory, options, signal) => terminal.showOverlay(factory, options, combined(signal)),
  };
}

function applyRuntimeUi(terminal: TuiController, operation: RuntimeInitialUiOperation): void {
  const ui = runtimeUi(terminal, operation.extensionId);
  if (operation.type === "notify") ui.notify(operation.value, operation.kind);
  else if (operation.type === "title") ui.setTitle(operation.value);
  else if (operation.type === "status") ui.setStatus(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "widget") ui.setWidget(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "header") ui.setHeader(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "footer") ui.setFooter(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "working_message") ui.setWorkingMessage(operation.value || undefined);
  else ui.setWorkingVisible(operation.visible);
}

function applyRuntimeAdvancedUi(terminal: TuiController, operation: RuntimeAdvancedUiOperation): void {
  if (operation.type === "component") {
    terminal.setPersistentComponent(
      operation.slot,
      `${operation.extensionId}:${operation.key}`,
      operation.factory,
      operation.signal,
    );
  } else if (operation.type === "working_indicator") {
    terminal.setKeyedWorkingIndicator(`${operation.extensionId}:global`, operation.value, operation.signal);
  } else if (operation.type === "hidden_reasoning_label") {
    terminal.setKeyedHiddenReasoningLabel(`${operation.extensionId}:global`, operation.value, operation.signal);
  } else if (operation.type === "tool_output_expanded") {
    terminal.setKeyedToolOutputExpanded(`${operation.extensionId}:global`, operation.expanded, operation.signal);
  } else {
    terminal.setNormalizedKeyObserver(
      `${operation.extensionId}:${operation.key}`,
      operation.observer,
      operation.signal,
    );
  }
}

/** Owns the generation-scoped TUI adapters for the currently loaded extension host. */
export class InteractiveExtensionUiBinder {
  readonly #terminal: TuiController;
  readonly #themeHotReloader: ThemeHotReloader;
  #host: LoadedRuntime["runtimeExtensions"] | undefined;

  constructor(terminal: TuiController) {
    this.#terminal = terminal;
    this.#themeHotReloader = new ThemeHotReloader({
      apply: (definition) => terminal.updateCustomTheme(definition),
    });
  }

  context(runtime: LoadedRuntime): ReturnType<typeof createInteractiveDirectUiContext> {
    const themes = runtime.extensions.bundle().themes;
    return createInteractiveDirectUiContext(
      this.#terminal,
      "runtime",
      runtime.workspace,
      runtime.runtimeExtensions.lifecycleSignal(),
      {
        settings: runtime.settings,
        themePath: (name) => themes.find((theme) => theme.name === name)?.sourcePath,
      },
    );
  }

  bind(runtime: LoadedRuntime, force = false): boolean {
    const terminal = this.#terminal;
    const host = runtime.runtimeExtensions;
    if (!force && this.#host === host && !host.lifecycleSignal().aborted) return false;
    this.#host = host;
    const signal = host.lifecycleSignal();
    terminal.clearExtensionUi();
    terminal.setOperatorPreferences({
      hideThinkingBlock: runtime.settings.getHideThinkingBlock(),
      showCacheMissNotices: runtime.settings.getShowCacheMissNotices(),
      externalEditor: runtime.settings.getExternalEditorCommand(),
      treeFilterMode: runtime.settings.getTreeFilterMode(),
      editorPaddingX: runtime.settings.getEditorPaddingX(),
      outputPad: runtime.settings.getOutputPad(),
      autocompleteMaxVisible: runtime.settings.getAutocompleteMaxVisible(),
      showHardwareCursor: runtime.settings.getShowHardwareCursor(),
      showImages: runtime.settings.getShowImages(),
      imageWidthCells: runtime.settings.getImageWidthCells(),
      clearOnShrink: runtime.settings.getClearOnShrink(),
      codeBlockIndent: runtime.settings.getCodeBlockIndent(),
    });
    terminal.setDoubleEscapeAction(runtime.settings.getDoubleEscapeAction());
    const bindToolRenderers = (): void => terminal.setToolRenderers(host.toolRendererBinding(), signal);
    const bindSessionRenderers = (): void => terminal.setSessionRenderers({
      renderEntry: (entry, options, theme) => host.entryRenderer(entry.customType)?.(entry, options, theme),
      renderMessage: (message, options, theme) => host.messageRenderer(message.customType)?.(message, options, theme),
    }, signal);
    const bindInputs = (): void => {
      const resolved = resolveRuntimeShortcuts(host.shortcuts(), terminal);
      for (const diagnostic of resolved.diagnostics) terminal.notify(diagnostic, "warning");
      terminal.setExtensionShortcuts(resolved.shortcuts.map((shortcut) => ({
        shortcut: shortcut.shortcut,
        ...(shortcut.description === undefined ? {} : { description: shortcut.description }),
      })), signal);
      terminal.setCommandCompletionProvider(
        async (name, prefix, completionSignal) => await host.completeCommandArguments(name, prefix, completionSignal),
        signal,
      );
    };
    const bindCommands = (): void => {
      const bundle = runtime.extensions.bundle();
      terminal.setCommandItems([
        ...bundle.commands.map((entry): PickerItem<string> => ({
          id: `extension-command:${entry.extensionId}:${entry.name}`,
          label: `/${entry.name}`,
          value: `/${entry.name}`,
          ...(entry.description === undefined ? {} : { detail: entry.description }),
          keywords: [entry.extensionId, entry.argumentHint ?? ""],
        })),
        ...bundle.prompts.map((entry): PickerItem<string> => ({
          id: `extension-prompt:${entry.extensionId}:${entry.id}`,
          label: `/${entry.id}`,
          value: `/${entry.id}`,
          ...(entry.description === undefined ? {} : { detail: entry.description }),
          keywords: [entry.extensionId, entry.argumentHint ?? "", "prompt template"],
        })),
        ...host.commands().map((entry): PickerItem<string> => ({
          id: `runtime-command:${entry.extensionId}:${entry.name}`,
          label: `/${entry.name}`,
          value: `/${entry.name}`,
          ...(entry.description === undefined ? {} : { detail: entry.description }),
          keywords: [entry.extensionId, entry.argumentHint ?? "", entry.sourcePath],
        })),
      ]);
    };
    bindToolRenderers();
    bindSessionRenderers();
    bindInputs();
    bindCommands();
    host.onChange((change) => {
      if (change === "tool_renderer") bindToolRenderers();
      else if (change === "session_renderer") bindSessionRenderers();
      else if (["command", "shortcut"].includes(change)) {
        bindCommands();
        bindInputs();
      }
    });
    const themes = runtime.extensions.bundle().themes;
    terminal.setCustomThemes(themes.map((theme) => theme.definition));
    const theme = runtime.settings.getThemeSetting();
    if (theme !== undefined) {
      try { terminal.setTheme(theme); }
      catch { terminal.notify(`Configured theme ${theme} is unavailable`, "warning"); }
    }
    const watchActiveTheme = (): void => {
      this.#themeHotReloader.select(themes.find((entry) =>
        entry.extensionId === "theme" && entry.name === terminal.selectedThemeName()));
    };
    watchActiveTheme();
    terminal.onThemeChange((change) => {
      watchActiveTheme();
      void host.dispatch("theme_change", {
        previous: change.previous,
        current: change.current,
        available: [...change.available],
        reason: change.reason,
      }).catch(() => undefined);
    }, signal);
    for (const operation of host.initialUi()) applyRuntimeUi(terminal, operation);
    host.setUiHandler((operation) => applyRuntimeUi(terminal, operation));
    host.setAdvancedUiHandler({
      apply: (operation) => applyRuntimeAdvancedUi(terminal, operation),
      getToolOutputExpanded: () => terminal.getToolOutputExpanded(),
    });
    host.setNativeUiHandler((extensionId, extensionSignal) => createNativeUiHost(terminal, extensionId, extensionSignal));
    host.setUnsafeTerminalHandler((extensionId, extensionSignal) => createUnsafeTerminalHost(terminal, extensionId, extensionSignal));
    host.setInteractiveUiHandler((extensionId, extensionSignal) => runtimeUi(terminal, extensionId, extensionSignal));
    const directUi = new Map<string, {
      signal: AbortSignal;
      context: ReturnType<typeof createInteractiveDirectUiContext>;
    }>();
    host.setDirectUiHandler((extensionId, extensionSignal) => {
      const existing = directUi.get(extensionId);
      if (existing?.signal === extensionSignal) return existing.context;
      const created = createInteractiveDirectUiContext(
        terminal,
        extensionId,
        runtime.workspace,
        extensionSignal,
        {
          settings: runtime.settings,
          themePath: (name) => themes.find((theme) => theme.name === name)?.sourcePath,
        },
      );
      directUi.set(extensionId, { signal: extensionSignal, context: created });
      const release = (): void => {
        if (directUi.get(extensionId)?.context === created) directUi.delete(extensionId);
      };
      extensionSignal.addEventListener("abort", release, { once: true });
      if (extensionSignal.aborted) release();
      return created;
    });
    signal.addEventListener("abort", () => directUi.clear(), { once: true });
    return true;
  }

  close(): void {
    this.#themeHotReloader.close();
  }
}

function runtimeOptions(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Parameters<typeof loadRuntime>[0] {
  const apiKey = argumentsValue.apiKey;
  const provider = argumentsValue.provider ?? "openai";
  return {
    ...(apiKey === undefined ? {} : { apiKey, apiKeyProvider: provider }),
    ...(argumentsValue.sessionDir === undefined ? {} : { sessionDirectory: argumentsValue.sessionDir }),
    ...(argumentsValue.workspace === undefined ? {} : { workspace: resolve(argumentsValue.workspace) }),
    ...(projectTrustResolver === undefined
      ? argumentsValue.projectTrustOverride === undefined ? {} : { projectTrusted: argumentsValue.projectTrustOverride }
      : { projectTrustResolver }),
    extensions: argumentsValue.noExtensions !== true,
    extensionPaths: argumentsValue.extensions ?? [],
    extensionFactories,
    skills: argumentsValue.noSkills !== true,
    skillPaths: argumentsValue.skills ?? [],
    promptTemplates: argumentsValue.noPromptTemplates !== true,
    promptTemplatePaths: argumentsValue.promptTemplates ?? [],
    themes: argumentsValue.noThemes !== true,
    themePaths: argumentsValue.themes ?? [],
    ...(argumentsValue.systemPrompt === undefined ? {} : { systemPrompt: argumentsValue.systemPrompt }),
    ...(argumentsValue.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: argumentsValue.appendSystemPrompt }),
    extensionRuntime: true,
    offline: argumentsValue.offline === true || /^(?:1|true|yes)$/iu.test(process.env.RIGYN_OFFLINE ?? ""),
  };
}

async function confirmForkFromWorkspace(workspace: string): Promise<boolean> {
  return await new Promise<boolean>((resolveAnswer) => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.question(`Session found in different workspace: ${workspace}\nFork it into the current workspace? [y/N] `, (answer) => {
      input.close();
      resolveAnswer(/^(?:y|yes)$/iu.test(answer.trim()));
    });
  });
}

async function sessionRuntimeOptions(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<Parameters<typeof loadRuntime>[0] | undefined> {
  const options = runtimeOptions(argumentsValue, extensionFactories, projectTrustResolver);
  const workspace = resolve(argumentsValue.workspace ?? process.cwd());
  const directory = argumentsValue.sessionDir;
  const selected = await createStartupSession(argumentsValue, workspace, directory, {
    async selectSession(current, all) { return await selectStartupSession(current, all); },
    confirmForkFromWorkspace,
  });
  if (selected.cancelled || selected.sessionManager === undefined) return undefined;
  if (argumentsValue.name !== undefined) {
    const name = argumentsValue.name.trim();
    if (name === "") throw new Error("--name requires a non-empty value");
    selected.sessionManager.appendSessionInfo(name);
  }
  return {
    ...options,
    workspace: selected.sessionManager.getCwd(),
    sessionManager: selected.sessionManager,
  };
}

async function selectConfiguredModel(runtime: LoadedRuntime, argumentsValue: Args): Promise<void> {
  const reference = argumentsValue.model ?? runtime.session.model?.id ?? runtime.settings.getDefaultModel();
  const provider = argumentsValue.provider ?? runtime.session.model?.provider ?? runtime.settings.getDefaultProvider();
  const reasoningEffort = argumentsValue.thinking ?? runtime.session.thinkingLevel ?? runtime.settings.getDefaultThinkingLevel();
  if (reference !== undefined) {
    const selected = await resolveRequestedModel(runtime.providers, {
      reference,
      ...(argumentsValue.provider === undefined && argumentsValue.model !== undefined
        ? {}
        : provider === undefined ? {} : { provider }),
      ...(provider === undefined ? {} : { fallbackProvider: provider }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      allowUnknownModel: false,
    }, AbortSignal.timeout(30_000));
    await runtime.session.setModel(await runtime.session.resolveModel(selected.model, {
      provider: selected.provider,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }));
  }
  if (argumentsValue.thinking !== undefined) runtime.session.setThinkingLevel(normalizeModelReasoningEffort(argumentsValue.thinking));
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 16 * 1024 * 1024) throw new Error("stdin exceeds 16 MiB"); chunks.push(value); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : text;
}

function applyExtensionArguments(argumentsValue: Args, runtime: LoadedRuntime): void {
  applyRuntimeExtensionFlags(argumentsValue, runtime.runtimeExtensions);
  const errors = argumentsValue.diagnostics.filter((entry) => entry.type === "error");
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.message).join("\n"));
  if (argumentsValue.redact === true && argumentsValue.export === undefined) {
    throw new Error("--redact requires --export");
  }
}

async function runCommand(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await runCommandOperation(argumentsValue, termination, extensionFactories, projectTrustResolver);
  });
}

async function runCommandOperation(
  argumentsValue: Args,
  termination: GracefulTerminationContext,
  extensionFactories: readonly InlineExtension[],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<void> {
  termination.throwIfTerminated();
  const options = await sessionRuntimeOptions(argumentsValue, extensionFactories, projectTrustResolver);
  if (options === undefined) return;
  const runtime = await loadRuntime(options);
  const uninstallTermination = termination.onTerminate((signal) => {
    void runtime.session.abort(`interrupted by ${signal}`);
  });
  try {
    termination.throwIfTerminated();
    applyExtensionArguments(argumentsValue, runtime);
    await runtime.session.bindExtensions({ mode: argumentsValue.mode === "json" ? "json" : "print" });
    await selectConfiguredModel(runtime, argumentsValue);
    if (runtime.session.model === undefined) throw new Error("No model selected. Pass --model or run Rigyn interactively and use /model.");
    const messages = [...argumentsValue.messages];
    const first = messages.shift();
    const stdin = await readPipedStdin();
    const input = [stdin, ...argumentsValue.fileArgs.map((path) => `@${path}`), first]
      .filter((value): value is string => value !== undefined && value !== "")
      .join("\n");
    if (input === "" && messages.length === 0) throw new Error("A prompt is required");
    const json = argumentsValue.mode === "json";
    if (json) writeMachineOutput(`${JSON.stringify(runtime.sessionManager.getHeader())}\n`);
    const unsubscribe = runtime.session.onEvent((envelope) => {
      if (json) writeMachineOutput(`${JSON.stringify(envelope.event)}\n`);
    });
    try {
      const tools = selectedTools(argumentsValue, runtime.runtimeExtensions.tools().map((tool) => tool.definition.name));
      const promptOptions = {
        ...(tools.allowedTools === undefined ? {} : { allowedTools: tools.allowedTools }),
        ...(tools.excludedTools === undefined ? {} : { excludedTools: tools.excludedTools }),
        noContextFiles: argumentsValue.noContextFiles === true,
        ...(argumentsValue.maxSteps === undefined ? {} : { maxSteps: argumentsValue.maxSteps }),
        ...(argumentsValue.maxOutputTokens === undefined ? {} : { maxOutputTokens: argumentsValue.maxOutputTokens }),
      };
      if (input !== "") {
        const expanded = await expandPromptReferences(input, runtime.workspace, undefined, runtime.settings.getImageAutoResize());
        await runtime.session.prompt(expanded.text, { ...promptOptions, images: expanded.images });
      }
      for (const message of messages) await runtime.session.prompt(message, promptOptions);
      if (!json) {
        const last = [...runtime.session.messages].reverse().find((message) => message.role === "assistant");
        if (last !== undefined && last.role === "assistant") {
          if (last.stopReason === "error" || last.stopReason === "cancelled") {
            throw new Error(last.errorMessage ?? `Request ${last.stopReason}`);
          }
          const text = last.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
          if (text !== "") writeMachineOutput(`${text}\n`);
        }
      }
    } finally { unsubscribe(); }
  } finally {
    uninstallTermination();
    try {
      await runtime.runtimeExtensions.dispatch("session_shutdown", { reason: "quit" } as never).catch(() => undefined);
    } finally {
      await runtime.close();
    }
  }
}

function inputImageBlocks(images: readonly TuiInputImageAttachment[] | undefined): ImageBlock[] {
  return (images ?? []).map((image) => ({ ...image.block }));
}

function imageSourceBytes(image: ImageBlock): number {
  return Buffer.byteLength(image.data ?? image.url ?? "", "utf8");
}

interface InteractiveRuntimeServices extends AgentSessionRuntimeServices {
  runtime: LoadedRuntime;
  sessionStartEvent?: RuntimeSessionStartEvent;
}

async function createInteractiveRuntimeOwner(
  argumentsValue: Args,
  initial: LoadedRuntime,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<AgentSessionRuntime<InteractiveRuntimeServices>> {
  const create = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: RuntimeSessionStartEvent;
  }) => {
    const runtime = await loadRuntime({
      ...runtimeOptions(argumentsValue, extensionFactories, projectTrustResolver),
      workspace: cwd,
      sessionManager,
    });
    try {
      applyExtensionArguments(argumentsValue, runtime);
      await selectConfiguredModel(runtime, argumentsValue);
      return {
        session: runtime.session,
        services: {
          cwd,
          agentDir,
          runtime,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          async close() { await runtime.close(); },
        },
      };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  };

  let owner!: AgentSessionRuntime<InteractiveRuntimeServices>;
  owner = new AgentSessionRuntime({
    session: initial.session,
    services: {
      cwd: initial.workspace,
      agentDir: initial.paths.agentDirectory,
      runtime: initial,
      async close() { await initial.close(); },
    },
  }, create, {
    async beforeSwitch(event) {
      return await owner.services.runtime.runtimeExtensions.reduceSessionBeforeSwitch({
        reason: event.reason,
        ...(event.targetSessionFile === undefined ? {} : { targetSessionFile: event.targetSessionFile }),
      } as never);
    },
    async beforeFork(event) {
      return await owner.services.runtime.runtimeExtensions.reduceSessionBeforeFork({
        entryId: event.entryId,
        position: event.position,
      } as never);
    },
    async shutdown(event) {
      await owner.services.runtime.runtimeExtensions.dispatch("session_shutdown", {
        reason: event.reason,
        ...(event.targetSessionFile === undefined ? {} : { targetSessionFile: event.targetSessionFile }),
      } as never);
    },
  });
  return owner;
}

async function chatCommand(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await chatCommandOperation(
      argumentsValue,
      termination,
      extensionFactories,
      projectTrustResolver,
    );
  });
}

async function chatCommandOperation(
  argumentsValue: Args,
  termination: GracefulTerminationContext,
  extensionFactories: readonly InlineExtension[],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<void> {
  termination.throwIfTerminated();
  const options = await sessionRuntimeOptions(argumentsValue, extensionFactories, projectTrustResolver);
  if (options === undefined) return;
  let runtime = await loadRuntime({ ...options, deferModelNetworkRefresh: true });
  projectTrustResolver?.setTerminal(undefined);
  applyExtensionArguments(argumentsValue, runtime);
  const owner = await createInteractiveRuntimeOwner(argumentsValue, runtime, extensionFactories, projectTrustResolver);
  let keybindings = await loadKeybindings(runtime.paths.keybindings);
  let unsubscribe = (): void => undefined;
  let exiting = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolveValue) => { resolveExit = resolveValue; });
  let actionHandler: (action: TuiAction) => void = () => undefined;
  const terminal = new TuiController({
    onAction: (action) => actionHandler(action),
    keybindings,
    doubleEscapeAction: runtime.settings.getDoubleEscapeAction(),
    operatorPreferences: tuiOperatorPreferences(runtime.settings),
  });
  projectTrustResolver?.setTerminal(terminal);
  const extensionUi = new InteractiveExtensionUiBinder(terminal);
  const deferredSubmissions = new BoundedDeferredSubmissionQueue<ImageBlock>(imageSourceBytes);
  const anthropicSubscriptionWarning = new AnthropicSubscriptionWarning();
  let promptActive = false;
  let authAbort: AbortController | undefined;
  const uninstallTermination = termination.onTerminate((signal) => {
    exiting = true;
    authAbort?.abort(new Error(`interrupted by ${signal}`));
    void runtime.session.abort(`interrupted by ${signal}`);
    terminal.close();
    resolveExit();
  });
  let steeringHandler: ((
    line: string,
    images?: readonly TuiInputImageAttachment[],
    recoveredImages?: readonly ImageBlock[],
    recoveredQueueDraft?: boolean,
  ) => void) | undefined;
  let drainDeferredSubmissions: () => Promise<void> = async () => undefined;
  const maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {
    await anthropicSubscriptionWarning.maybeNotify({
      enabled: runtime.settings.getWarnings().anthropicExtraUsage !== false,
      model: runtime.session.model,
      models: runtime.modelRegistry.models(),
      notify: (message) => terminal.notify(message, "warning"),
    });
  };

  const updateContext = (): void => {
    const sessionName = runtime.sessionManager.getSessionName();
    const model = runtime.session.model;
    const active = promptActive || !runtime.session.isIdle;
    terminal.setSteering(active ? steeringHandler : undefined);
    terminal.setQueuedMessages(runtime.session.getQueuedMessages());
    terminal.setContext({
    threadId: runtime.session.sessionId,
    ...(sessionName === undefined ? {} : { sessionName }),
    workspace: runtime.workspace,
    ...(model === undefined ? {} : { provider: model.provider, model: model.id }),
    thinking: runtime.session.thinkingLevel,
    active,
    status: active ? "streaming" : "idle",
    });
  };
  const bind = (): void => {
    extensionUi.bind(runtime);
    unsubscribe();
    unsubscribe = bindInteractiveSessionPresentation(runtime.session, terminal, {
      onEnvelope: updateContext,
      onSessionEvent: updateContext,
    });
    updateContext();
    void maybeWarnAboutAnthropicSubscriptionAuth();
  };
  const sessionOperations = new InteractiveSessionOperations({
    runtime: owner,
    terminal,
    refreshTranscript: bind,
    updateContext,
    resolveInputPath: (value) => expandPath(value, runtime.workspace),
  });
  owner.setBeforeSessionInvalidate(() => {
    unsubscribe();
    unsubscribe = (): void => undefined;
  });
  owner.setRebindSession(async (session) => {
    runtime = owner.services.runtime;
    extensionUi.bind(runtime, true);
    bind();
    await session.bindExtensions({ mode: "tui", uiContext: extensionUi.context(runtime) });
    await refreshInteractiveModels({ force: false, allowNetwork: false });
  });
  const reportError = (error: unknown): void => terminal.notify(defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error)), "error");
  const chooseModel = async (reference?: string): Promise<void> => {
    const knownProviders = [...new Set([
      ...runtime.providers.list().map((entry) => entry.id),
      ...runtime.modelRegistry.models().getProviders().map((entry) => entry.id),
    ])];
    const parsed = parseInteractiveModelReference(
      reference,
      argumentsValue.provider ?? runtime.session.model?.provider ?? runtime.settings.getDefaultProvider(),
      knownProviders,
    );
    let { provider, model } = parsed;
    if (provider === undefined) provider = await terminal.choose("Select provider", runtime.providers.list().map((entry) => ({ label: entry.id, value: entry.id })));
    model ??= await pickModel(runtime, provider, terminal);
    const selected = await runtime.session.resolveModel(model, { provider, reasoningEffort: runtime.session.thinkingLevel });
    await runtime.session.setModel(selected);
    await persistDefaultSelection(runtime.settings, { provider: selected.provider, model: selected.id });
    updateContext();
    terminal.notify(`Model ${selected.provider}/${selected.id}`);
    await maybeWarnAboutAnthropicSubscriptionAuth();
  };
  const preparePrompt = async (text: string, images: readonly ImageBlock[] = []): Promise<{ text: string; images: ImageBlock[] }> => {
    const expanded = await expandPromptReferences(text, runtime.workspace, undefined, runtime.settings.getImageAutoResize());
    return {
      text: expanded.text,
      images: combinePromptImages(false, images, undefined, expanded.images),
    };
  };
  const submitPrompt = async (text: string, images: readonly ImageBlock[] = []): Promise<void> => {
    promptActive = true;
    updateContext();
    try {
      const prepared = await preparePrompt(text, images);
      if (runtime.session.model === undefined) await chooseModel();
      const tools = selectedTools(argumentsValue, runtime.runtimeExtensions.tools().map((tool) => tool.definition.name));
      await runtime.session.prompt(prepared.text, {
        images: prepared.images,
        ...(tools.allowedTools === undefined ? {} : { allowedTools: tools.allowedTools }),
        ...(tools.excludedTools === undefined ? {} : { excludedTools: tools.excludedTools }),
        noContextFiles: argumentsValue.noContextFiles === true,
        ...(argumentsValue.maxSteps === undefined ? {} : { maxSteps: argumentsValue.maxSteps }),
        ...(argumentsValue.maxOutputTokens === undefined ? {} : { maxOutputTokens: argumentsValue.maxOutputTokens }),
      });
    } finally {
      promptActive = false;
      updateContext();
      await drainDeferredSubmissions();
    }
  };
  const refreshInteractiveModels = async (options: { force?: boolean; allowNetwork?: boolean } = {}) => {
    await runtime.modelRegistry.refresh({
      force: options.force ?? true,
      allowNetwork: options.allowNetwork ?? true,
      signal: runtime.generationSignal,
    });
    const available = runtime.modelRegistry.getAvailable()
      .filter((model) => model.provider !== "openai" || isAgentOpenAIModel(model.id));
    const items = available.map((model) => modelItem(providerModelToInfo(model)))
      .sort((left, right) => left.label.localeCompare(right.label));
    const patterns = runtime.settings.getEnabledModels() ?? [];
    const scoped = resolveModelsForScope(
      available.map((model) => ({ provider: model.provider, model: model.id })),
      patterns,
    ).models;
    const selectedKeys = new Set(scoped.map((model) => `${model.provider}\0${model.model}`));
    const scopedItems = items.filter((item) => selectedKeys.has(`${item.value.provider}\0${item.value.model}`));
    const current = runtime.session.model;
    const active = current === undefined
      ? undefined
      : items.find((item) => item.value.provider === current.provider && item.value.model === current.id);
    const ordered = active === undefined ? items : [active, ...items.filter((item) => item !== active)];
    terminal.setModelPickerItems(ordered, patterns.length === 0 ? undefined : scopedItems);
    terminal.setModelCycleItems(patterns.length === 0 ? items : scopedItems);
    const error = runtime.modelRegistry.getError();
    terminal.setModelPickerEmptyMessage(error === undefined ? undefined : `Model catalogs are unavailable: ${error}`);
    return { available, items };
  };
  const showSettings = async (): Promise<void> => {
    await terminal.chooseSettings(
      interactiveSettingItems(runtime.settings, runtime.session, terminal.themeNames()),
      async (item, value) => {
        applyInteractiveSetting(item, value, runtime.settings, runtime.session, terminal);
        await runtime.settings.flush();
        updateContext();
      },
    );
    await maybeWarnAboutAnthropicSubscriptionAuth();
  };
  const showScopedModels = async (): Promise<void> => {
    const { available, items } = await refreshInteractiveModels();
    if (items.length === 0) {
      terminal.notify(runtime.modelRegistry.getError() ?? "No authenticated models are currently available", "warning");
      return;
    }
    const configured = runtime.settings.getEnabledModels();
    const sessionScope = runtime.session.scopedModels;
    const selected = sessionScope.length > 0
      ? sessionScope.map((entry) => `${entry.model.provider}/${entry.model.id}`)
      : resolveModelsForScope(
          available.map((model) => ({ provider: model.provider, model: model.id })),
          configured ?? [],
        ).models.map((model) => `${model.provider}/${model.model}`);
    const selection = await terminal.chooseScopedModels(items, {
      all: configured === undefined || configured.length === 0,
      selected,
    });
    const patterns = selection.mode === "all"
      ? undefined
      : selection.mode === "none" ? [SCOPED_MODELS_NONE] : selection.patterns;
    runtime.settings.setEnabledModels(patterns);
    const selectedModels = selection.mode === "all"
      ? available.map((model) => ({ model }))
      : selection.mode === "none"
        ? []
        : resolveModelsForScope(
            available.map((model) => ({ provider: model.provider, model: model.id })),
            selection.patterns,
          ).models.flatMap((entry) => {
            const model = available.find((candidate) => candidate.provider === entry.provider && candidate.id === entry.model);
            return model === undefined ? [] : [{ model, ...(entry.reasoningEffort === undefined ? {} : { thinkingLevel: entry.reasoningEffort }) }];
          });
    runtime.session.setScopedModels(selectedModels);
    terminal.setModelCycleItems(selection.mode === "all"
      ? items
      : items.filter((item) => selectedModels.some((entry) => entry.model.provider === item.value.provider && entry.model.id === item.value.model)));
    await runtime.settings.flush();
    terminal.notify("Saved model cycling selection");
  };
  const showChangelog = async (): Promise<void> => {
    const content = await readPackageChangelog();
    terminal.notify(byteTruncate(content.trim() || "No changelog entries found", 256 * 1024));
  };
  const logout = async (argument: string): Promise<void> => {
    const requested = argument.trim();
    const stored = (await runtime.auth.states()).filter((state) => state.stored.present);
    const provider = requested || await (async () => {
      if (stored.length === 0) throw new Error("No stored credentials are available to remove");
      return await terminal.choose("Remove provider authentication", stored.map((state) => ({
        label: state.displayName,
        detail: [state.provider, state.activeProfile].filter(Boolean).join(" · "),
        value: state.provider,
      })));
    })();
    if (runtime.auth.has(provider)) {
      const result = await runtime.auth.logout(provider);
      terminal.notify(result.removedStored
        ? `Signed out for ${provider}${result.profile === undefined ? "" : ` profile ${result.profile}`}`
        : `No stored credential was present for ${provider}`);
    } else {
      if (runtime.modelRegistry.getProvider(provider) === undefined) throw new Error(`Unknown provider: ${provider}`);
      await runtime.modelRegistry.models().logout(provider);
      terminal.notify(`Signed out for ${provider}`);
    }
    await refreshInteractiveModels();
  };
  const manageLocalModels = async (): Promise<void> => {
    const configured = process.env.LLAMA_BASE_URL?.trim();
    const client = new LlamaRouterClient({
      ...(configured === undefined || configured === "" ? {} : { baseUrl: configured }),
      fetch: runtime.network.fetch,
    });
    await manageLlamaRouter({
      terminal,
      client,
      onStatus: (message) => terminal.setTransientStatus(message),
    });
    await refreshInteractiveModels();
  };
  const dispatchUnknownCommand = async (input: string, images: readonly ImageBlock[]): Promise<boolean> => {
    const separator = input.indexOf(" ");
    const name = input.slice(1, separator < 0 ? undefined : separator);
    const commandArgs = separator < 0 ? "" : input.slice(separator + 1);
    const runtimeCommand = runtime.runtimeExtensions.commands().find((entry) => entry.name === name);
    if (runtimeCommand !== undefined) {
      const result = await runtime.runtimeExtensions.runCommand(name, { args: commandArgs, threadId: runtime.session.sessionId, signal: new AbortController().signal });
      if (result.handled && result.prompt !== undefined) await submitPrompt(result.prompt, images);
      return result.handled;
    }
    const staticCommand = runtime.extensions.command(name);
    if (staticCommand !== undefined) { await submitPrompt(renderExtensionCommand(staticCommand, commandArgs), images); return true; }
    const prompt = runtime.extensions.prompt(name);
    if (prompt !== undefined) { await submitPrompt(renderExtensionPrompt(prompt, commandArgs), images); return true; }
    return false;
  };
  const runShellSubmission = async (command: string, hidden: boolean): Promise<void> => {
      const result = await runInteractiveShell({
        command,
        hidden,
        workspace: runtime.workspace,
        host: runtime.runtimeExtensions,
        session: runtime.session,
        settings: runtime.settings,
      });
      terminal.notify(result.output);
  };
  let activeSubmissionOrder = 0;
  let activeSubmissionWork = Promise.resolve();
  let idleSubmissionWork = Promise.resolve();
  let processActiveSubmission: (
    text: string,
    images: readonly ImageBlock[],
    order: number,
  ) => Promise<void> = async () => undefined;
  const coordinator = new InteractiveCommandCoordinator<ImageBlock>({
    commands: {
      quit() { exiting = true; authAbort?.abort(new Error("Terminal closed")); resolveExit(); },
      async cancel() {
        if (authAbort !== undefined) authAbort.abort(new Error("authorization cancelled from terminal"));
        else await runtime.session.abort("Cancelled by user");
      },
      async login({ args }) {
        const controller = new AbortController();
        authAbort = controller;
        try {
          const provider = await loginInteractively(runtime, terminal, args || undefined, controller.signal, argumentsValue.noBrowser === true);
          const { available } = await refreshInteractiveModels();
          const selected = selectDefaultModelAfterLogin(provider, available, undefined, runtime.session.model === undefined ? undefined : {
            provider: runtime.session.model.provider,
            model: runtime.session.model.id,
          });
          if (selected !== undefined) await chooseModel(`${selected.provider}/${selected.model}`);
          const source = runtime.auth.has(provider) ? (await runtime.auth.state(provider)).source : "stored";
          terminal.notify(`Connected ${provider}${source === undefined ? "" : ` via ${source}`}. Use /model or Ctrl+L to choose a model.`);
          await maybeWarnAboutAnthropicSubscriptionAuth();
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          if (authAbort === controller) authAbort = undefined;
        }
      },
      async model({ args }) { await chooseModel(args || undefined); },
      thinking({ args }) {
        if (args === "") terminal.notify(`Thinking: ${runtime.session.thinkingLevel}`);
        else runtime.session.setThinkingLevel(normalizeModelReasoningEffort(args));
        updateContext();
      },
      async new() { await sessionOperations.newSession(); },
      async resume({ args }) { await sessionOperations.resume(args); },
      async reload() {
        terminal.setInputBlocked(`Reloading ${RELOAD_RESOURCE_SUMMARY}...`, "reload");
        try {
          const reloadedKeybindings = await loadKeybindings(runtime.paths.keybindings);
          const result = await runtime.reload({
            onCommit() {
              keybindings = reloadedKeybindings;
              terminal.setKeybindings(keybindings);
              extensionUi.bind(runtime, true);
            },
          });
          await owner.adoptSession(runtime.session, { rebind: false });
          bind();
          await refreshInteractiveModels({ force: false, allowNetwork: false });
          terminal.notify(result.warnings.length === 0 ? `Reloaded ${RELOAD_RESOURCE_SUMMARY}` : result.warnings.join("\n"), result.warnings.length === 0 ? "status" : "warning");
          await maybeWarnAboutAnthropicSubscriptionAuth();
        } finally {
          terminal.setInputBlocked();
        }
      },
      async name({ args }) { await sessionOperations.name(args); },
      async session() { await sessionOperations.showSession(); },
      async tree() { await sessionOperations.navigateTree(); },
      async fork() { await sessionOperations.forkSession(); },
      async clone() { await sessionOperations.cloneSession(); },
      async export({ args }) { await sessionOperations.exportSession(args, false); },
      async share({ args }) { await sessionOperations.exportSession(args, true); },
      context() { sessionOperations.showContext(); },
      resources() {
        const bundle = runtime.extensions.bundle();
        terminal.notify(`Extensions: ${runtime.extensions.list().length} · Commands: ${bundle.commands.length} · Prompts: ${bundle.prompts.length} · Themes: ${bundle.themes.length}`);
      },
      copy() { sessionOperations.copyLatestAssistant(); },
      hotkeys() { terminal.notify(formatHotkeys(keybindings)); },
      async compact({ args }) { await sessionOperations.compact(args); },
      help() { terminal.notify(renderCliHelp()); },
      async settings() { await showSettings(); },
      async llama() { await manageLocalModels(); },
      async "scoped-models"() { await showScopedModels(); },
      async changelog() { await showChangelog(); },
      async import({ args }) { await sessionOperations.importSession(args); },
      async trust() { await sessionOperations.saveProjectTrust(); },
      async logout({ args }) { await logout(args); },
    },
    unknownCommand: async ({ input, images }) => await dispatchUnknownCommand(input, images),
    submissions: {
      prompt: async (text, images) => await submitPrompt(text, images),
      shell: async ({ command, hidden }) => await runShellSubmission(command, hidden),
    },
    actions: {
      async exit() { exiting = true; authAbort?.abort(new Error("Terminal closed")); await runtime.session.abort("Terminal closed"); resolveExit(); },
      error(action) { reportError(action.error); },
      async cancel() {
        if (authAbort !== undefined) authAbort.abort(new Error("authorization cancelled from terminal"));
        else await runtime.session.abort("Cancelled by user");
      },
      async submit(action) {
        const operation = idleSubmissionWork.then(async () => await coordinator.dispatchSubmission(action.text, [
          ...inputImageBlocks(action.images),
          ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
        ]));
        idleSubmissionWork = operation.catch(() => undefined);
        await operation;
      },
      async activeSubmission(action) {
        const text = action.type === "follow_up" ? `/follow ${action.text}` : action.text;
        await processActiveSubmission(text, [
          ...inputImageBlocks(action.images),
          ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
        ], activeSubmissionOrder++);
      },
      dequeue() {
        const message = runtime.session.dequeueMessage();
        if (message === undefined) terminal.notify("No queued messages to restore");
        else terminal.restoreQueuedMessages([message]);
        updateContext();
      },
      queueRestoreDiscard() { updateContext(); },
      async sessionCatalog(action) { await sessionOperations.handleCatalogAction(action); },
      async sessionMutation(action) { await sessionOperations.handleMutation(action); },
      async selectSession(action) { await sessionOperations.switchSession(String(action.item.value)); },
      async selectModel(action) {
        const value = action.item.value as ModelSelection;
        await chooseModel(`${value.provider}/${value.model}`);
      },
      command(action) { terminal.setEditorText(String(action.item.value)); },
      copy() { sessionOperations.copyLatestAssistant(false); },
      copyText(action) { terminal.copyToClipboard(action.text); },
      cycleThinking() {
        const levels = thinkingLevelsForModel(runtime.session.model?.info);
        const index = Math.max(0, levels.indexOf(runtime.session.thinkingLevel as ThinkingLevel));
        runtime.session.setThinkingLevel(levels[(index + 1) % levels.length] ?? "off");
        updateContext();
      },
      async extensionShortcut(action) {
        await runtime.runtimeExtensions.runShortcut(action.shortcut, {
          threadId: runtime.session.sessionId,
          signal: action.generation,
          ui: runtimeUi(terminal, "shortcut", action.generation),
        });
      },
      other() {},
    },
  });
  const dispatchIdleSubmission = async (text: string, images: readonly ImageBlock[] = []): Promise<void> => {
    await coordinator.dispatchSubmission(text, images);
  };
  let drainingDeferred = false;
  drainDeferredSubmissions = async (): Promise<void> => {
    if (drainingDeferred || promptActive || !runtime.session.isIdle) return;
    drainingDeferred = true;
    try {
      while (!promptActive && runtime.session.isIdle) {
        const next = deferredSubmissions.shift();
        if (next === undefined) return;
        try {
          await dispatchIdleSubmission(next.text, next.images);
        } catch (error) {
          reportError(error);
        }
        if (exiting) return;
      }
    } finally {
      drainingDeferred = false;
    }
  };
  processActiveSubmission = async (
    text: string,
    images: readonly ImageBlock[],
    order: number,
  ): Promise<void> => {
    if (!promptActive && runtime.session.isIdle) {
      await dispatchIdleSubmission(text, images);
      return;
    }
    const classified = classifyActiveSubmission(text);
    if (classified.kind === "cancel") {
      await runtime.session.abort("Cancelled by user");
      updateContext();
      return;
    }
    if (classified.kind === "defer") {
      const result = deferredSubmissions.enqueue(classified.text, images, order);
      if (!result.accepted) throw new Error(result.reason === "items"
        ? "Too many commands are waiting for the current turn to finish"
        : "Commands waiting for the current turn exceed the input byte limit");
      terminal.notify("Command queued until the current turn finishes");
      return;
    }
    const prepared = await preparePrompt(classified.text, images);
    if (!promptActive && runtime.session.isIdle) {
      await dispatchIdleSubmission(classified.text, images);
      return;
    }
    if (classified.kind === "follow_up") runtime.session.followUp(prepared.text, prepared.images);
    else runtime.session.steer(prepared.text, prepared.images);
    updateContext();
  };
  steeringHandler = (line, images, recoveredImages) => {
    const blocks = [...inputImageBlocks(images), ...(recoveredImages ?? []).map((image) => ({ ...image }))];
    const order = activeSubmissionOrder++;
    activeSubmissionWork = activeSubmissionWork
      .then(async () => await processActiveSubmission(line, blocks, order))
      .catch(reportError);
  };
  actionHandler = (action) => { void coordinator.dispatchAction(action).catch(reportError); };
  const uninstallEmergencyRecovery = installInteractiveEmergencyRecovery({
    restoreTerminal: () => terminal.close(),
  });
  let resumeCommand: string | undefined;
  try {
    terminal.start();
    extensionUi.bind(runtime);
    await runtime.session.bindExtensions({ mode: "tui", uiContext: extensionUi.context(runtime) });
    await selectConfiguredModel(runtime, argumentsValue);
    terminal.setInterruptHandler(() => {
      if (authAbort !== undefined) {
        authAbort.abort(new Error("authorization cancelled from terminal"));
        return true;
      }
      if (runtime.session.isIdle) return false;
      void runtime.session.abort("Interrupted");
      return true;
    });
    terminal.setStartup(
      formatCompactStartupReport({ extensions: runtime.extensions.list().map((entry) => entry.id) }, runtime.workspace, keybindings),
      formatStartupReport({}, runtime.workspace, keybindings),
    );
    bind();
    await presentStartupChangelog(runtime.settings, (message) => terminal.notify(message));
    await maybeWarnAboutAnthropicSubscriptionAuth();
    void refreshInteractiveModels().catch(reportError);
    const initial = [...argumentsValue.fileArgs.map((path) => `@${path}`), ...argumentsValue.messages].join(" ").trim();
    if (initial !== "") void submitPrompt(initial).catch(reportError);
    await exited;
    resumeCommand = formatResumeCommand(runtime.sessionManager);
  } finally {
    uninstallEmergencyRecovery();
    uninstallTermination();
    unsubscribe();
    extensionUi.close();
    terminal.close();
    if (!exiting) void runtime.session.abort("Terminal closed");
    await owner.dispose();
  }
  if (resumeCommand !== undefined) process.stdout.write(`To resume this session: ${resumeCommand}\n`);
}

async function listModels(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<void> {
  const runtime = await loadRuntime({
    ...runtimeOptions(argumentsValue, extensionFactories, projectTrustResolver),
    ephemeral: true,
  });
  try {
    applyExtensionArguments(argumentsValue, runtime);
    const provider = argumentsValue.provider;
    const direct = argumentsValue.offline === true || /^(?:1|true|yes)$/iu.test(process.env.RIGYN_OFFLINE ?? "")
      ? runtime.modelRegistry.getAll()
      : runtime.modelRegistry.getAvailable();
    const models = direct
      .filter((model) => provider === undefined || model.provider === provider)
      .map(providerModelToInfo);
    const query = typeof argumentsValue.listModels === "string" ? argumentsValue.listModels : undefined;
    const selected = query === undefined ? models : models.filter((model) => `${model.provider}/${model.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    writeMachineOutput(argumentsValue.mode === "json" ? `${JSON.stringify(selected, null, 2)}\n` : `${selected.map((model) => `${model.provider}/${model.id}\t${model.compatibility?.protocolFamily?.value ?? "unknown-api"}`).join("\n")}\n`);
  } finally { await runtime.close(); }
}

async function configCommand(
  argumentsValue: ManagementArguments,
  projectTrustResolver?: ProjectTrustResolver,
  signal?: AbortSignal,
): Promise<void> {
  if (await runSettingsConfigCommand(argumentsValue, {
    ...(projectTrustResolver === undefined ? {} : { projectTrustResolver }),
    ...(signal === undefined ? {} : { signal }),
  })) return;
  const action = argumentsValue.positionals[0];
  if (action !== undefined) throw new Error("config accepts path or edit; run config without an action to select package resources");
  await runPackageConfigCommand(
    argumentsValue,
    projectTrustResolver === undefined ? {} : { projectTrustResolver },
  );
}

export interface MainOptions {
  /** Trusted in-process extensions activated for every runtime generation. */
  extensionFactories?: InlineExtension[];
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<void> {
  const extensionFactories = options.extensionFactories ?? [];
  const managementNames = new Set([
    "config", "diagnostics", "extensions", "packages", "sessions",
    "install", "remove", "uninstall", "update", "list",
    "self-install", "self-update", "self-uninstall",
  ]);
  const helpTopics = new Set([...managementNames, "run", "chat", "rpc"]);
  if (argv[0] === "help") {
    writeMachineOutput(renderCliHelp(argv[1]));
    return;
  }
  if (argv[0] !== undefined && helpTopics.has(argv[0]) && argv.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
    writeMachineOutput(renderCliHelp(argv[0]));
    return;
  }
  if (argv[0] !== undefined && managementNames.has(argv[0])) {
    const management = parseManagementArguments(argv);
    if (management.command === "diagnostics") { await runDiagnosticsCommand(management); return; }
    if (management.command === "sessions") { await runSessionsCommand(management); return; }
    if (["extensions", "install", "remove", "update", "list", "packages", "config"].includes(management.command)) {
      const approve = flagBoolean(management, "approve");
      const deny = flagBoolean(management, "no-approve");
      if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
      const projectTrustResolver = await createInvocationTrustResolver({
        workspace: flagString(management, "workspace") ?? process.cwd(),
        ...(approve || deny ? { override: approve } : {}),
        ...(process.stdin.isTTY && process.stdout.isTTY ? { terminal: new ScopedTrustPrompter() } : {}),
        extensions: !flagBoolean(management, "no-extensions"),
        extensionPaths: flagStrings(management, "extension"),
        extensionFactories,
      });
      try {
        if (management.command === "extensions") {
          await runExtensionsCommand(management, { extensionFactories, projectTrustResolver });
        } else if (["install", "remove", "update", "list"].includes(management.command)) {
          await withGracefulTermination(async (termination) => {
            termination.throwIfTerminated();
            await runPackageCommand(management, { projectTrustResolver });
            termination.throwIfTerminated();
          });
        } else if (management.command === "packages") {
          await withGracefulTermination(async (termination) => {
            termination.throwIfTerminated();
            await runProjectPackageCommand(management, { projectTrustResolver, signal: termination.signal });
            termination.throwIfTerminated();
          });
        } else {
          await withGracefulTermination(async (termination) => {
            termination.throwIfTerminated();
            await configCommand(management, projectTrustResolver, termination.signal);
            termination.throwIfTerminated();
          });
        }
      } finally {
        await projectTrustResolver.close();
      }
      return;
    }
    const action = management.command === "self-install" ? "install" : management.command === "self-update" ? "update" : "uninstall";
    await runProductInstallAction(action, { yes: flagBoolean(management, "yes") });
    return;
  }

  const argumentsValue = parseArgs(argv[0] === "chat" || argv[0] === "run" ? argv.slice(1) : argv);
  for (const diagnostic of argumentsValue.diagnostics.filter((entry) => entry.type === "warning")) {
    process.stderr.write(`Warning: ${diagnostic.message}\n`);
  }
  const errors = argumentsValue.diagnostics.filter((entry) => entry.type === "error");
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.message).join("\n"));
  if (argumentsValue.help) { writeMachineOutput(renderCliHelp()); return; }
  if (argumentsValue.version) { writeMachineOutput(`${RIGYN_VERSION}\n`); return; }
  if (argumentsValue.redact === true && argumentsValue.export === undefined) throw new Error("--redact requires --export");
  if (argumentsValue.export !== undefined) {
    const output = exportSessionFile(argumentsValue.export, argumentsValue.messages[0], { redact: argumentsValue.redact === true });
    writeMachineOutput(`Exported to: ${output}\n`);
    return;
  }
  const interactive = argumentsValue.listModels === undefined
    && argumentsValue.mode !== "rpc"
    && !argumentsValue.print
    && argumentsValue.mode !== "json"
    && process.stdin.isTTY
    && process.stdout.isTTY;
  const startupTrustPrompter = interactive ? new ScopedTrustPrompter() : undefined;
  const projectTrustResolver = await createInvocationTrustResolver({
    workspace: argumentsValue.workspace ?? process.cwd(),
    ...(argumentsValue.projectTrustOverride === undefined ? {} : { override: argumentsValue.projectTrustOverride }),
    ...(startupTrustPrompter === undefined ? {} : { terminal: startupTrustPrompter }),
    extensions: argumentsValue.noExtensions !== true,
    extensionPaths: argumentsValue.extensions ?? [],
    extensionFactories,
  });
  try {
    if (argumentsValue.listModels !== undefined) {
      await listModels(argumentsValue, extensionFactories, projectTrustResolver);
      return;
    }
    if (argumentsValue.mode === "rpc") {
      if (argumentsValue.fileArgs.length > 0) throw new Error("@file arguments are not supported in RPC mode");
      await runRpcServer(argumentsValue, { extensionFactories, projectTrustResolver });
      return;
    }
    if (interactive) {
      await chatCommand(argumentsValue, extensionFactories, projectTrustResolver);
    } else {
      await runCommand(argumentsValue, extensionFactories, projectTrustResolver);
    }
  } finally {
    await projectTrustResolver.close();
  }
}
