import { spawn } from "node:child_process";
import { commandShellArgv } from "../process/command-shell.js";
import { trackActiveProcessGroup } from "../process/active-groups.js";
import { terminateProcessTree } from "../process/process-tree.js";
import {
  withGracefulTermination,
  type GracefulTerminationContext,
} from "../process/graceful-termination.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import {
  authorizeAnthropic,
  authorizeGitHubCopilot,
  authorizeOAuthRegistration,
  authorizeOpenAICodex,
  assertCredentialProfileName,
  createOpenRouterLoopback,
  type ProviderAuthMethod,
  ProviderAuthRegistry,
  type ProviderAuthState,
} from "../auth/index.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  parseHarnessConfig,
  resolveConfig,
  TrustStore,
  type DefaultProjectTrust,
  type JsonObject,
} from "../config/index.js";
import type { ImageBlock, ModelInfo, OutboundImagePolicy, ProviderAdapter, ProviderId } from "../core/types.js";
import type { EventEnvelope, ToolProgress } from "../core/events.js";
import type { ExtensionMessageEvent, ExtensionStateEvent } from "../core/extension-entries.js";
import type { QueueMode } from "../core/agent.js";
import { createId } from "../core/ids.js";
import {
  MODEL_REASONING_EFFORTS,
  modelMatchesScope,
  modelReferenceFailureMessage,
  modelReasoningEfforts,
  normalizeModelReasoningEffort,
  orderModelsForScope,
  parseModelScope,
  resolveModelsForScope,
  SCOPED_MODELS_NONE,
  type ModelReasoningEffort,
  type ProviderRegistry,
} from "../providers/index.js";
import type { ThreadRecord } from "../storage/types.js";
import {
  EventRenderer,
  TerminalController,
  type TerminalPrompter,
} from "../interfaces/terminal.js";
import {
  Keybindings,
  byteTruncate,
  formatSessionAge,
  loadKeybindings,
  sanitizeTerminalText,
  scanWorkspaceFiles,
  TuiController,
  TuiSelectionCancelledError,
  type KeybindingAction,
  type PickerItem,
  type PickerKind,
  type ScopedModelOption,
  type ScopedModelSelection,
  type TuiAction,
  type TuiInputImageAttachment,
  type TuiSettingItem,
} from "../tui/index.js";
import { copyToNativeClipboard, imageCoordinateHint, preprocessImage, readClipboardImage, readClipboardText } from "../images/index.js";
import { discoverInstructions, loadSkill, resolveEffectiveContextBudget, type SkillMetadata } from "../context/index.js";
import { flagBoolean, flagString, flagStrings, parseArguments, type ParsedArguments } from "./args.js";
import { resolveRequestedModel } from "./model-resolution.js";
import { loadRuntime, type LoadedRuntime } from "./runtime.js";
import { expandPath, harnessPaths, type HarnessPaths } from "./paths.js";
import { runRpcServer } from "./rpc.js";
import { persistDefaultSelection, persistUiPreferences, persistUiTheme, updateGlobalConfig } from "./setup.js";
import { runProductInstallAction } from "./product-install.js";
import { exportThreadHtml, exportThreadMarkdown, importThreadJsonl } from "../service/session-transfer.js";
import { buildSessionTree, type SessionTreeRow } from "../service/index.js";
import type { RunInputQueueLease } from "../service/harness.js";
import {
  harnessSessionPage,
  normalizeHarnessSessionListRequest,
} from "../service/session-catalog.js";
import { readFileBounded, WorkspaceBoundary } from "../tools/paths.js";
import { CoalescedOutputProgress } from "../tools/progress.js";
import {
  renderExtensionCommand,
  renderExtensionPrompt,
  type RuntimeCommandUi,
  type RuntimeInitialUiOperation,
} from "../extensions/index.js";
import { runExtensionsCommand, runPackageCommand, runPackageConfigCommand, runProjectPackageCommand } from "./extensions-command.js";
import { combinePromptImages, expandPromptReferences } from "./prompt-input.js";
import { formatSessionReport } from "./session-report.js";
import { formatResourceCatalogReport } from "./resource-report.js";
import { withMachineOutputGuard, writeMachineOutput } from "../interfaces/output-guard.js";
import { systemPromptCliOptions, type SystemPromptCliOptions } from "./system-prompt.js";
import { applyRuntimeExtensionFlags } from "./extension-flags.js";
import { resolveRuntimeShortcuts } from "./extension-shortcuts.js";
import { renderCliHelp } from "./help.js";
import { runDiagnosticsCommand } from "./diagnostics-command.js";
import { runSessionsCommand } from "./sessions-command.js";
import { RIGYN_VERSION } from "../version.js";
import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
} from "./active-submission.js";
import { installInteractiveEmergencyRecovery } from "./interactive-emergency.js";
import {
  indexedSessionReference,
  prepareIndexedSessionRuntimeSwitch,
  resolveIndexedSessionReference,
  resolveSessionReference,
} from "./session-resolution.js";
import {
  MAX_INDEX_WORKSPACES,
  WorkspaceSessionIndex,
  type IndexedSessionRecord,
} from "./session-index.js";
import { ProjectTrustResolver, type ProjectTrustOverride } from "./project-trust.js";

const DEFAULT_TOOLS = ["read", "write", "edit", "bash"];
const STARTUP_INVENTORY_ITEMS = 8;
const STARTUP_INVENTORY_ITEM_BYTES = 160;
type CodexTransportSetting = "auto" | "sse" | "websocket" | "websocket-cached";

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function selectedCodexTransport(runtime: LoadedRuntime): CodexTransportSetting {
  const provider = runtime.config.providers["openai-codex"];
  return provider?.kind === "openai-codex" ? provider.transport ?? "auto" : "auto";
}

async function persistCodexTransport(runtime: LoadedRuntime, transport: CodexTransportSetting): Promise<void> {
  await updateGlobalConfig(runtime.paths.globalConfig, (existing) => {
    const providers = objectValue(existing.providers);
    const codex = objectValue(providers["openai-codex"]);
    return {
      ...existing,
      providers: {
        ...providers,
        "openai-codex": { ...codex, kind: "openai-codex", transport },
      },
    };
  });
}

async function persistProviderRetryAttempts(runtime: LoadedRuntime, maxAttempts: number): Promise<void> {
  await updateGlobalConfig(runtime.paths.globalConfig, (existing) => ({
    ...existing,
    providerRetry: { ...objectValue(existing.providerRetry), maxAttempts },
  }));
}

function currentWorkspaceCwd(workspace: string): string {
  const cwd = process.cwd();
  const path = relative(workspace, cwd);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    ? cwd
    : workspace;
}

export interface StartupInventory {
  contextInstructions: readonly string[];
  extensions: readonly string[];
  skills: readonly string[];
  promptsAndCommands: readonly string[];
  themes: readonly string[];
}

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  alt: "Alt",
  backspace: "Backspace",
  ctrl: "Ctrl",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Enter",
  escape: "Esc",
  home: "Home",
  left: "Left",
  pagedown: "PageDown",
  pageup: "PageUp",
  right: "Right",
  shift: "Shift",
  space: "Space",
  tab: "Tab",
  up: "Up",
});

export function displayKeybinding(value: string): string {
  return value.split("+").map((part) => KEY_NAMES[part] ?? (/^[a-z]$/u.test(part) ? part.toUpperCase() : part)).join("+");
}

function bindingHint(keybindings: Keybindings, action: KeybindingAction, maximum = 3): string {
  const keys = keybindings.keys(action);
  const shown = keys.slice(0, maximum).map(displayKeybinding).join(" / ");
  return keys.length <= maximum ? shown : `${shown} (+${keys.length - maximum} more)`;
}

function primaryBinding(keybindings: Keybindings, action: KeybindingAction): string {
  return displayKeybinding(keybindings.keys(action)[0] ?? "");
}

export function formatHotkeys(keybindings: Keybindings): string {
  return [
    `Model: ${bindingHint(keybindings, "app.model.select")} picker · ${bindingHint(keybindings, "app.model.cycleForward")} next · ${bindingHint(keybindings, "app.model.cycleBackward")} previous`,
    `Thinking: ${bindingHint(keybindings, "app.thinking.cycle")} level · ${bindingHint(keybindings, "app.thinking.toggle")} reasoning`,
    `Tools/editor: ${bindingHint(keybindings, "app.tools.expand")} tools · ${bindingHint(keybindings, "app.editor.external")} external editor`,
    `Messages: ${bindingHint(keybindings, "tui.input.newLine")} newline · ${bindingHint(keybindings, "app.message.followUp")} follow-up · ${bindingHint(keybindings, "app.message.dequeue")} restore queue`,
    `Sessions/transcript: ${bindingHint(keybindings, "app.session.resume")} session picker · ${bindingHint(keybindings, "tui.editor.pageUp")} / ${bindingHint(keybindings, "tui.editor.pageDown")} scroll`,
    `Control: ${bindingHint(keybindings, "app.interrupt")} cancel · ${bindingHint(keybindings, "app.clear")} clear/exit twice · ${bindingHint(keybindings, "app.exit")} exit · ${bindingHint(keybindings, "app.suspend")} suspend`,
    `Input: @ file picker · ${bindingHint(keybindings, "tui.input.tab")} path completion · ${bindingHint(keybindings, "app.clipboard.pasteImage")} clipboard image/text · !command includes output · !!command keeps output local`,
  ].join("\n");
}

function attachmentPrompt(text: string, attachments: readonly TuiInputImageAttachment[]): string {
  if (attachments.length === 0) return text;
  const notes = attachments.map((attachment, index) => {
    const coordinates = attachment.coordinates;
    const geometry = imageCoordinateHint(coordinates)
      ?? `Attached image geometry: ${coordinates.width}x${coordinates.height}.`;
    return `[Attached image ${index + 1} (${sanitizeTerminalText(attachment.label).replaceAll("\n", " ")}): ${geometry}]`;
  });
  return [text, ...notes].join("\n\n");
}

function attachmentBlocks(attachments: readonly TuiInputImageAttachment[]) {
  return attachments.map((attachment) => ({ ...attachment.block }));
}

function attachmentStorageBytes(attachment: TuiInputImageAttachment): number {
  return Buffer.byteLength(attachment.label, "utf8")
    + Buffer.byteLength(attachment.block.mediaType, "utf8")
    + Buffer.byteLength(attachment.block.data ?? attachment.block.url ?? "", "utf8")
    + 128;
}

async function pasteClipboardImage(terminal: TuiController, signal?: AbortSignal): Promise<void> {
  terminal.setInputBlocked("Reading clipboard…", "clipboard");
  try {
    const acquired = await readClipboardImage({ ...(signal === undefined ? {} : { signal }) });
    if (acquired.image === undefined) {
      const clipboardText = await readClipboardText({ ...(signal === undefined ? {} : { signal }) });
      if (clipboardText.text !== undefined) {
        terminal.insertClipboardText(clipboardText.text);
        terminal.notify(`Pasted text via ${clipboardText.backend ?? "native clipboard"}`);
        return;
      }
      const details = acquired.diagnostics.slice(-3).map((entry) => `${entry.backend}: ${entry.detail}`).join("; ");
      throw new Error(`No clipboard image or text is available${details === "" ? "" : ` (${details})`}`);
    }
    const processed = await preprocessImage(acquired.image.bytes, { ...(signal === undefined ? {} : { signal }) });
    const count = terminal.attachInputImage({
      block: { type: "image", mediaType: processed.mediaType, data: Buffer.from(processed.bytes).toString("base64") },
      label: "clipboard",
      coordinates: processed.coordinates,
    });
    terminal.notify(
      `Attached clipboard image ${processed.coordinates.width}x${processed.coordinates.height} via ${acquired.image.backend} (${count}/8)`,
    );
  } finally {
    terminal.setInputBlocked();
  }
}

function inventoryItems(values: readonly string[]): string[] {
  const items = [...new Set(values.map((value) => byteTruncate(
    sanitizeTerminalText(value).replace(/\s+/gu, " ").trim(),
    STARTUP_INVENTORY_ITEM_BYTES,
  )).filter((value) => value !== ""))].sort((left, right) => left.localeCompare(right));
  const selected = items.slice(0, STARTUP_INVENTORY_ITEMS);
  const remaining = items.length - selected.length;
  return remaining === 0 ? selected : [...selected, `+${remaining} more`];
}

function startupInventorySections(inventory: StartupInventory, expanded: boolean): string[] {
  const groups: Array<[string, readonly string[]]> = [
    ["Context", inventory.contextInstructions],
    ["Extensions", inventory.extensions],
    ["Skills", inventory.skills],
    ["Prompts", inventory.promptsAndCommands],
    ["Themes", inventory.themes],
  ];
  return groups.flatMap(([label, values]) => {
    const items = inventoryItems(values);
    if (items.length === 0) return [];
    return [expanded
      ? `[${label}]\n${items.map((item) => `  ${item}`).join("\n")}`
      : `[${label}]\n  ${items.join(", ")}`];
  });
}

function compactStartupInventory(inventory: StartupInventory): string | undefined {
  const groups: Array<[string, readonly string[]]> = [
    ["context", inventory.contextInstructions],
    ["extension", inventory.extensions],
    ["skill", inventory.skills],
    ["prompt", inventory.promptsAndCommands],
    ["theme", inventory.themes],
  ];
  const values = groups.flatMap(([label, items]) => {
    const count = inventoryItems(items).length;
    return count === 0 ? [] : [`${count} ${label}${count === 1 ? "" : "s"}`];
  });
  return values.length === 0 ? undefined : `Loaded: ${values.join(" · ")}`;
}

function displayContextInstruction(source: string, workspace: string): string {
  const path = relative(workspace, source);
  return path === ""
    ? "."
    : path !== ".." && !path.startsWith(`..${sep}`)
      ? `.${sep}${path}`
      : source;
}

function runtimeExtensionLabel(sourcePath: string): string {
  const filename = basename(sourcePath);
  return filename.startsWith("index.")
    ? basename(dirname(sourcePath))
    : basename(filename, extname(filename));
}

export function formatStartupReport(
  keybindings: Keybindings,
  _modelSelected: boolean,
  inventory: StartupInventory,
): string {
  return [
    `Rigyn v${RIGYN_VERSION} · Ready`,
    formatHotkeys(keybindings),
    "",
    "Commands: / opens the palette · /login connects a provider · /model selects an available model",
    "Sessions: /resume opens saved work · rigyn --continue starts with the latest project session",
    "Ask Rigyn how to use or extend it; bundled documentation is available to the agent.",
    ...startupInventorySections(inventory, true).flatMap((section) => ["", section]),
  ].join("\n");
}

export function formatCompactStartupReport(
  keybindings: Keybindings,
  modelSelected: boolean,
  inventory: StartupInventory,
): string {
  const suspend = primaryBinding(keybindings, "app.suspend");
  const loaded = compactStartupInventory(inventory);
  return [
    `Rigyn v${RIGYN_VERSION} · Ready`,
    `${primaryBinding(keybindings, "app.interrupt")} interrupt · ${primaryBinding(keybindings, "app.clear")} clear/exit twice · ${primaryBinding(keybindings, "app.exit")} exit${suspend === "" ? "" : ` · ${suspend} suspend`} · / commands · ! bash · ${primaryBinding(keybindings, "app.tools.expand")} help`,
    "",
    ...(loaded === undefined ? [] : [loaded]),
    modelSelected
      ? "Model ready · /model switches the available model"
      : "No model connected · Start: /login connects a provider · /model selects an available model",
    `Saved work: ${primaryBinding(keybindings, "app.session.resume")} or /resume · next launch: rigyn --continue`,
    "Ask Rigyn how to use or extend it.",
  ].join("\n");
}

function shellArgument(value: string): string {
  return value !== "" && !/[^A-Za-z0-9_./~:@-]/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatResumeCommand(threadId: string, sessionDirectory?: string): string {
  return [
    "rigyn",
    ...(sessionDirectory === undefined ? [] : ["--session-dir", shellArgument(sessionDirectory)]),
    "--session",
    shellArgument(threadId),
  ].join(" ");
}

export function parseInteractivePathArgument(value: string, command: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${command} requires a file path`);
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return trimmed;

  let result = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === quote) {
      if (trimmed.slice(index + 1).trim() !== "") {
        throw new Error(`${command} path has characters after its closing quote`);
      }
      if (result === "") throw new Error(`${command} requires a file path`);
      return result;
    }
    if (character === "\\" && quote === '"') {
      const next = trimmed[index + 1];
      if (next === '"' || next === "\\") {
        result += next;
        index += 1;
        continue;
      }
    }
    result += character;
  }
  throw new Error(`${command} path has an unterminated quote`);
}

export function defaultTools(): string[] {
  return [...DEFAULT_TOOLS];
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort?: ModelReasoningEffort;
}

export const THINKING_LEVELS = MODEL_REASONING_EFFORTS;
export type ThinkingLevel = ModelReasoningEffort;

function thinkingLevel(value: string | undefined): ThinkingLevel {
  return value === undefined ? "off" : normalizeModelReasoningEffort(value);
}

export function thinkingLevelsForModel(model: ModelInfo | undefined): readonly ThinkingLevel[] {
  if (model === undefined) return THINKING_LEVELS;
  if (model.compatibility?.reasoningEfforts === undefined && model.capabilities.reasoning.value === "unknown") return ["off"];
  return modelReasoningEfforts(model);
}

export function compatibleThinkingLevel(
  requested: ThinkingLevel,
  model: ModelInfo | undefined,
): ThinkingLevel {
  const supported = thinkingLevelsForModel(model);
  return supported.includes(requested) ? requested : supported[0] ?? "off";
}

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
  "kimi-coding": "kimi-for-coding",
  minimax: "MiniMax-M3",
  "minimax-cn": "MiniMax-M3",
});

export function selectDefaultModelAfterLogin(
  provider: ProviderId,
  models: readonly Pick<ModelInfo, "id" | "provider">[],
  configured?: ModelSelection,
  active?: ModelSelection,
): ModelSelection | undefined {
  if (active !== undefined) return undefined;
  const configuredModel = configured?.provider === provider ? configured.model : undefined;
  const preferred = configuredModel ?? DEFAULT_MODEL_PER_PROVIDER[provider];
  if (preferred === undefined || !models.some((model) => model.provider === provider && model.id === preferred)) return undefined;
  return { provider, model: preferred };
}

export function selectAutomaticModel(
  models: readonly Pick<ModelInfo, "id" | "provider">[],
  configured?: ModelSelection,
): ModelSelection | undefined {
  if (configured !== undefined && models.some(
    (model) => model.provider === configured.provider && model.id === configured.model,
  )) return configured;
  for (const [provider, id] of Object.entries(DEFAULT_MODEL_PER_PROVIDER)) {
    if (models.some((model) => model.provider === provider && model.id === id)) return { provider, model: id };
  }
  const first = models[0];
  return first === undefined ? undefined : { provider: first.provider, model: first.id };
}

export { modelMatchesScope, orderModelsForScope, parseModelScope, SCOPED_MODELS_NONE };

export function isAgentOpenAIModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (id === "") return false;
  if (/^(?:babbage|davinci)(?:-|$)/u.test(id) || /^text-(?:babbage|davinci)(?:-|$)/u.test(id)) return false;
  if (/^gpt-3\.5(?:-|$)/u.test(id) || /^gpt-4(?:$|-(?:\d|turbo))/u.test(id)) return false;
  if (id.startsWith("dall-e-") || id.startsWith("gpt-image-") || id.startsWith("chatgpt-image-")) return false;
  return !/(?:^|[-_.])(?:embedding|image|audio|realtime|transcribe|transcription|tts|whisper|moderation|search)(?:[-_.]|$)/u.test(id);
}

interface ModelAvailability {
  status: "connected" | "available" | "unverified" | "unavailable";
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

function modelPickerItem(
  provider: ProviderId,
  model: Pick<ModelInfo, "id" | "displayName" | "description" | "contextTokens">,
  availability?: ModelAvailability,
): PickerItem<ModelSelection> {
  const detail = [
    availability?.status === "unavailable" || availability?.status === "unverified" ? availability.status : undefined,
    model.displayName,
    model.description,
    model.contextTokens === undefined ? undefined : `${model.contextTokens.toLocaleString()} context`,
  ].filter(Boolean).join(" · ");
  return {
    id: JSON.stringify([provider, model.id]),
    label: `${provider} / ${model.id}`,
    value: { provider, model: model.id },
    keywords: [provider, model.id, model.displayName ?? "", model.description ?? ""],
    ...(detail === "" ? {} : { detail }),
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
      authState = auth === undefined ? undefined : await auth.state(provider.id);
      const definitivelyDisconnected = authState !== undefined && (
        authState.status === "unavailable" ||
        (authState.status === "available" && (authState.source === undefined || authState.error !== undefined))
      );
      if (definitivelyDisconnected) return {
        provider: provider.id,
        models: [],
        ...(authState === undefined ? {} : { authState }),
        status: "disconnected",
      };
      const catalogSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let models: ModelInfo[];
      if (catalog === undefined) {
        models = options.refresh === false ? [] : await provider.listModels(catalogSignal);
      } else {
        models = await catalog.listModels(provider.id, catalogSignal, {
          refresh: options.refresh !== false,
          verifiedOnly: true,
        });
        const state = (await catalog.catalogStatus?.(provider.id))?.[0];
        const verified = state?.provenance === "live" && state.error === undefined && !state.stale;
        if (!verified) {
          return {
            provider: provider.id,
            models: [],
            ...(authState === undefined ? {} : { authState }),
            status: classifyModelCatalogFailure(state?.error?.message),
          };
        }
      }
      return {
        provider: provider.id,
        models,
        ...(authState === undefined ? {} : { authState }),
        status: models.length === 0 ? "empty" : "available",
      };
    } catch (error) {
      return {
        provider: provider.id,
        models: [],
        ...(authState === undefined ? {} : { authState }),
        status: classifyModelCatalogFailure(error),
      };
    }
  };
  const pickerItems = (entry: CatalogResult): PickerItem<ModelSelection>[] => entry.status !== "available"
    ? []
    : entry.models.flatMap((model) => entry.provider === "openai" && !isAgentOpenAIModel(model.id)
      ? []
      : [modelPickerItem(entry.provider, model, {
          status: entry.authState?.status === "connected" ? "connected" : "available",
        })]);
  const scopedItems = (entries: readonly PickerItem<ModelSelection>[], models: readonly ModelInfo[]) => {
    const byKey = new Map(entries.map((item) => [`${item.value.provider}\u0000${item.value.model}`, item]));
    const metadata = new Map(models.map((model) => [`${model.provider}\u0000${model.id}`, model]));
    return resolveModelsForScope(
      entries.map((item) => item.value),
      patterns,
      (selection) => {
        const model = metadata.get(`${selection.provider}\u0000${selection.model}`);
        return model === undefined ? undefined : modelReasoningEfforts(model);
      },
    ).models.flatMap((selection) => {
      const item = byKey.get(`${selection.provider}\u0000${selection.model}`);
      return item === undefined
        ? []
        : [{
            ...item,
            value: selection,
            ...(selection.reasoningEffort === undefined
              ? {}
              : { detail: [item.detail, `thinking ${selection.reasoningEffort}`].filter(Boolean).join(" · ") }),
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
        if (terminal.addModelPickerItems !== undefined) {
          terminal.addModelPickerItems(available, patterns.length === 0 ? undefined : scoped);
        } else {
          terminal.addPickerItems("model", patterns.length === 0 ? available : scoped);
        }
      }
      return result;
    }));
    const discovered = catalogs.filter((entry) => entry.status === "available").flatMap((entry) => entry.models);
    if (signal.aborted) return discovered;
    const statuses: ProviderModelCatalogStatus[] = catalogs.map((entry) => ({
      provider: entry.provider,
      status: entry.status,
      ...(entry.authState === undefined ? {} : { authStatus: entry.authState.status }),
      ...(entry.authState?.source === undefined ? {} : { authSource: entry.authState.source }),
    }));
    onStatus?.(statuses);
    const unavailable = catalogs.filter((entry) =>
      entry.status !== "available" &&
      entry.status !== "disconnected" &&
      (entry.provider === current?.provider || (
        current === undefined && entry.authState?.status === "connected" && entry.authState.source !== "local"
      )));
    if (unavailable.length > 0) {
      const shown = unavailable.slice(0, 8).map((entry) => `${byteTruncate(sanitizeTerminalText(entry.provider), 128)} (${entry.status})`);
      terminal.notify?.(`Model catalogs: ${shown.join(", ")}${unavailable.length > shown.length ? `, +${unavailable.length - shown.length} more` : ""}`, "warning");
    }
    const allAvailable = catalogs.flatMap(pickerItems);
    const itemByModel = new Map(allAvailable.map((item) => [`${item.value.provider}\u0000${item.value.model}`, item]));
    const scoped = resolveModelsForScope(
      allAvailable.map((item) => item.value),
      patterns,
      (selection) => {
        const model = discovered.find((candidate) =>
          candidate.provider === selection.provider && candidate.id === selection.model);
        return model === undefined ? undefined : modelReasoningEfforts(model);
      },
    );
    if (scoped.omittedCount > 0) {
      const shown = scoped.diagnostics.slice(0, 4).map((diagnostic) =>
        `${diagnostic.provider}/${diagnostic.model}:${diagnostic.reasoningEffort} (supports ${diagnostic.supportedReasoningEfforts.join(", ") || "no harness thinking levels"})`);
      terminal.notify?.(
        `Model scope ignored ${scoped.omittedCount} unsupported thinking selection${scoped.omittedCount === 1 ? "" : "s"}: ${shown.join("; ")}${scoped.omittedCount > shown.length ? `; +${scoped.omittedCount - shown.length} more` : ""}`,
        "warning",
      );
    }
    const items = scopedItems(allAvailable, discovered);
    terminal.setModelCycleItems?.(items);
    const currentItem = current === undefined
      ? undefined
      : itemByModel.get(`${current.provider}\u0000${current.model}`);
    const allPickerItems = [
      ...(currentItem === undefined ? [] : [currentItem]),
      ...allAvailable
        .filter((item) => current === undefined || item.value.provider !== current.provider || item.value.model !== current.model)
        .sort((left, right) => left.value.provider.localeCompare(right.value.provider) || left.value.model.localeCompare(right.value.model)),
    ];
    const scopedPickerItems = [
      ...(currentItem === undefined || !items.some((item) => item.value.provider === current?.provider && item.value.model === current?.model)
        ? []
        : [items.find((item) => item.value.provider === current?.provider && item.value.model === current?.model) ?? currentItem]),
      ...items.filter((item) => current === undefined || item.value.provider !== current.provider || item.value.model !== current.model),
    ];
    if (terminal.setModelPickerItems !== undefined) {
      terminal.setModelPickerItems(allPickerItems, patterns.length === 0 ? undefined : scopedPickerItems);
    } else {
      terminal.setPickerItems("model", patterns.length === 0 ? allPickerItems : scopedPickerItems);
    }
    return discovered;
  } finally {
    terminal.setModelPickerLoading?.(false);
  }
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

interface ToolSelection {
  allowedTools?: string[];
  excludedTools?: string[];
  noBuiltinTools?: boolean;
}

function toolNames(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((entry) => entry.trim());
  if (values.length === 0 || values.some((entry) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(entry))) {
    throw new Error(`${flag} must be a comma-separated list of tool names`);
  }
  return [...new Set(values)];
}

export function selectedTools(
  argumentsValue: ParsedArguments,
  extensionToolNames: readonly string[] = [],
): ToolSelection {
  const noTools = flagBoolean(argumentsValue, "no-tools");
  const noBuiltins = flagBoolean(argumentsValue, "no-builtin-tools");
  const all = flagBoolean(argumentsValue, "all-tools");
  const configured = toolNames(flagString(argumentsValue, "tools"), "--tools");
  if ([noTools, noBuiltins, all, configured !== undefined].filter(Boolean).length > 1) {
    throw new Error("--tools, --all-tools, --no-tools, and --no-builtin-tools are mutually exclusive");
  }
  const excludedTools = toolNames(flagString(argumentsValue, "exclude-tools"), "--exclude-tools");
  if (noTools) return { allowedTools: [], ...(excludedTools === undefined ? {} : { excludedTools }) };
  if (noBuiltins) return { noBuiltinTools: true, ...(excludedTools === undefined ? {} : { excludedTools }) };
  if (all) return excludedTools === undefined ? {} : { excludedTools };
  return {
    allowedTools: configured ?? [...new Set([...DEFAULT_TOOLS, ...extensionToolNames])],
    ...(excludedTools === undefined ? {} : { excludedTools }),
  };
}

function outboundImageOverride(argumentsValue: ParsedArguments): OutboundImagePolicy | undefined {
  const value = flagString(argumentsValue, "outbound-images");
  if (value === undefined) return undefined;
  if (value !== "allow" && value !== "block") throw new Error("--outbound-images must be allow or block");
  return value;
}

function outboundImageOptions(argumentsValue: ParsedArguments): { outboundImages?: OutboundImagePolicy } {
  const outboundImages = outboundImageOverride(argumentsValue);
  return outboundImages === undefined ? {} : { outboundImages };
}

async function stdinText(maxBytes = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new Error(`stdin exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runShellShortcut(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
  environment: NodeJS.ProcessEnv = process.env,
  onProgress?: (progress: ToolProgress) => void,
  shellPath?: string,
): Promise<{ text: string; exitCode: number | null; signal?: NodeJS.Signals }> {
  if (command.trim() === "" || Buffer.byteLength(command) > 131_072) throw new Error("Shell shortcut command is empty or too large");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new RangeError("Shell shortcut timeout must be between 1 and 600000 ms");
  signal.throwIfAborted();
  const argv = await commandShellArgv(command, {
    environment,
    ...(shellPath === undefined ? {} : { configuredPath: shellPath }),
  });
  const childEnvironment = shellShortcutEnvironment(environment);
  const maximum = 512 * 1024;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const progress = onProgress === undefined ? undefined : new CoalescedOutputProgress(onProgress);
  let result: { exitCode: number | null; signal?: NodeJS.Signals };
  try {
    result = await new Promise<{ exitCode: number | null; signal?: NodeJS.Signals }>((resolveResult, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      const releaseProcessGroup = trackActiveProcessGroup(child.pid);
      const capture = (target: Buffer[], chunk: Buffer, kind: "stdout" | "stderr") => {
        const used = kind === "stdout" ? stdoutBytes : stderrBytes;
        const available = Math.max(0, maximum - used);
        if (available > 0) target.push(chunk.subarray(0, available));
        if (kind === "stdout") {
          stdoutBytes += Math.min(chunk.length, available);
          stdoutTruncated ||= chunk.length > available;
        } else {
          stderrBytes += Math.min(chunk.length, available);
          stderrTruncated ||= chunk.length > available;
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        capture(stdout, chunk, "stdout");
        progress?.push("stdout", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture(stderr, chunk, "stderr");
        progress?.push("stderr", chunk);
      });
      let killTimeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      let settled = false;
      const kill = (signalValue: NodeJS.Signals): void => {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
        terminateProcessTree(child.pid, signalValue);
      };
      const terminate = (): void => {
        kill("SIGTERM");
        killTimeout ??= setTimeout(() => kill("SIGKILL"), 1_000);
        killTimeout.unref();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref();
      const abort = () => terminate();
      const cleanup = () => {
        releaseProcessGroup();
        clearTimeout(timeout);
        if (killTimeout !== undefined) clearTimeout(killTimeout);
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.once("close", (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal.aborted) reject(signal.reason ?? new Error("Shell shortcut cancelled"));
        else if (timedOut) reject(new Error(`Shell shortcut timed out after ${timeoutMs} ms`));
        else resolveResult({ exitCode, ...(exitSignal === null ? {} : { signal: exitSignal }) });
      });
    });
  } finally {
    progress?.close();
  }
  const sections = [
    `$ ${defaultSecretRedactor.redact(command)}`,
    stdout.length === 0 ? undefined : defaultSecretRedactor.redact(Buffer.concat(stdout).toString("utf8").replace(/\s+$/u, "")),
    stderr.length === 0 ? undefined : `stderr:\n${defaultSecretRedactor.redact(Buffer.concat(stderr).toString("utf8").replace(/\s+$/u, ""))}`,
    stdoutTruncated || stderrTruncated ? "… output truncated" : undefined,
    result.signal === undefined ? `exit ${result.exitCode ?? "unknown"}` : `signal ${result.signal}`,
  ].filter((value): value is string => value !== undefined && value !== "");
  return { text: sections.join("\n"), ...result };
}

export function shellShortcutProgressStatus(command: string, progress?: ToolProgress): string {
  const shownCommand = byteTruncate(
    sanitizeTerminalText(defaultSecretRedactor.redact(command)).replace(/\s+/gu, " ").trim(),
    160,
  );
  if (progress === undefined || progress.type !== "output") return `Shell running · $ ${shownCommand}`;
  const preview = byteTruncate(
    sanitizeTerminalText(defaultSecretRedactor.redact(progress.delta)).replace(/\s+/gu, " ").trim(),
    384,
  );
  return byteTruncate([
    `Shell running · $ ${shownCommand}`,
    progress.elapsedMs === undefined ? undefined : `${formatElapsed(progress.elapsedMs)} elapsed`,
    `${progress.stream} · ${progress.stdoutBytes} B stdout · ${progress.stderrBytes} B stderr`,
    preview === "" ? undefined : preview,
  ].filter((value): value is string => value !== undefined).join(" · "), 768);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const CREDENTIAL_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/u;

export function shellShortcutEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENVIRONMENT_NAME.test(name) || CREDENTIAL_URL.test(value)) {
      defaultSecretRedactor.register(value);
      continue;
    }
    result[name] = value;
  }
  return result;
}

function projectTrustOverride(argumentsValue: ParsedArguments): ProjectTrustOverride | undefined {
  const approve = flagBoolean(argumentsValue, "approve");
  const deny = flagBoolean(argumentsValue, "no-approve");
  if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
  return approve ? "approve" : deny ? "deny" : undefined;
}

function projectTrustResolver(
  argumentsValue: ParsedArguments,
  paths: Pick<HarnessPaths, "globalConfig" | "trustStore">,
  terminal?: TerminalPrompter,
): ProjectTrustResolver {
  const override = projectTrustOverride(argumentsValue);
  const defaultProjectTrust = parseHarnessConfig(resolveConfig({
    globalPath: paths.globalConfig,
    projectTrusted: false,
  }).value).defaultProjectTrust;
  return new ProjectTrustResolver(new TrustStore(paths.trustStore), {
    ...(override === undefined ? {} : { override }),
    ...(terminal === undefined ? {} : { terminal }),
    defaultProjectTrust,
  });
}

function runtimeOptions(argumentsValue: ParsedArguments): Parameters<typeof loadRuntime>[0] {
  const workspace = flagString(argumentsValue, "workspace");
  const apiKey = flagString(argumentsValue, "api-key");
  const apiKeyProvider = flagString(argumentsValue, "provider") ?? "openai";
  const sessionDirectory = flagString(argumentsValue, "session-dir");
  const trustOverride = projectTrustOverride(argumentsValue);
  return {
    ...(workspace === undefined ? {} : { workspace }),
    ...(trustOverride === undefined ? {} : { projectTrusted: trustOverride === "approve" }),
    ...(apiKey === undefined ? {} : { apiKey, apiKeyProvider }),
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
  };
}

function invocationExtensionOptions(argumentsValue: ParsedArguments) {
  return {
    extensions: !flagBoolean(argumentsValue, "no-extensions"),
    extensionPaths: flagStrings(argumentsValue, "extension"),
    packagePaths: flagStrings(argumentsValue, "package"),
    allowPackageScripts: flagBoolean(argumentsValue, "allow-scripts"),
    skills: !flagBoolean(argumentsValue, "no-skills"),
    skillPaths: flagStrings(argumentsValue, "skill"),
    promptTemplates: !flagBoolean(argumentsValue, "no-prompt-templates"),
    promptTemplatePaths: flagStrings(argumentsValue, "prompt-template"),
    themes: !flagBoolean(argumentsValue, "no-themes"),
    themePaths: flagStrings(argumentsValue, "theme"),
  };
}

function selectionDefaults(
  runtime: LoadedRuntime,
  argumentsValue: ParsedArguments,
  threadId?: string,
  branch?: string,
): { provider: ProviderId; model?: string; reasoningEffort?: string } {
  const sessionSelection = threadId === undefined
    ? undefined
    : runtime.store.getModelSelection(threadId, branch);
  const explicitProvider = flagString(argumentsValue, "provider");
  const explicitModel = flagString(argumentsValue, "model");
  const configuredProvider = runtime.config.defaultProvider ?? "openai";
  const provider = explicitProvider ?? sessionSelection?.provider ?? configuredProvider;
  const model = explicitModel
    ?? (sessionSelection?.provider === provider ? sessionSelection.model : undefined)
    ?? (configuredProvider === provider ? runtime.config.defaultModel : undefined);
  const reasoningEffort = explicitModel === undefined && sessionSelection?.provider === provider && sessionSelection.model === model
    ? sessionSelection.reasoningEffort
    : undefined;
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

async function persistInteractiveModelSelection(
  runtime: LoadedRuntime,
  threadId: string,
  branch: string | undefined,
  selection: ModelSelection,
): Promise<void> {
  runtime.store.appendEvent({
    threadId,
    ...(branch === undefined ? {} : { branch }),
    event: {
      type: "model_selected",
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
  });
  await persistDefaultSelection(runtime.paths, selection);
}

async function selected(
  runtime: LoadedRuntime,
  argumentsValue: ParsedArguments,
  threadId?: string,
): Promise<ModelSelection & { info?: ModelInfo }> {
  const defaults = selectionDefaults(runtime, argumentsValue, threadId, startupBranch(argumentsValue));
  const { provider, model } = defaults;
  if (model === undefined) {
    throw new Error(`No model selected. Pass --model or set defaultModel; inspect choices with: rigyn --list-models ${provider}`);
  }
  const explicitModel = flagString(argumentsValue, "model");
  const explicitProvider = flagString(argumentsValue, "provider");
  const explicitThinking = flagString(argumentsValue, "thinking");
  const resolved = await resolveRequestedModel(runtime.providers, {
    reference: model,
    ...(explicitProvider === undefined && explicitModel !== undefined ? {} : { provider }),
    fallbackProvider: provider,
    ...((explicitThinking ?? defaults.reasoningEffort) === undefined
      ? {}
      : { reasoningEffort: explicitThinking ?? defaults.reasoningEffort }),
  }, AbortSignal.timeout(30_000));
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.info === undefined ? {} : { info: resolved.info }),
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  };
}

export function latestAssistantText(events: readonly EventEnvelope[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type !== "message_appended" || event.message.role !== "assistant") continue;
    const text = event.message.content
      .flatMap((block) => block.type === "text" ? [block.text] : [])
      .join("\n")
      .trim();
    if (text !== "") return text;
  }
  return undefined;
}

function hasDurableEvents(thread: Pick<ThreadRecord, "branches">): boolean {
  return thread.branches.some((branch) => branch.headEventId !== undefined);
}

function savedThreads(runtime: LoadedRuntime): ThreadRecord[] {
  return runtime.store.listThreads({ workspaceRoot: runtime.workspace, limit: 500 })
    .filter(hasDurableEvents);
}

const SESSION_SEARCH_ITEM_BYTES = 64 * 1024;
const SESSION_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024;
const SESSION_PICKER_PAGE_SIZE = 100;
const SESSION_PICKER_MAX_LOADED = 5_000;

export interface SessionPickerPage {
  items: PickerItem<string>[];
  hasMore: boolean;
  nextCursor?: string;
}

function sessionPickerItemsForThreads(
  runtime: LoadedRuntime,
  threads: readonly ThreadRecord[],
  currentThreadId?: string,
  options: { allWorkspaces?: boolean } = {},
): PickerItem<string>[] {
  let totalSearchBytes = SESSION_SEARCH_TOTAL_BYTES;
  const items: PickerItem<string>[] = [];
  for (const thread of threads) {
    if (!hasDurableEvents(thread)) continue;
    const preview = runtime.store.getThreadPreview(thread.threadId, {
      branch: thread.defaultBranch,
      searchByteLimit: Math.min(SESSION_SEARCH_ITEM_BYTES, totalSearchBytes),
    });
    const model = preview.latestProvider === undefined || preview.latestModel === undefined
      ? undefined
      : `${preview.latestProvider}/${preview.latestModel}`;
    const path = indexedSessionReference({ databasePath: runtime.databasePath, threadId: thread.threadId });
    let itemBytes = Math.min(SESSION_SEARCH_ITEM_BYTES, totalSearchBytes);
    let search = "";
    const appendSearch = (value: string | undefined): void => {
      if (value === undefined || value === "" || itemBytes === 0) return;
      const separator = search === "" ? "" : " ";
      const separatorBytes = Buffer.byteLength(separator);
      if (separatorBytes >= itemBytes) {
        itemBytes = 0;
        return;
      }
      const text = byteTruncate(value, itemBytes - separatorBytes).replace(/\s+/gu, " ").trim();
      if (text === "") return;
      search += `${separator}${text}`;
      itemBytes -= separatorBytes + Buffer.byteLength(text);
    };
    appendSearch(thread.threadId);
    appendSearch(thread.name);
    appendSearch(thread.workspaceRoot);
    appendSearch(path);
    appendSearch(model);
    appendSearch(preview.firstPrompt);
    appendSearch(preview.recentSearchText);
    totalSearchBytes -= Math.min(SESSION_SEARCH_ITEM_BYTES, totalSearchBytes) - itemBytes;
    const branches = thread.branches.length === 1 ? undefined : `${thread.branches.length} branches`;
    const detail = [
      formatSessionAge(thread.updatedAt),
      `${preview.messageCount}${preview.messageCountTruncated ? "+" : ""} message${preview.messageCount === 1 && !preview.messageCountTruncated ? "" : "s"}`,
      model,
      branches,
      ...(options.allWorkspaces === true ? [thread.workspaceRoot ?? "workspace unknown"] : []),
    ].filter((value): value is string => value !== undefined).join(" · ");
    items.push({
      id: thread.threadId,
      label: thread.name ?? preview.firstPrompt ?? thread.threadId,
      detail,
      value: thread.threadId,
      ...(search === "" ? {} : { keywords: [search] }),
      session: {
        ...(thread.name === undefined ? {} : { name: thread.name }),
        path,
        ...(thread.workspaceRoot === undefined ? {} : { workspace: thread.workspaceRoot }),
        updatedAt: thread.updatedAt,
        createdAt: thread.createdAt,
        ...(thread.parentThreadId === undefined ? {} : { parentId: thread.parentThreadId }),
        current: thread.threadId === currentThreadId,
        messageCount: preview.messageCount,
      },
    });
  }
  return items;
}

export function sessionPickerItems(
  runtime: LoadedRuntime,
  currentThreadId?: string,
  options: { allWorkspaces?: boolean } = {},
): PickerItem<string>[] {
  return sessionPickerItemsForThreads(runtime, runtime.store.listThreads({
    ...(options.allWorkspaces === true ? {} : { workspaceRoot: runtime.workspace }),
    limit: 500,
  }), currentThreadId, options);
}

function sessionCatalogSearch(query: string): string | undefined {
  const selected = query.trim();
  if (selected === "" || selected.toLowerCase().startsWith("re:")) return undefined;
  return selected.replaceAll('"', "").trim() || undefined;
}

export function sessionPickerPage(
  runtime: LoadedRuntime,
  currentThreadId?: string,
  options: { query?: string; cursor?: string; limit?: number } = {},
): SessionPickerPage {
  const limit = options.limit ?? SESSION_PICKER_PAGE_SIZE;
  const search = sessionCatalogSearch(options.query ?? "");
  const scope = `tui:${runtime.workspace}`;
  const request = normalizeHarnessSessionListRequest({
    limit,
    ...(search === undefined ? {} : { search }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  }, scope);
  const page = runtime.store.listThreadMetadataPage({
    workspaceRoot: runtime.workspace,
    ...(request.search === undefined ? {} : { search: request.search, searchEvents: true }),
    durableOnly: true,
    limit: request.limit,
    ...(request.after === undefined ? {} : { after: request.after }),
  });
  const catalogPage = harnessSessionPage(page.threads, page.hasMore, page.next, scope, request.search);
  return {
    items: sessionPickerItemsForThreads(
      runtime,
      page.threads.map((thread) => runtime.store.getThread(thread.threadId)),
      currentThreadId,
    ),
    hasMore: catalogPage.hasMore,
    ...(catalogPage.nextCursor === undefined ? {} : { nextCursor: catalogPage.nextCursor }),
  };
}

export function indexedSessionPickerItems(
  index: WorkspaceSessionIndex,
  current?: { workspaceRoot: string; databasePath: string; threadId: string },
): PickerItem<string>[] {
  return indexedSessionPickerItemsForRecords(index.list({ limit: 500 }), current);
}

function indexedSessionPickerItemsForRecords(
  records: readonly IndexedSessionRecord[],
  current?: { workspaceRoot: string; databasePath: string; threadId: string },
): PickerItem<string>[] {
  return records.map((record) => {
    const reference = indexedSessionReference(record);
    const currentSession = current !== undefined
      && record.workspaceRoot === current.workspaceRoot
      && record.databasePath === current.databasePath
      && record.threadId === current.threadId;
    return {
      id: reference,
      label: record.name ?? record.threadId,
      detail: `${formatSessionAge(record.updatedAt)} · ${record.workspaceRoot}`,
      value: reference,
      keywords: [record.threadId, record.name ?? "", record.workspaceRoot, record.databasePath, reference],
      session: {
        ...(record.name === undefined ? {} : { name: record.name }),
        path: reference,
        workspace: record.workspaceRoot,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        current: currentSession,
      },
    };
  });
}

export function indexedSessionPickerPage(
  index: WorkspaceSessionIndex,
  current: { workspaceRoot: string; databasePath: string; threadId: string } | undefined,
  options: { query?: string; cursor?: string; limit?: number } = {},
): SessionPickerPage {
  const search = sessionCatalogSearch(options.query ?? "");
  const page = index.listPage({
    ...(search === undefined ? {} : { search }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: options.limit ?? SESSION_PICKER_PAGE_SIZE,
  });
  return {
    items: indexedSessionPickerItemsForRecords(page.sessions, current),
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

async function removeEmptyThread(
  runtime: LoadedRuntime,
  threadId: string,
  index?: WorkspaceSessionIndex,
): Promise<void> {
  if (hasDurableEvents(runtime.store.getThread(threadId))) {
    await upsertIndexedThread(index, runtime, threadId);
    return;
  }
  await runtime.service.deleteSession(threadId);
  await removeIndexedThread(index, runtime, threadId);
}

async function pickThread(runtime: LoadedRuntime, terminal: TerminalPrompter, currentThreadId?: string): Promise<ThreadRecord> {
  const page = terminal instanceof TuiController ? sessionPickerPage(runtime, currentThreadId) : undefined;
  const items = page?.items ?? sessionPickerItems(runtime, currentThreadId);
  if (items.length === 0 && !(terminal instanceof TuiController)) {
    throw new Error("No other saved sessions are available in this workspace");
  }
  const selected = terminal instanceof TuiController
    ? await (async () => {
        terminal.setSessionPickerPagination(
          false,
          page?.hasMore === true
            ? `Showing the newest ${items.length} sessions during startup; resume by exact --thread ID or open /resume after startup to search older sessions`
            : `${items.length} session${items.length === 1 ? "" : "s"} loaded · end of catalog`,
        );
        return await terminal.choosePicker("session", "Resume Session", items);
      })()
    : await terminal.choose("Resume session", items.map((item) => ({
      label: item.label,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      value: item.value,
    })));
  return runtime.store.bindThreadWorkspace(selected, runtime.workspace);
}

async function pickIndexedThread(
  index: WorkspaceSessionIndex,
  runtime: LoadedRuntime,
  terminal: TerminalPrompter,
  currentThreadId?: string,
): Promise<IndexedSessionRecord> {
  const current = currentThreadId === undefined ? undefined : {
    workspaceRoot: runtime.workspace,
    databasePath: runtime.databasePath,
    threadId: currentThreadId,
  };
  const page = terminal instanceof TuiController ? indexedSessionPickerPage(index, current) : undefined;
  const items = page?.items ?? indexedSessionPickerItems(index, current);
  if (items.length === 0 && !(terminal instanceof TuiController)) {
    throw new Error("No saved sessions are available in the workspace index");
  }
  const selected = terminal instanceof TuiController
    ? await (async () => {
        terminal.setSessionPickerPagination(
          false,
          page?.hasMore === true
            ? `Showing the newest ${items.length} indexed sessions during startup; resume by exact qualified --thread reference or open /resume --all after startup to search older sessions`
            : `${items.length} indexed session${items.length === 1 ? "" : "s"} loaded · end of catalog`,
        );
        return await terminal.choosePicker("session", "Resume Session · All Workspaces", items);
      })()
    : await terminal.choose("Resume Session · All Workspaces", items.map((item) => ({
        label: item.label,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        value: item.value,
      })));
  return resolveIndexedSessionReference(index, selected);
}

async function openSessionIndex(runtime: LoadedRuntime): Promise<WorkspaceSessionIndex> {
  return await WorkspaceSessionIndex.open(join(runtime.paths.stateDirectory, "session-index.sqlite"));
}

async function refreshSessionIndex(index: WorkspaceSessionIndex, runtime: LoadedRuntime): Promise<void> {
  await index.refreshWorkspace({ workspaceRoot: runtime.workspace, databasePath: runtime.databasePath });
}

async function initializeSessionIndex(
  runtime: LoadedRuntime,
  required: boolean,
  warn: (message: string) => void,
): Promise<WorkspaceSessionIndex | undefined> {
  let index: WorkspaceSessionIndex | undefined;
  try {
    index = await openSessionIndex(runtime);
    const indexedWorkspaces = new Set(index.listWorkspaceRoots());
    for (const workspaceRoot of runtime.store.listDurableWorkspaceRoots(MAX_INDEX_WORKSPACES)) {
      if (workspaceRoot === runtime.workspace || indexedWorkspaces.has(workspaceRoot)) continue;
      try {
        await index.refreshWorkspace({ workspaceRoot, databasePath: runtime.databasePath });
      } catch (error) {
        const workspace = byteTruncate(sanitizeTerminalText(workspaceRoot), 512);
        const message = byteTruncate(sanitizeTerminalText(error instanceof Error ? error.message : String(error)), 1_024);
        warn(`Skipped stale session-index workspace ${workspace}: ${message}`);
      }
    }
    await refreshSessionIndex(index, runtime);
    return index;
  } catch (error) {
    try { index?.close(); } catch {}
    if (required) throw error;
    warn(`Session index unavailable; cross-workspace resume will not be updated: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function upsertIndexedThread(
  index: WorkspaceSessionIndex | undefined,
  runtime: LoadedRuntime,
  threadId: string,
): Promise<void> {
  if (index === undefined) return;
  const thread = runtime.store.getThread(threadId);
  if (!hasDurableEvents(thread)) {
    await index.removeSession({ workspaceRoot: runtime.workspace, databasePath: runtime.databasePath, threadId });
    return;
  }
  await index.upsertSession({
    workspaceRoot: runtime.workspace,
    databasePath: runtime.databasePath,
    thread,
  });
}

async function removeIndexedThread(
  index: WorkspaceSessionIndex | undefined,
  runtime: LoadedRuntime,
  threadId: string,
): Promise<void> {
  if (index === undefined) return;
  await index.removeSession({ workspaceRoot: runtime.workspace, databasePath: runtime.databasePath, threadId });
}

function currentIndexedRuntime(runtime: LoadedRuntime, record: IndexedSessionRecord): boolean {
  return record.workspaceRoot === runtime.workspace && record.databasePath === runtime.databasePath;
}

async function requestedIndexedSession(
  index: WorkspaceSessionIndex,
  runtime: LoadedRuntime,
  argumentsValue: ParsedArguments,
  terminal?: TerminalPrompter,
): Promise<IndexedSessionRecord> {
  const threadFlag = flagString(argumentsValue, "thread");
  const sessionFlag = flagString(argumentsValue, "session");
  if (threadFlag !== undefined && sessionFlag !== undefined) throw new Error("--thread and --session are aliases; use only one");
  const explicit = threadFlag ?? sessionFlag;
  const resumeLatest = flagBoolean(argumentsValue, "continue");
  const resumePicker = flagBoolean(argumentsValue, "resume");
  if ([explicit !== undefined, resumeLatest, resumePicker].filter(Boolean).length !== 1) {
    throw new Error("--all requires exactly one of --thread/--session, --continue, or --resume");
  }
  if (explicit !== undefined) return resolveIndexedSessionReference(index, explicit);
  if (resumeLatest) {
    const latest = index.list({ limit: 1 })[0];
    if (latest === undefined) throw new Error("No indexed saved session exists");
    return latest;
  }
  if (terminal === undefined) throw new Error("--resume --all requires an interactive terminal; use --thread with a qualified session reference");
  return await pickIndexedThread(index, runtime, terminal);
}

async function stageIndexedRuntime(
  record: IndexedSessionRecord,
  runtime: LoadedRuntime,
  index: WorkspaceSessionIndex,
  argumentsValue: ParsedArguments,
  terminal?: TerminalPrompter,
  projectTrust?: ProjectTrustResolver,
) {
  const trust = projectTrust ?? projectTrustResolver(argumentsValue, runtime.paths, terminal);
  return await prepareIndexedSessionRuntimeSwitch(
    record,
    runtime.workspace,
    index,
    trust,
    async (workspace) => {
      const projectTrusted = await trust.isTrusted(workspace);
      return await loadRuntime({
        ...runtimeOptions(argumentsValue),
        ...invocationExtensionOptions(argumentsValue),
        workspace,
        ...(projectTrusted ? { projectTrusted: true } : {}),
        extensionRuntime: true,
        recover: false,
      });
    },
  );
}

async function pickTimelineEvent(
  runtime: LoadedRuntime,
  terminal: TerminalPrompter,
  threadId: string,
  branch?: string,
  options: { userOnly?: boolean; labeledOnly?: boolean } = {},
): Promise<SessionTreeRow> {
  const rows = buildSessionTree(runtime.store, threadId, branch)
    .filter((row) => (options.userOnly !== true || row.kind === "user") && (options.labeledOnly !== true || row.label !== undefined));
  if (rows.length === 0) throw new Error(options.userOnly === true ? "This session has no user turns to select" : "This session has no entries to select");
  if (terminal instanceof TuiController && terminal.mode === "full") {
    return terminal.chooseSessionTree(options.userOnly === true ? "Fork from User Turn" : "Session Tree", rows.map((row) => ({
      id: row.eventId,
      label: row.text,
      detail: `${row.timestamp} · ${row.kind} · ${row.sourceBranch}${row.branches.length === 0 ? "" : ` · ends ${row.branches.join(", ")}`}`,
      keywords: [...row.paths, ...row.branches],
      value: row,
      tree: {
        eventId: row.eventId,
        ...(row.parentEventId === undefined ? {} : { parentEventId: row.parentEventId }),
        kind: row.kind,
        depth: row.depth,
        prefix: row.prefix,
        branches: row.branches,
        paths: row.paths,
        active: row.active,
        ...(row.label === undefined ? {} : { label: row.label }),
        ...(row.labelTimestamp === undefined ? {} : { labelTimestamp: row.labelTimestamp }),
      },
    })), {
      async onLabelChange(eventId, label) {
        const changed = await runtime.service.setSessionEntryLabel({
          threadId,
          ...(branch === undefined ? {} : { branch }),
          targetEventId: eventId,
          ...(label === undefined ? {} : { label }),
        });
        return changed.event.label === undefined
          ? {}
          : { label: changed.event.label, labelTimestamp: changed.timestamp };
      },
    });
  }
  const choices = rows.map((row) => ({
    label: `${row.prefix}${row.label === undefined ? "" : `[${row.label}] `}${row.text}${row.branches.length === 0 ? "" : `  [${row.branches.join(", ")}]`}`,
    detail: `${row.timestamp} · ${row.kind} · ${row.sourceBranch}${row.active ? " · active path" : ""}`,
    value: row,
  }));
  return terminal.choose("Select a conversation point", choices);
}

function automaticBranchName(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 17)}`;
}

async function resolveThread(
  runtime: LoadedRuntime,
  argumentsValue: ParsedArguments,
  terminal?: TerminalPrompter,
): Promise<string | undefined> {
  const threadFlag = flagString(argumentsValue, "thread");
  const sessionFlag = flagString(argumentsValue, "session");
  if (threadFlag !== undefined && sessionFlag !== undefined) throw new Error("--thread and --session are aliases; use only one");
  const explicit = threadFlag ?? sessionFlag;
  const exactSessionId = flagString(argumentsValue, "session-id");
  const fork = flagString(argumentsValue, "fork");
  const resumeLatest = flagBoolean(argumentsValue, "continue");
  const resumePicker = flagBoolean(argumentsValue, "resume");
  if ([explicit !== undefined, exactSessionId !== undefined, fork !== undefined, resumeLatest, resumePicker].filter(Boolean).length > 1) {
    throw new Error("--fork, --thread/--session, --session-id, --continue, and --resume are mutually exclusive");
  }
  if (fork !== undefined) {
    const source = resolveSessionReference(runtime.store, fork, { workspaceRoot: runtime.workspace });
    const sourceBranch = flagString(argumentsValue, "branch");
    const cloned = await runtime.service.cloneSessionPath({
      threadId: source.threadId,
      ...(sourceBranch === undefined ? {} : { branch: sourceBranch }),
    });
    return cloned.thread.threadId;
  }
  if (explicit !== undefined) {
    const resolved = resolveSessionReference(runtime.store, explicit, { workspaceRoot: runtime.workspace });
    return runtime.store.bindThreadWorkspace(resolved.threadId, runtime.workspace).threadId;
  }
  if (exactSessionId !== undefined) {
    try {
      return runtime.store.bindThreadWorkspace(exactSessionId, runtime.workspace).threadId;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "STORAGE_NOT_FOUND")) throw error;
      return (await runtime.service.createSession({
        threadId: exactSessionId,
        cwd: currentWorkspaceCwd(runtime.workspace),
      })).threadId;
    }
  }
  if (resumeLatest) {
    const latest = savedThreads(runtime)[0];
    if (latest === undefined) throw new Error("No saved session exists for this workspace");
    return latest.threadId;
  }
  if (resumePicker) {
    if (terminal === undefined) throw new Error("--resume requires an interactive terminal; use --thread for non-interactive runs");
    return (await pickThread(runtime, terminal)).threadId;
  }
  return undefined;
}

function startupBranch(argumentsValue: ParsedArguments): string | undefined {
  return flagString(argumentsValue, "fork") === undefined
    ? flagString(argumentsValue, "branch")
    : undefined;
}

async function pickProvider(runtime: LoadedRuntime, terminal: TerminalPrompter): Promise<ProviderId> {
  const choices = await Promise.all(runtime.providers.list().map(async (adapter) => {
    const state = await runtime.auth.state(adapter.id);
    const shadowed = state.environment.shadowed && state.environment.variable !== undefined
      ? `${state.environment.variable} shadowed by stored credential`
      : undefined;
    return {
      label: state.displayName === adapter.id ? adapter.id : `${state.displayName} (${adapter.id})`,
      detail: [state.status, state.source, shadowed].filter(Boolean).join(" · "),
      value: adapter.id,
    };
  }));
  return terminal.choose("Select provider", choices);
}

export type LoginPath = "subscription" | "api_key";

export function authMethodLoginPath(method: ProviderAuthMethod): LoginPath {
  return method.kind === "oauth" || method.kind === "openai_codex_browser" || method.kind === "openai_codex_device"
    || method.kind === "anthropic_browser" || method.kind === "github_copilot_device"
    ? "subscription"
    : "api_key";
}

function loginPathLabel(path: LoginPath): string {
  return path === "subscription" ? "Use a subscription" : "Use an API key";
}

async function pickLoginProvider(
  runtime: LoadedRuntime,
  terminal: TerminalPrompter,
  path: LoginPath,
): Promise<ProviderId> {
  const choices = (await Promise.all(runtime.providers.list().map(async (adapter) => {
    const methods = (await runtime.auth.loginMethods(adapter.id)).filter((method) => authMethodLoginPath(method) === path);
    if (methods.length === 0) return undefined;
    const state = await runtime.auth.state(adapter.id);
    const connection = state.status === "connected"
      ? "configured"
      : state.status === "unavailable"
        ? "unavailable"
        : "unconfigured";
    return {
      label: state.displayName,
      detail: connection,
      value: adapter.id,
    };
  }))).filter((choice): choice is NonNullable<typeof choice> => choice !== undefined)
    .sort((left, right) => left.label.localeCompare(right.label));
  if (choices.length === 0) {
    throw new Error(path === "subscription"
      ? "No subscription login is registered. Provider extensions can add OAuth login methods."
      : "No API-key or provider-managed login is registered.");
  }
  return terminal.choose(path === "subscription" ? "Select subscription provider" : "Select API-key provider", choices);
}

async function pickModel(runtime: LoadedRuntime, provider: ProviderId, terminal: TerminalPrompter): Promise<string> {
  let models: ModelInfo[];
  try {
    models = await runtime.providers.listModels(provider, AbortSignal.timeout(30_000), { refresh: true });
  } catch (error) {
    const message = `Could not load ${provider} models: ${error instanceof Error ? error.message : String(error)}`;
    if (terminal instanceof TuiController) terminal.notify(message, "warning");
    else process.stderr.write(`${message}\n`);
    const exact = (await terminal.question("Exact model/deployment ID: ")).trim();
    if (exact === "") throw new Error("Model is required");
    return exact;
  }
  if (models.length === 0) {
    const exact = (await terminal.question("Exact model/deployment ID: ")).trim();
    if (exact === "") throw new Error("Model is required");
    return exact;
  }
  const selectable = provider === "openai" ? models.filter((model) => isAgentOpenAIModel(model.id)) : models;
  if (selectable.length === 0) {
    const exact = (await terminal.question("Exact model/deployment ID: ")).trim();
    if (exact === "") throw new Error("Model is required");
    return exact;
  }
  return terminal.choose(`Select ${provider} model`, [...selectable]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({
      label: model.id,
      detail: [
        model.displayName,
        model.description,
        model.contextTokens === undefined ? undefined : `${model.contextTokens.toLocaleString()} context`,
      ].filter(Boolean).join(" · "),
      value: model.id,
    })));
}

async function runCommand(argumentsValue: ParsedArguments): Promise<void> {
  await withGracefulTermination(async (termination) => await runCommandOperation(argumentsValue, termination));
}

async function runCommandOperation(
  argumentsValue: ParsedArguments,
  termination: GracefulTerminationContext,
): Promise<void> {
  projectTrustOverride(argumentsValue);
  const json = flagBoolean(argumentsValue, "json") || flagString(argumentsValue, "mode") === "json";
  const print = flagBoolean(argumentsValue, "print") || (!process.stdout.isTTY && !json);
  const renderer = new EventRenderer(json ? "json" : print ? "quiet" : "interactive");
  const terminal = process.stdin.isTTY && !print && !json ? new TerminalController() : undefined;
  const ephemeral = flagBoolean(argumentsValue, "no-session");
  const allWorkspaces = flagBoolean(argumentsValue, "all");
  if (ephemeral && (flagString(argumentsValue, "thread") !== undefined || flagString(argumentsValue, "session") !== undefined || flagString(argumentsValue, "session-id") !== undefined || flagString(argumentsValue, "fork") !== undefined || flagBoolean(argumentsValue, "continue") || flagBoolean(argumentsValue, "resume") || flagString(argumentsValue, "name") !== undefined || allWorkspaces)) {
    throw new Error("--no-session cannot be combined with --fork, --thread, --session, --session-id, --continue, --resume, --all, or --name");
  }
  if (allWorkspaces && flagString(argumentsValue, "fork") !== undefined) throw new Error("--fork cannot be combined with --all");
  // Explicit one-shot runs never interrupt startup for project trust.
  const projectTrust = projectTrustResolver(argumentsValue, harnessPaths());
  let projectTrusted: boolean;
  try {
    projectTrusted = await projectTrust.isTrusted(flagString(argumentsValue, "workspace") ?? process.cwd());
  } catch (error) {
    terminal?.close();
    throw error;
  }
  let runtime = await loadRuntime({
    ...runtimeOptions(argumentsValue),
    ...invocationExtensionOptions(argumentsValue),
    ...(projectTrusted ? { projectTrusted: true } : {}),
    ephemeral,
    extensionRuntime: true,
    recover: !allWorkspaces,
  });
  let sessionIndex: WorkspaceSessionIndex | undefined;
  let ephemeralThreadId: string | undefined;
  let extensionSession: { threadId: string; branch?: string } | undefined;
  let activeThreadId: string | undefined;
  const uninstallTermination = termination.onTerminate((signal) => {
    terminal?.close();
    if (activeThreadId === undefined) return;
    try { runtime.service.cancel(activeThreadId, `interrupted by ${signal}`); } catch {}
  });
  try {
    termination.throwIfTerminated();
    argumentsValue = applyRuntimeExtensionFlags(argumentsValue, runtime.runtimeExtensions);
    if (!ephemeral) {
      sessionIndex = await initializeSessionIndex(runtime, allWorkspaces, (message) => process.stderr.write(`${message}\n`));
    }
    let resolvedThreadId: string | undefined;
    if (ephemeral) {
      resolvedThreadId = ephemeralThreadId = (await runtime.service.createSession({
        cwd: currentWorkspaceCwd(runtime.workspace),
      })).threadId;
    } else if (allWorkspaces) {
      if (sessionIndex === undefined) throw new Error("All-workspace session index is unavailable");
      const record = await requestedIndexedSession(sessionIndex, runtime, argumentsValue, terminal);
      if (currentIndexedRuntime(runtime, record)) {
        const verified = await sessionIndex.verify(record, { isTrusted: async () => true });
        resolvedThreadId = runtime.store.bindThreadWorkspace(verified.threadId, runtime.workspace).threadId;
        await runtime.service.recoverWorkspaceRuntime();
      } else {
        const prepared = await stageIndexedRuntime(record, runtime, sessionIndex, argumentsValue, terminal, projectTrust);
        const previousRuntime = runtime;
        let candidateArguments: ParsedArguments;
        try {
          candidateArguments = applyRuntimeExtensionFlags(argumentsValue, prepared.runtime.runtimeExtensions);
        } catch (error) {
          await prepared.rollback();
          throw error;
        }
        runtime = prepared.commit();
        resolvedThreadId = prepared.target.thread.threadId;
        try {
          await runtime.service.recoverWorkspaceRuntime();
        } catch (error) {
          const candidateRuntime = runtime;
          runtime = previousRuntime;
          try {
            await candidateRuntime.close();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Workspace recovery and candidate cleanup failed");
          }
          throw error;
        }
        argumentsValue = candidateArguments;
        try {
          await previousRuntime.close();
        } catch (error) {
          process.stderr.write(`Previous workspace cleanup failed after session switch: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        await refreshSessionIndex(sessionIndex, runtime);
      }
    } else {
      resolvedThreadId = await resolveThread(runtime, argumentsValue, terminal);
    }
    const promptOptions = await systemPromptCliOptions(argumentsValue, runtime.workspace);
    const requestedName = flagString(argumentsValue, "name");
    if (requestedName !== undefined && !ephemeral && resolvedThreadId !== undefined) {
      await runtime.service.setSessionName({ threadId: resolvedThreadId, name: requestedName });
      await upsertIndexedThread(sessionIndex, runtime, resolvedThreadId);
    }
    const choice = await selected(runtime, argumentsValue, resolvedThreadId);
    const requestedThinking = thinkingLevel(flagString(argumentsValue, "thinking") ?? choice.reasoningEffort ?? runtime.config.thinking);
    const thinking = compatibleThinkingLevel(requestedThinking, choice.info);
    if (thinking !== requestedThinking) {
      process.stderr.write(
        `Model ${choice.provider}/${choice.model} does not support configured thinking level ${requestedThinking}; using ${thinking}.\n`,
      );
    }
    const { reasoningEffort: _selectionThinking, info: _selectedModelInfo, ...selectedModel } = choice;
    const tools = selectedTools(
      argumentsValue,
      runtime.runtimeExtensions.tools().map((tool) => tool.definition.name),
    );
    const messages = [...argumentsValue.positionals];
    if (messages.length === 0 && !process.stdin.isTTY) messages.push(await stdinText());
    if (messages.length === 0 || messages.some((message) => message.trim() === "")) throw new Error("Prompt is empty");
    const branch = startupBranch(argumentsValue);
    const cwd = currentWorkspaceCwd(runtime.workspace);
    const threadId = resolvedThreadId ?? (await runtime.service.createSession({ cwd })).threadId;
    activeThreadId = threadId;
    extensionSession = { threadId, ...(branch === undefined ? {} : { branch }) };
    await runtime.runtimeExtensions.dispatch("session_start", { threadId, branch, workspace: runtime.workspace }).catch((error) => {
      process.stderr.write(`Extension session start failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    termination.throwIfTerminated();
    let finalText: string | undefined;
    for (const message of messages) {
      const submission = await expandOneShotSubmission(
        message,
        runtime,
        threadId,
        branch,
        termination.signal,
      );
      if (submission === undefined) continue;
      const expandedPrompt = await expandPromptReferences(submission, runtime.workspace);
      termination.throwIfTerminated();
      const run = await runtime.service.run({
        prompt: expandedPrompt.text,
        ...(expandedPrompt.images.length === 0 ? {} : { images: expandedPrompt.images }),
        ...selectedModel,
        ...outboundImageOptions(argumentsValue),
        ...promptOptions,
        ...tools,
        cwd,
        ...(flagBoolean(argumentsValue, "no-context-files") ? { noContextFiles: true } : {}),
        threadId,
        ...(branch === undefined ? {} : { branch }),
        ...(runtime.config.maxSteps === undefined ? {} : { maxSteps: runtime.config.maxSteps }),
        ...(runtime.config.contextTokenBudget === undefined ? {} : { contextTokenBudget: runtime.config.contextTokenBudget }),
        ...(runtime.config.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: runtime.config.summaryTokenBudget }),
        ...(thinking === "off" ? {} : { reasoningEffort: thinking }),
        steeringMode: runtime.config.steeringMode,
        followUpMode: runtime.config.followUpMode,
        onEvent: async (event) => {
          renderer.render(event);
          try {
            await runtime.runtimeExtensions.dispatch("event", event);
          } catch (error) {
            process.stderr.write(`Extension event failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        },
      });
      finalText = run.results.at(-1)?.finalText;
    }
    if (print && !json && finalText !== undefined) writeMachineOutput(`${finalText}\n`);
    if (requestedName !== undefined && !ephemeral && resolvedThreadId === undefined) {
      await runtime.service.setSessionName({
        threadId,
        ...(branch === undefined ? {} : { branch }),
        name: requestedName,
      });
    }
    if (!ephemeral) await upsertIndexedThread(sessionIndex, runtime, threadId);
  } finally {
    terminal?.close();
    if (extensionSession !== undefined) {
      await runtime.runtimeExtensions.dispatch("session_end", { ...extensionSession, workspace: runtime.workspace }).catch(() => undefined);
    }
    if (ephemeralThreadId !== undefined) {
      try {
        await runtime.service.deleteSession(ephemeralThreadId);
      } catch {}
    }
    try {
      await runtime.close();
    } finally {
      try {
        sessionIndex?.close();
      } finally {
        uninstallTermination();
      }
    }
  }
}

function configuredSelection(
  runtime: LoadedRuntime,
  argumentsValue: ParsedArguments,
  threadId?: string,
  branch?: string,
): ModelSelection | undefined {
  const defaults = selectionDefaults(runtime, argumentsValue, threadId, branch);
  if (!runtime.providers.has(defaults.provider)) {
    if (flagString(argumentsValue, "provider") !== undefined) runtime.providers.get(defaults.provider);
    return undefined;
  }
  if (defaults.model === undefined) return undefined;
  return {
    provider: defaults.provider,
    model: defaults.model,
    ...(defaults.reasoningEffort === undefined ? {} : { reasoningEffort: thinkingLevel(defaults.reasoningEffort) }),
  };
}

function requireModelSelection(choice: ModelSelection | undefined): asserts choice is ModelSelection {
  if (choice === undefined) throw new Error("No model selected. Run /login to connect a provider, or /model to choose an exact model.");
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
  try {
    state = await runtime.auth.profileState(provider);
  } catch {
    return { action: "authenticate" };
  }
  if (state.profiles.length === 0) return { action: "authenticate" };
  const choices: Array<{ label: string; detail: string; value: InteractiveLoginProfile }> = state.profiles.flatMap((profile) => [
    ...(profile.present && profile.usable
      ? [{
          label: `Use saved profile ${profile.name}`,
          detail: profile.active ? "active · ready" : "ready",
          value: { action: "selected" as const, profile: profile.name },
        }]
      : []),
    {
      label: `Sign in again to profile ${profile.name}`,
      detail: profile.error ?? "Replace only this profile after authentication succeeds",
      value: { action: "authenticate" as const, profile: profile.name },
    },
  ]);
  const selected = await terminal.choose(`Credential profile for ${provider}`, [
    ...choices,
    {
      label: "Add a new profile",
      detail: "Keep every existing profile",
      value: { action: "authenticate" as const },
    },
  ], signal);
  if (selected.action === "selected") {
    await runtime.auth.selectProfile(provider, selected.profile);
    return selected;
  }
  if (selected.profile !== undefined) return selected;
  const profile = (await terminal.question("New credential profile name: ", signal)).trim();
  assertCredentialProfileName(profile);
  if (state.profiles.some((entry) => entry.name === profile)) {
    throw new Error(`Credential profile already exists: ${profile}`);
  }
  return { action: "authenticate", profile };
}

async function loginInteractively(
  runtime: LoadedRuntime,
  terminal: TuiController,
  requested?: string,
  signal?: AbortSignal,
  noBrowser = false,
): Promise<ProviderId> {
  let path: LoginPath | undefined;
  let provider: ProviderId;
  if (requested === undefined || requested === "") {
    path = await terminal.choose("Select authentication method", [
      { label: loginPathLabel("subscription"), value: "subscription" as const },
      { label: loginPathLabel("api_key"), value: "api_key" as const },
    ]);
    provider = await pickLoginProvider(runtime, terminal, path);
  } else {
    provider = requested;
  }
  runtime.providers.get(provider);
  const profile = await chooseInteractiveLoginProfile(runtime, terminal, provider, signal);
  if (profile.action === "selected") return provider;
  const storeOptions = profile.profile === undefined ? {} : { profile: profile.profile, select: true };
  const availableMethods = await runtime.auth.loginMethods(provider);
  const availablePaths = [...new Set(availableMethods.map(authMethodLoginPath))];
  if (path === undefined && availablePaths.length > 1) {
    path = await terminal.choose(`Connect ${provider}`, availablePaths.map((candidate) => ({
      label: loginPathLabel(candidate),
      value: candidate,
    })));
  }
  path ??= availablePaths[0];
  const methods = path === undefined
    ? []
    : availableMethods.filter((method) => authMethodLoginPath(method) === path);
  if (methods.length === 0) throw new Error(`${provider} does not expose an interactive login method`);
  const method = methods.length === 1
    ? methods[0]
    : await terminal.choose(`Connect ${provider}`, methods.map((entry) => ({
        label: entry.label,
        detail: entry.detail,
        value: entry,
      })));
  if (method === undefined) throw new Error(`${provider} does not expose an interactive login method`);
  const binding = runtime.auth.binding(provider);
  if (method.kind === "local" || method.kind === "external") {
    terminal.notify(method.detail);
    return provider;
  }
  if (method.kind === "environment") {
    await runtime.auth.selectFallback(provider);
    return provider;
  }
  if (method.kind === "ambient") {
    await runtime.auth.selectFallback(provider);
    return provider;
  }
  if (method.kind === "openrouter_browser") {
    const session = await createOpenRouterLoopback({
      fetch: runtime.network.fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    terminal.notify(`Open this URL to sign in:\n${session.authorizationUrl.toString()}`);
    openBrowser(session.authorizationUrl, noBrowser);
    const key = await session.waitForKey();
    await runtime.auth.storeCredential(provider, { kind: "api_key", provider: binding.credentialId, apiKey: key }, storeOptions);
    return provider;
  }
  if (method.kind === "openai_codex_browser" || method.kind === "openai_codex_device") {
    const credential = await authorizeOpenAICodex({
      flow: method.kind === "openai_codex_browser" ? "browser" : "device",
      showAuthorization: ({ url, userCode }) => terminal.notify(userCode === undefined
        ? `Open this URL to sign in:\n${url.toString()}`
        : `Open ${url.toString()} and enter code ${userCode}\nWaiting for authentication...`),
      openUrl: (url) => openBrowser(url, noBrowser),
      requestManualAuthorization: async (_authorization, manualSignal) => {
        const value = (await terminal.question(
          "Paste the callback URL or authorization code, or press Enter to keep waiting: ",
          manualSignal,
        )).trim();
        return value === "" ? undefined : value;
      },
      ...(signal === undefined ? {} : { signal }),
      fetch: runtime.network.fetch,
    });
    await runtime.auth.storeCredential(provider, credential, storeOptions);
    return provider;
  }
  if (method.kind === "anthropic_browser") {
    const credential = await authorizeAnthropic({
      showAuthorization: ({ url }) => terminal.notify(`Open this URL to sign in:\n${url.toString()}`),
      openUrl: (url) => openBrowser(url, noBrowser),
      requestManualAuthorization: async (_authorization, manualSignal) => {
        const value = (await terminal.question(
          "Paste the callback URL or authorization code, or press Enter to keep waiting: ",
          manualSignal,
        )).trim();
        return value === "" ? undefined : value;
      },
      ...(signal === undefined ? {} : { signal }),
      fetch: runtime.network.fetch,
    });
    await runtime.auth.storeCredential(provider, credential, storeOptions);
    return provider;
  }
  if (method.kind === "github_copilot_device") {
    const credential = await authorizeGitHubCopilot({
      requestHost: async (hostSignal) => {
        const value = (await terminal.question(
          "GitHub Enterprise Cloud hostname (empty for github.com): ",
          hostSignal,
        )).trim();
        return value === "" ? undefined : value;
      },
      showDeviceCode: ({ url, userCode }) => terminal.notify(
        `Open ${url.toString()} and enter code ${userCode}\nWaiting for authentication...`,
      ),
      openUrl: (url) => openBrowser(url, noBrowser),
      showProgress: (message) => terminal.notify(message),
      ...(signal === undefined ? {} : { signal }),
      fetch: runtime.network.fetch,
    });
    await runtime.auth.storeCredential(provider, credential, storeOptions);
    return provider;
  }
  if (method.kind === "oauth") {
    const credential = await authorizeOAuthRegistration(runtime.auth.registration(method.registrationId), binding.credentialId, {
      showAuthorization: ({ url, userCode }) => terminal.notify(userCode === undefined
        ? `Open this URL to sign in:\n${url.toString()}`
        : `Open ${url.toString()} and enter code ${userCode}`),
      openUrl: (url) => openBrowser(url, noBrowser),
      requestManualAuthorization: async (_authorization, manualSignal) => {
        const value = (await terminal.question(
          "Paste the callback URL or authorization code, or press Enter to keep waiting: ",
          manualSignal,
        )).trim();
        return value === "" ? undefined : value;
      },
      ...(signal === undefined ? {} : { signal }),
      fetch: runtime.network.fetch,
    });
    await runtime.auth.storeCredential(provider, credential, storeOptions);
    return provider;
  }
  const secret = await terminal.readSecret(`${provider} ${method.kind === "api_key" ? "API key" : "bearer token"}: `);
  if (secret === "") throw new Error("Credential is empty");
  defaultSecretRedactor.register(secret);
  await runtime.auth.storeCredential(provider, method.kind === "api_key"
    ? { kind: "api_key", provider: binding.credentialId, apiKey: secret }
    : { kind: "bearer", provider: binding.credentialId, accessToken: secret }, storeOptions);
  return provider;
}

function runFailureMessage(cause: unknown, provider: string): string {
  const message = cause instanceof Error
    ? cause.message
    : cause !== null && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
      ? cause.message
      : String(cause);
  if (/(?:no credential|api key|access token|unauthori[sz]ed|authentication|default credentials|application default credentials)/iu.test(message)) {
    return `${provider} is not connected. Run /login ${provider}.`;
  }
  return message;
}

function skillInvocation(skill: SkillMetadata, instructions: string, argumentsText: string): string {
  const name = skill.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const location = skill.manifestPath.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return [
    `<skill name="${name}" location="${location}">`,
    `References are relative to ${skill.directory}.`,
    instructions,
    "</skill>",
    argumentsText,
  ].filter((value, index) => index < 4 || value !== "").join("\n");
}

async function expandOneShotSubmission(
  message: string,
  runtime: LoadedRuntime,
  threadId: string,
  branch: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!message.startsWith("/")) return message;
  if (message.startsWith("/prompt ")) {
    const [id, ...input] = message.slice(8).trim().split(/\s+/u);
    const prompt = id === undefined || id === "" ? undefined : runtime.extensions.prompt(id);
    return prompt === undefined ? message : renderExtensionPrompt(prompt, input.join(" "));
  }
  if (message.startsWith("/skill:")) {
    const separator = message.indexOf(" ");
    const name = message.slice(7, separator < 0 ? undefined : separator);
    const skill = runtime.service.skills.find((entry) => entry.name === name);
    if (skill === undefined) return message;
    const loaded = await loadSkill(skill);
    return skillInvocation(skill, loaded.instructions, separator < 0 ? "" : message.slice(separator + 1));
  }

  const separator = message.indexOf(" ");
  const name = message.slice(1, separator < 0 ? undefined : separator);
  const args = separator < 0 ? "" : message.slice(separator + 1);
  const runtimeCommand = runtime.runtimeExtensions.commands().find((command) => command.name === name);
  if (runtimeCommand !== undefined) {
    const before = runtime.runtimeExtensions.diagnostics().length;
    const result = await runtime.runtimeExtensions.runCommand(name, {
      args,
      threadId,
      ...(branch === undefined ? {} : { branch }),
      signal,
    });
    for (const diagnostic of runtime.runtimeExtensions.diagnostics().slice(before)) {
      process.stderr.write(`Extension ${diagnostic.extensionId}: ${diagnostic.message}\n`);
    }
    return result.handled ? result.prompt : message;
  }
  const command = runtime.extensions.command(name);
  if (command !== undefined) return renderExtensionCommand(command, args);
  const prompt = runtime.extensions.prompt(name);
  return prompt === undefined ? message : renderExtensionPrompt(prompt, args);
}

function runtimeUi(
  terminal: TuiController,
  extensionId: string,
  lifecycleSignal?: AbortSignal,
  interactionSignal = lifecycleSignal,
): RuntimeCommandUi {
  const resourceKey = (key: string) => `${extensionId}:${key}`;
  const current = (): void => {
    if (lifecycleSignal?.aborted === true) throw new Error(`Extension UI context is no longer active: ${extensionId}`);
  };
  const combinedSignal = (signal?: AbortSignal): AbortSignal | undefined => interactionSignal === undefined
    ? signal
    : signal === undefined
      ? interactionSignal
      : AbortSignal.any([interactionSignal, signal]);
  const cancelled = (cause: unknown, signal?: AbortSignal): boolean => cause instanceof TuiSelectionCancelledError
    || signal?.aborted === true
    || (cause instanceof Error && cause.name === "AbortError");
  return {
    notify: (message, kind = "status") => { current(); terminal.notify(message, kind); },
    setStatus: (key, value) => { current(); terminal.setExtensionStatus(resourceKey(key), value); },
    setWidget: (key, value) => { current(); terminal.setExtensionWidget(resourceKey(key), value); },
    setHeader: (key, value) => { current(); terminal.setExtensionHeader(resourceKey(key), value); },
    setFooter: (key, value) => { current(); terminal.setExtensionFooter(resourceKey(key), value); },
    setWorkingMessage: (value) => { current(); terminal.setExtensionWorkingMessage(extensionId, value); },
    setWorkingVisible: (visible) => { current(); terminal.setExtensionWorkingVisible(extensionId, visible); },
    setTitle: (value) => { current(); terminal.setTitle(value); },
    getTheme: async (signal) => {
      current();
      combinedSignal(signal)?.throwIfAborted();
      return { name: terminal.selectedThemeName(), available: terminal.themeNames() };
    },
    setTheme: async (name, signal) => {
      current();
      combinedSignal(signal)?.throwIfAborted();
      terminal.setTheme(name);
      return { name: terminal.selectedThemeName(), available: terminal.themeNames() };
    },
    select: async (prompt, options, signal) => {
      current();
      return await terminal.choose(prompt, options.map((option) => ({ ...option })), combinedSignal(signal));
    },
    confirm: async (title, message, signal) => {
      current();
      const combined = combinedSignal(signal);
      try {
        return await terminal.choose(`${title}: ${message}`, [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ], combined);
      } catch (cause) {
        if (cancelled(cause, combined)) return false;
        throw cause;
      }
    },
    input: async (title, placeholder, signal) => {
      current();
      const combined = combinedSignal(signal);
      try {
        return await terminal.requestInput(title, placeholder, combined);
      } catch (cause) {
        if (cancelled(cause, combined)) return undefined;
        throw cause;
      }
    },
    editor: async (title, prefill, signal) => {
      current();
      const combined = combinedSignal(signal);
      try {
        return await terminal.editor(title, prefill, combined);
      } catch (cause) {
        if (cancelled(cause, combined)) return undefined;
        throw cause;
      }
    },
    setEditorText: (value) => { current(); terminal.setEditorText(value); },
    getEditorText: () => { current(); return terminal.getEditorText(); },
    custom: async (factory, options, signal) => {
      current();
      const combined = combinedSignal(signal);
      return await terminal.custom(factory, options, combined);
    },
    showOverlay: (factory, options, signal) => {
      current();
      const combined = combinedSignal(signal);
      return terminal.showOverlay(factory, options, combined);
    },
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

async function chatCommand(argumentsValue: ParsedArguments): Promise<void> {
  await withGracefulTermination(async (termination) => await chatCommandOperation(argumentsValue, termination));
}

async function chatCommandOperation(
  argumentsValue: ParsedArguments,
  termination: GracefulTerminationContext,
): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("chat requires an interactive terminal; use run for pipes");
  projectTrustOverride(argumentsValue);
  const ephemeral = flagBoolean(argumentsValue, "no-session");
  const startupAllWorkspaces = flagBoolean(argumentsValue, "all");
  if (ephemeral && (flagString(argumentsValue, "thread") !== undefined || flagString(argumentsValue, "session") !== undefined || flagString(argumentsValue, "session-id") !== undefined || flagString(argumentsValue, "fork") !== undefined || flagBoolean(argumentsValue, "continue") || flagBoolean(argumentsValue, "resume") || flagString(argumentsValue, "name") !== undefined)) {
    throw new Error("--no-session cannot be combined with --fork, --thread, --session, --session-id, --continue, --resume, or --name");
  }
  if (startupAllWorkspaces && ephemeral) throw new Error("--all cannot be combined with --no-session");
  if (startupAllWorkspaces && flagString(argumentsValue, "fork") !== undefined) throw new Error("--fork cannot be combined with --all");
  const ephemeralThreads = new Set<string>();

  const paths = harnessPaths();
  const keybindingsPath = join(paths.configDirectory, "keybindings.json");
  let keybindings: Keybindings;
  let keybindingsWarning: string | undefined;
  try {
    keybindings = await loadKeybindings(keybindingsPath);
    const conflicts = keybindings.conflicts();
    if (conflicts.length > 0) {
      keybindingsWarning = `Keybinding conflicts: ${conflicts.map((entry) => `${entry.key} in ${entry.scope} (${entry.actions.join(", ")})`).join("; ")}`;
    }
  } catch (error) {
    keybindings = new Keybindings();
    keybindingsWarning = `Keybindings ignored: ${error instanceof Error ? error.message : String(error)}`;
  }
  let handleAction: ((action: TuiAction) => void) | undefined;
  const pendingStartupActions: TuiAction[] = [];
  const pendingStartupSubmissions: Array<{
    text: string;
    images: TuiInputImageAttachment[];
    recoveredImages: ImageBlock[];
    recoveredQueueDraft: boolean;
  }> = [];
  const deferredSubmissions = new BoundedDeferredSubmissionQueue<TuiInputImageAttachment>(attachmentStorageBytes);
  let startupActionOverflow = false;
  const terminal = new TuiController({
    handleSignals: false,
    keybindings,
    onAction: (action) => {
      if (handleAction !== undefined) {
        handleAction(action);
        return;
      }
      if (pendingStartupActions.length < 64) pendingStartupActions.push(action);
      else startupActionOverflow = true;
    },
  });
  let uninstallEmergencyRecovery: (() => void) | undefined;
  const projectTrust = projectTrustResolver(argumentsValue, paths, terminal);
  if (keybindingsWarning !== undefined) terminal.notify(keybindingsWarning, "warning");
  let runtime: LoadedRuntime | undefined;
  let startupPreviousRuntime: LoadedRuntime | undefined;
  let sessionIndex: WorkspaceSessionIndex | undefined;
  let sessionIndexTail: Promise<void> = Promise.resolve();
  let actionQueue = Promise.resolve();
  let inputDeliveryQueue = Promise.resolve();
  const catalogAbort = new AbortController();
  const catalogTasks = new Set<Promise<void>>();
  let modelRefreshAbort: AbortController | undefined;
  let modelRefreshTask: Promise<void> | undefined;
  let fileRefreshAbort: AbortController | undefined;
  let modelRefreshGeneration = 0;
  let acceptActions = true;
  let active = false;
  let shellAbort: AbortController | undefined;
  let branchSummaryAbort: AbortController | undefined;
  let authAbort: AbortController | undefined;
  let reloadAbort: AbortController | undefined;
  let activeRunAbort: AbortController | undefined;
  let extensionActionAbort: AbortController | undefined;
  let threadId = "";
  let branch: string | undefined;
  let extensionSession: { threadId: string; branch?: string } | undefined;
  let extensionSessionPublicationCleanup: (() => void) | undefined;
  let choice: ModelSelection | undefined;
  let autoSelectOnFirstCatalog = false;
  const modelCatalog = new Map<string, ModelInfo>();
  let thinking: ThinkingLevel = "off";
  let steeringMode: QueueMode = "one-at-a-time";
  let followUpMode: QueueMode = "one-at-a-time";
  let autoCompaction = true;
  let outboundImages: OutboundImagePolicy = "allow";
  let scopedModels: string[] = [];
  let doubleEscapeAction: "tree" | "fork" | "none" = "tree";
  let defaultProjectTrust: DefaultProjectTrust = "ask";
  let codexTransport: CodexTransportSetting = "auto";
  let providerRetryAttempts = 3;
  let promptOptions: SystemPromptCliOptions = {};
  let activeRuntimeShortcuts: Array<{ shortcut: string; description?: string }> = [];
  let activeSubmissionOrder = 0;
  let stagedQueueLease: RunInputQueueLease | undefined;
  let restoreQueueAfterCancellation = false;
  let draftScope = "";
  const announcedRecoveredQueues = new Set<string>();

  const scheduleSessionIndexUpdate = (selectedRuntime: LoadedRuntime, selectedThreadId: string): void => {
    const update = sessionIndexTail.then(async () => {
      await upsertIndexedThread(sessionIndex, selectedRuntime, selectedThreadId);
    });
    sessionIndexTail = update.catch((error: unknown) => {
      try {
        terminal.notify(`Session index update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      } catch {}
    });
  };

  const persistSelection = async (selection: ModelSelection): Promise<void> => {
    await sessionIndexTail;
    await persistInteractiveModelSelection(runtime!, threadId, branch, {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: thinking,
    });
    if (!ephemeral) scheduleSessionIndexUpdate(runtime!, threadId);
  };

  const restoreStoredSelection = (selection: ModelSelection | undefined): void => {
    thinking = thinkingLevel(
      flagString(argumentsValue, "thinking") ?? selection?.reasoningEffort ?? runtime!.config.thinking,
    );
    choice = selection === undefined
      ? undefined
      : { provider: selection.provider, model: selection.model };
  };

  const availableThinkingLevels = (): readonly ThinkingLevel[] => {
    if (choice === undefined) return THINKING_LEVELS;
    const model = modelCatalog.get(`${choice.provider}\u0000${choice.model}`);
    return thinkingLevelsForModel(model);
  };

  const ensureThinkingSupported = async (): Promise<void> => {
    const levels = availableThinkingLevels();
    if (levels.includes(thinking)) return;
    thinking = levels[0] ?? "off";
    if (runtime !== undefined) await persistUiPreferences(runtime.paths, { thinking });
    terminal.notify(
      levels.length === 0
        ? "The selected model reports no compatible harness thinking levels; provider-managed defaults will be used."
        : `The selected model does not support that thinking level; thinking was set to ${thinking}.`,
      "warning",
    );
  };

  const transitionExtensionSession = async (nextThreadId: string, nextBranch: string | undefined): Promise<void> => {
    if (runtime === undefined) return;
    if (extensionSession?.threadId === nextThreadId && extensionSession.branch === nextBranch) return;
    if (extensionSession !== undefined) {
      await runtime.runtimeExtensions.dispatch("session_end", {
        ...extensionSession,
        workspace: runtime.workspace,
      }).catch((error) => terminal.notify(`Extension session end failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
    }
    extensionSession = { threadId: nextThreadId, ...(nextBranch === undefined ? {} : { branch: nextBranch }) };
    await runtime.runtimeExtensions.dispatch("session_start", {
      threadId: nextThreadId,
      branch: nextBranch,
      workspace: runtime.workspace,
    }).catch((error) => terminal.notify(`Extension session start failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
  };

  const endExtensionSession = async (): Promise<void> => {
    if (runtime === undefined || extensionSession === undefined) return;
    const ending = extensionSession;
    extensionSession = undefined;
    await runtime.runtimeExtensions.dispatch("session_end", {
      ...ending,
      workspace: runtime.workspace,
    }).catch(() => undefined);
  };

  const stop = (signal: NodeJS.Signals): void => {
    catalogAbort.abort(new Error(`terminal interrupted by ${signal}`));
    shellAbort?.abort(new Error(`shell shortcut interrupted by ${signal}`));
    branchSummaryAbort?.abort(new Error(`branch summary interrupted by ${signal}`));
    authAbort?.abort(new Error(`authorization interrupted by ${signal}`));
    reloadAbort?.abort(new Error(`reload interrupted by ${signal}`));
    activeRunAbort?.abort(new Error(`run interrupted by ${signal}`));
    extensionActionAbort?.abort(new Error(`extension action interrupted by ${signal}`));
    if (active && runtime !== undefined && threadId !== "") {
      try {
        runtime.service.cancel(threadId, `interrupted by ${signal}`);
      } catch {}
    }
    terminal.close();
  };
  const uninstallTermination = termination.onTerminate(stop);

  try {
    termination.throwIfTerminated();
    uninstallEmergencyRecovery = installInteractiveEmergencyRecovery({
      restoreTerminal: () => terminal.close(),
    });
    const projectTrusted = await projectTrust.isTrusted(flagString(argumentsValue, "workspace") ?? process.cwd());
    runtime = await loadRuntime({
      ...runtimeOptions(argumentsValue),
      ...invocationExtensionOptions(argumentsValue),
      ...(projectTrusted ? { projectTrusted: true } : {}),
      ephemeral,
      extensionRuntime: true,
      recover: !startupAllWorkspaces,
    });
    runtime.setExtensionShutdownHandler(async (request) => {
      setImmediate(() => {
        if (active && threadId !== "") {
          try { runtime?.service.cancel(threadId, request.reason ?? `Shutdown requested by ${request.extensionId}`); } catch {}
        }
        terminal.close();
      });
      return {
        accepted: true,
        message: "The interactive host acknowledged graceful shutdown.",
      };
    });
    argumentsValue = applyRuntimeExtensionFlags(argumentsValue, runtime.runtimeExtensions);
    if (!ephemeral) {
      sessionIndex = await initializeSessionIndex(
        runtime,
        startupAllWorkspaces,
        (message) => terminal.notify(message, "warning"),
      );
    }
    if (startupAllWorkspaces) {
      if (sessionIndex === undefined) throw new Error("All-workspace session index is unavailable");
      const record = await requestedIndexedSession(sessionIndex, runtime, argumentsValue, terminal);
      if (currentIndexedRuntime(runtime, record)) {
        const verified = await sessionIndex.verify(record, { isTrusted: async () => true });
        threadId = runtime.store.bindThreadWorkspace(verified.threadId, runtime.workspace).threadId;
        await runtime.service.activateWorkspaceRuntime();
      } else {
        const prepared = await stageIndexedRuntime(record, runtime, sessionIndex, argumentsValue, terminal, projectTrust);
        const previousRuntime = runtime;
        let candidateArguments: ParsedArguments;
        try {
          candidateArguments = applyRuntimeExtensionFlags(argumentsValue, prepared.runtime.runtimeExtensions);
        } catch (error) {
          await prepared.rollback();
          throw error;
        }
        runtime = prepared.commit();
        threadId = prepared.target.thread.threadId;
        try {
          await runtime.service.activateWorkspaceRuntime();
        } catch (error) {
          const candidateRuntime = runtime;
          runtime = previousRuntime;
          try {
            await candidateRuntime.close();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Workspace activation and candidate cleanup failed");
          }
          throw error;
        }
        argumentsValue = candidateArguments;
        startupPreviousRuntime = previousRuntime;
        await refreshSessionIndex(sessionIndex, runtime);
      }
    } else {
      threadId = await resolveThread(runtime, argumentsValue, terminal)
        ?? (await runtime.service.createSession({ cwd: currentWorkspaceCwd(runtime.workspace) })).threadId;
    }
    promptOptions = await systemPromptCliOptions(argumentsValue, runtime.workspace);
    if (ephemeral) ephemeralThreads.add(threadId);
    const requestedName = flagString(argumentsValue, "name");
    if (requestedName !== undefined) {
      await runtime.service.setSessionName({ threadId, name: requestedName });
    }
    await upsertIndexedThread(sessionIndex, runtime, threadId);
    choice = configuredSelection(runtime, argumentsValue, threadId, startupBranch(argumentsValue));
    const explicitModel = flagString(argumentsValue, "model");
    const explicitProvider = flagString(argumentsValue, "provider");
    const explicitThinking = flagString(argumentsValue, "thinking");
    if (choice !== undefined) {
      const resolved = await resolveRequestedModel(runtime.providers, {
        reference: choice.model,
        ...(explicitProvider === undefined && explicitModel !== undefined ? {} : { provider: choice.provider }),
        fallbackProvider: choice.provider,
        ...((explicitThinking ?? choice.reasoningEffort) === undefined
          ? {}
          : { reasoningEffort: explicitThinking ?? choice.reasoningEffort }),
      }, AbortSignal.any([catalogAbort.signal, runtime.generationSignal, AbortSignal.timeout(30_000)]));
      choice = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      };
    }
    restoreStoredSelection(choice);
    autoSelectOnFirstCatalog = choice === undefined;
    steeringMode = runtime.config.steeringMode;
    followUpMode = runtime.config.followUpMode;
    autoCompaction = runtime.config.autoCompaction;
    outboundImages = outboundImageOverride(argumentsValue) ?? runtime.config.outboundImages;
    const configuredScope = flagString(argumentsValue, "models");
    scopedModels = configuredScope === undefined
      ? [...runtime.config.scopedModels]
      : parseModelScope(configuredScope);
    branch = startupBranch(argumentsValue);

    let sessionCatalogState: {
      scope: "current" | "all";
      query: string;
      cursor?: string;
      hasMore: boolean;
      loaded: number;
      searchBytes: number;
    } = { scope: "current", query: "", hasMore: false, loaded: 0, searchBytes: 0 };
    let sessionCatalogItems: PickerItem[] = [];
    const publishSessionPage = (
      page: SessionPickerPage,
      input: { scope: "current" | "all"; query: string; append: boolean },
    ): void => {
      const available = Math.max(0, SESSION_PICKER_MAX_LOADED - (input.append ? sessionCatalogState.loaded : 0));
      let remainingSearchBytes = Math.max(
        0,
        SESSION_SEARCH_TOTAL_BYTES - (input.append ? sessionCatalogState.searchBytes : 0),
      );
      let addedSearchBytes = 0;
      const additions = page.items.slice(0, available).map((item) => {
        const keywords = item.keywords?.join(" ") ?? "";
        if (keywords === "" || remainingSearchBytes === 0) {
          const { keywords: _keywords, ...withoutKeywords } = item;
          return withoutKeywords;
        }
        const selected = byteTruncate(keywords, remainingSearchBytes);
        const bytes = Buffer.byteLength(selected);
        remainingSearchBytes -= bytes;
        addedSearchBytes += bytes;
        return { ...item, keywords: [selected] };
      });
      if (input.append) terminal.addPickerItems("session", additions);
      else terminal.setPickerItems("session", additions);
      if (input.append) {
        const merged = new Map(sessionCatalogItems.map((item) => [item.id, item]));
        for (const item of additions) merged.set(item.id, item);
        sessionCatalogItems = [...merged.values()];
      } else sessionCatalogItems = additions;
      const loaded = (input.append ? sessionCatalogState.loaded : 0) + additions.length;
      const capped = loaded >= SESSION_PICKER_MAX_LOADED && page.hasMore;
      sessionCatalogState = {
        scope: input.scope,
        query: input.query,
        hasMore: page.hasMore && !capped,
        loaded,
        searchBytes: (input.append ? sessionCatalogState.searchBytes : 0) + addedSearchBytes,
        ...(page.nextCursor === undefined || capped ? {} : { cursor: page.nextCursor }),
      };
      terminal.setSessionPickerScope(input.scope);
      const noun = input.query.trim() === "" ? "session" : "matching session";
      const status = capped
        ? `Showing ${loaded} ${noun}${loaded === 1 ? "" : "s"}; refine the search to scan beyond the UI limit`
        : sessionCatalogState.hasMore
          ? `${loaded} ${noun}${loaded === 1 ? "" : "s"} loaded · Right loads the next page`
          : `${loaded} ${noun}${loaded === 1 ? "" : "s"} loaded · end of catalog`;
      terminal.setSessionPickerPagination(sessionCatalogState.hasMore, status);
    };
    const refreshSessions = (): void => {
      if (ephemeral) {
        sessionCatalogState = { scope: "current", query: "", hasMore: false, loaded: 0, searchBytes: 0 };
        sessionCatalogItems = [];
        terminal.setPickerItems("session", []);
        terminal.setSessionPickerPagination(false, "Session resume is unavailable in --no-session mode");
        return;
      }
      publishSessionPage(sessionPickerPage(runtime!, threadId), { scope: "current", query: "", append: false });
    };
    const scheduleModelRefresh = (): void => {
      modelRefreshAbort?.abort(new Error("Superseded model catalog refresh"));
      const refreshAbort = new AbortController();
      modelRefreshAbort = refreshAbort;
      const generation = ++modelRefreshGeneration;
      const signal = AbortSignal.any([catalogAbort.signal, runtime!.generationSignal, refreshAbort.signal]);
      const target = {
        setPickerItems<T>(kind: Exclude<PickerKind, "generic">, items: readonly PickerItem<T>[]): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.setPickerItems(kind, items);
        },
        addPickerItems<T>(kind: Exclude<PickerKind, "generic">, items: readonly PickerItem<T>[]): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.addPickerItems(kind, items);
        },
        addModelPickerItems<T>(all: readonly PickerItem<T>[], scoped?: readonly PickerItem<T>[]): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.addModelPickerItems(all, scoped);
        },
        setModelPickerLoading(loading: boolean): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.setModelPickerLoading(loading);
        },
        setModelCycleItems<T>(items: readonly PickerItem<T>[]): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.setModelCycleItems(items);
        },
        setModelPickerEmptyMessage(message?: string): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.setModelPickerEmptyMessage(message);
        },
        setModelPickerItems<T>(all: readonly PickerItem<T>[], scoped?: readonly PickerItem<T>[]): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.setModelPickerItems(all, scoped);
        },
        notify(message: string, level?: "status" | "warning" | "error"): void {
          if (generation === modelRefreshGeneration && !signal.aborted) terminal.notify(message, level);
        },
      };
      const task = refreshModelPicker(
        runtime!.providers.list(),
        target,
        choice,
        signal,
        scopedModels,
        runtime!.auth,
        (statuses) => target.setModelPickerEmptyMessage(modelCatalogEmptyMessage(statuses)),
        runtime!.providers,
        { refresh: !flagBoolean(argumentsValue, "offline") },
      ).then(async (models) => {
        if (generation !== modelRefreshGeneration || signal.aborted) return;
        modelCatalog.clear();
        for (const model of models) modelCatalog.set(`${model.provider}\u0000${model.id}`, model);
        let selectedAutomatically = false;
        if (autoSelectOnFirstCatalog && choice === undefined) {
          autoSelectOnFirstCatalog = false;
          const configuredDefault = runtime!.config.defaultProvider === undefined || runtime!.config.defaultModel === undefined
            ? undefined
            : { provider: runtime!.config.defaultProvider, model: runtime!.config.defaultModel };
          const selected = selectAutomaticModel(models, configuredDefault);
          if (selected !== undefined) {
            choice = selected;
            await ensureThinkingSupported();
            await persistSelection(selected);
            terminal.notify(`Model ${selected.provider}/${selected.model}`);
            selectedAutomatically = true;
          }
        }
        await ensureThinkingSupported();
        syncContext();
        if (selectedAutomatically) scheduleModelRefresh();
      });
      modelRefreshTask = task;
      catalogTasks.add(task);
      void task.then(
        () => {
          catalogTasks.delete(task);
          if (modelRefreshTask === task) modelRefreshTask = undefined;
        },
        () => {
          catalogTasks.delete(task);
          if (modelRefreshTask === task) modelRefreshTask = undefined;
        },
      );
    };
    const scheduleFileRefresh = (): void => {
      fileRefreshAbort?.abort(new Error("Superseded workspace file refresh"));
      const refreshAbort = new AbortController();
      fileRefreshAbort = refreshAbort;
      const signal = AbortSignal.any([catalogAbort.signal, runtime!.generationSignal, refreshAbort.signal]);
      const task = scanWorkspaceFiles(runtime!.workspace, { signal })
        .then((files) => {
          if (!signal.aborted) terminal.setPickerItems("file", files.map((path): PickerItem<string> => ({
            id: path,
            label: path,
            value: path,
          })));
        })
        .catch((error) => {
          if (!signal.aborted) terminal.notify(`File index unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
        });
      catalogTasks.add(task);
      void task.finally(() => catalogTasks.delete(task));
    };
    const replayTranscript = (): void => {
      terminal.clearTranscript();
      const selectedBranch = branch ?? runtime!.store.getThread(threadId).defaultBranch;
      for (const event of runtime!.store.listEvents(threadId, selectedBranch)) {
        if (event.event.type === "extension_state" || event.event.type === "extension_message") {
          terminal.renderExtensionSession(
            event as EventEnvelope<ExtensionStateEvent | ExtensionMessageEvent>,
            selectedBranch,
          );
        } else terminal.render(event);
      }
    };
    const syncContext = (options: { announceRecovered?: boolean } = {}): void => {
      if (choice === undefined) terminal.clearModelContext();
      runtime!.service.setRuntimeModelSelection({
        threadId,
        ...(branch === undefined ? {} : { branch }),
        ...(choice === undefined
          ? {}
          : {
              selection: {
                provider: choice.provider,
                model: choice.model,
                reasoningEffort: thinking,
              },
            }),
      });
      const sessionName = runtime!.store.getThread(threadId).name ?? "";
      const selectedModel = choice === undefined ? undefined : modelCatalog.get(`${choice.provider}\u0000${choice.model}`);
      const contextBudget = choice === undefined
        ? undefined
        : resolveEffectiveContextBudget(
            selectedModel,
            runtime!.config.contextTokenBudget === undefined
              ? {}
              : { contextTokenBudget: runtime!.config.contextTokenBudget },
          );
      const availableProviders = new Set([...modelCatalog.values()].map((model) => model.provider));
      if (availableProviders.size === 0 && choice !== undefined) availableProviders.add(choice.provider);
      terminal.setContext({
        threadId,
        sessionName,
        workspace: runtime!.workspace,
        ...(choice === undefined ? {} : { provider: choice.provider, model: choice.model }),
        ...(contextBudget === undefined ? {} : { contextWindowTokens: contextBudget.contextWindowTokens }),
        thinkingSupported: selectedModel?.capabilities.reasoning.value === "supported",
        autoCompaction,
        subscription: false,
        availableProviderCount: availableProviders.size,
        active,
        status: active ? "streaming" : "idle",
        thinking,
      });
      if (choice !== undefined) {
        const selectedProvider = choice.provider;
        const selectedModelId = choice.model;
        void runtime!.auth.state(selectedProvider).then((state) => {
          if (choice?.provider === selectedProvider && choice.model === selectedModelId) {
            terminal.setContext({ subscription: state.kind === "oauth" });
          }
        }).catch(() => {});
      }
      const nextDraftScope = indexedSessionReference({ databasePath: runtime!.databasePath, threadId });
      if (nextDraftScope !== draftScope) {
        terminal.setDraftScope(nextDraftScope);
        draftScope = nextDraftScope;
      }
      terminal.setQueuedMessages(runtime!.service.queuedMessages(threadId, branch));
      if (options.announceRecovered !== false) {
        const recovered = runtime!.service.recoverableMessageCount(threadId, branch);
        const recoveryKey = `${threadId}\u0000${branch ?? ""}`;
        if (recovered > 0 && !announcedRecoveredQueues.has(recoveryKey)) {
          announcedRecoveredQueues.add(recoveryKey);
          terminal.notify(
            `Recovered ${recovered} unsent queued message${recovered === 1 ? "" : "s"}; press Alt+Up to restore ${recovered === 1 ? "it" : "them"}. They will not be sent automatically.`,
            "warning",
          );
        }
      }
    };
    const connectProvider = async (requested?: string): Promise<void> => {
      const controller = new AbortController();
      authAbort = controller;
      terminal.setInterruptHandler(() => controller.abort(new Error("authorization cancelled from terminal")));
      if (terminal.mode === "full") terminal.setTransientStatus("Connecting provider… Esc cancels");
      try {
        const provider = await loginInteractively(
          runtime!,
          terminal,
          requested,
          AbortSignal.any([catalogAbort.signal, runtime!.generationSignal, controller.signal]),
          flagBoolean(argumentsValue, "no-browser"),
        );
        for (const affected of runtime!.auth.affectedProviders(provider)) {
          runtime!.providers.invalidateModels(affected);
          for (const key of modelCatalog.keys()) if (key.startsWith(`${affected}\u0000`)) modelCatalog.delete(key);
        }
        let selectedAfterLogin: ModelSelection | undefined;
        let defaultSelectionError: unknown;
        if (choice === undefined) {
          try {
            const models = await runtime!.providers.listModels(
              provider,
              AbortSignal.any([catalogAbort.signal, runtime!.generationSignal, controller.signal, AbortSignal.timeout(30_000)]),
              { refresh: true },
            );
            for (const model of models) modelCatalog.set(`${model.provider}\u0000${model.id}`, model);
            const configuredDefault = runtime!.config.defaultProvider === provider && runtime!.config.defaultModel !== undefined
              ? { provider, model: runtime!.config.defaultModel }
              : undefined;
            selectedAfterLogin = selectDefaultModelAfterLogin(provider, models, configuredDefault, choice);
            if (selectedAfterLogin !== undefined) {
              choice = selectedAfterLogin;
              await ensureThinkingSupported();
              await persistSelection(selectedAfterLogin);
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            defaultSelectionError = error;
          }
        }
        syncContext();
        scheduleModelRefresh();
        const authState = await runtime!.auth.state(provider);
        const connected = `Connected ${provider}${authState.source === undefined ? "" : ` via ${authState.source}`}`;
        if (selectedAfterLogin !== undefined) {
          terminal.notify(`${connected} · model ${selectedAfterLogin.model}`);
        } else if (defaultSelectionError !== undefined) {
          terminal.notify(`${connected}. Could not load its default model: ${defaultSelectionError instanceof Error ? defaultSelectionError.message : String(defaultSelectionError)}. Use /model or Ctrl+L.`, "warning");
        } else if (choice === undefined) {
          terminal.notify(`${connected}. Use /model or Ctrl+L to choose a model.`);
        } else {
          terminal.notify(`${connected} · kept model ${choice.provider}/${choice.model}`);
        }
      } catch (error) {
        if (controller.signal.aborted) throw new TuiSelectionCancelledError();
        throw error;
      } finally {
        if (authAbort === controller) authAbort = undefined;
        terminal.setInterruptHandler(undefined);
        if (terminal.mode === "full") terminal.setTransientStatus();
      }
    };
    const restoreQueuedMessages = (): number => {
      if (stagedQueueLease !== undefined) {
        terminal.notify("A recovered queue item is already in the editor; submit or clear it before restoring another.", "warning");
        return 0;
      }
      const pending = runtime!.service.queuedMessages(threadId, branch);
      const next = pending[0];
      if (next === undefined) return 0;
      try {
        terminal.assertQueuedMessagesRestorable([next]);
      } catch (error) {
        terminal.notify(error instanceof Error ? error.message : String(error), "warning");
        return 0;
      }
      const lease = runtime!.service.leaseOne(threadId, branch);
      if (lease === undefined) return 0;
      let restored: number;
      try {
        restored = terminal.restoreQueuedMessages([lease.message]);
      } catch (error) {
        runtime!.service.releaseQueueLease(lease);
        throw error;
      }
      stagedQueueLease = lease;
      if (runtime!.service.recoverableMessageCount(threadId, branch) === 0) {
        announcedRecoveredQueues.delete(`${threadId}\u0000${branch ?? ""}`);
      }
      terminal.setQueuedMessages(runtime!.service.queuedMessages(threadId, branch));
      return restored;
    };
    const restoreInteractiveSubmission = (
      text: string,
      attachments: readonly TuiInputImageAttachment[],
      recoveredImages: readonly ImageBlock[] = [],
      recoveredQueueDraft = false,
    ): void => {
      const current = terminal.getEditorText();
      terminal.setEditorText([text, current].filter((entry) => entry.trim() !== "").join("\n\n"));
      for (const image of attachments) {
        try {
          terminal.attachInputImage(image);
        } catch (error) {
          terminal.notify(`Could not restore deferred image attachment: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
      if (recoveredImages.length > 0 || recoveredQueueDraft) {
        try {
          terminal.restoreQueuedMessages([{ mode: "steer", text: "", images: recoveredImages }]);
        } catch (error) {
          terminal.notify(`Could not restore recovered image payload: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
    };
    const enqueueDeferredSubmission = (
      text: string,
      attachments: readonly TuiInputImageAttachment[],
      notice: string,
      order?: number,
    ): boolean => {
      const queued = deferredSubmissions.enqueue(text, attachments, order);
      if (!queued.accepted) {
        restoreInteractiveSubmission(text, attachments);
        terminal.notify(
          queued.reason === "items"
            ? "Deferred command queue is full; the submission was restored to the editor."
            : "Deferred command queue byte limit was reached; the submission was restored to the editor.",
          "warning",
        );
        return false;
      }
      terminal.notify(`${notice} (${queued.size} queued)`);
      return true;
    };

    const scopedPatterns = (selection: ScopedModelSelection): string[] => selection.mode === "all"
      ? []
      : selection.mode === "none"
        ? [SCOPED_MODELS_NONE]
        : selection.patterns;
    const applyScopedModels = (next: string[], announce = true): void => {
      scopedModels = [...next];
      const immediateCandidates: Array<{ provider: ProviderId; model: string; info?: ModelInfo }> = [...modelCatalog.values()]
        .filter((model) => model.provider !== "openai" || isAgentOpenAIModel(model.id))
        .map((info) => ({ provider: info.provider, model: info.id, info }));
      if (choice !== undefined && !immediateCandidates.some(
        (candidate) => candidate.provider === choice!.provider && candidate.model === choice!.model,
      )) {
        immediateCandidates.push({ provider: choice.provider, model: choice.model });
      }
      const immediateCycle = resolveModelsForScope(
        immediateCandidates,
        scopedModels,
        (candidate) => candidate.info === undefined ? undefined : modelReasoningEfforts(candidate.info),
      ).models.map((candidate) => {
        const item = modelPickerItem(candidate.provider, candidate.info ?? { id: candidate.model });
        return candidate.reasoningEffort === undefined
          ? item
          : {
              ...item,
              value: { ...item.value, reasoningEffort: candidate.reasoningEffort },
              detail: [item.detail, `thinking ${candidate.reasoningEffort}`].filter(Boolean).join(" · "),
            };
      });
      terminal.setModelCycleItems(immediateCycle);
      scheduleModelRefresh();
      if (!announce) return;
      terminal.notify(scopedModels.length === 0
        ? "Model cycling uses all available models"
        : scopedModels.length === 1 && scopedModels[0] === SCOPED_MODELS_NONE
          ? "Model cycling has no enabled models"
          : `Model cycling: ${scopedModels.join(", ")}`);
    };
    const configureScopedModels = async (requested?: string): Promise<void> => {
      let next: string[] | undefined;
      if (requested !== undefined) next = parseModelScope(requested);
      else if (terminal.mode !== "full") {
        const input = (await terminal.question("Model patterns (comma separated; empty/all = all, none = none): ")).trim();
        next = parseModelScope(input);
      } else {
        const pendingRefresh = modelRefreshTask;
        if (modelCatalog.size === 0 && pendingRefresh !== undefined) {
          await Promise.race([
            pendingRefresh.catch(() => undefined),
            new Promise<void>((resolveWait) => {
              const timer = setTimeout(resolveWait, 1_000);
              timer.unref();
            }),
          ]);
        }
        const available = new Map<string, { provider: string; model: string; displayName?: string; description?: string; contextTokens?: number }>();
        for (const model of modelCatalog.values()) {
          if (model.provider === "openai" && !isAgentOpenAIModel(model.id)) continue;
          available.set(`${model.provider}/${model.id}`, {
            provider: model.provider,
            model: model.id,
            ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(model.contextTokens === undefined ? {} : { contextTokens: model.contextTokens }),
          });
        }
        if (choice !== undefined) available.set(`${choice.provider}/${choice.model}`, { provider: choice.provider, model: choice.model });
        const models = [...available.values()]
          .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
          .slice(0, 100);
        if (models.length === 0) {
          terminal.notify("No model catalog is available; the current cycling scope was left unchanged. Connect a provider or use /scoped-models PATTERNS.", "warning");
          return;
        }
        const items = models.map((model): PickerItem<ScopedModelOption> => {
          const detail = [model.displayName, model.description, model.contextTokens === undefined ? undefined : `${model.contextTokens.toLocaleString()} context`]
            .filter((value): value is string => value !== undefined && value !== "").join(" · ");
          return {
            id: `scoped:${model.provider}/${model.model}`,
            label: `${model.provider} / ${model.model}`,
            value: { provider: model.provider, model: model.model },
            keywords: [model.provider, model.model, model.displayName ?? "", model.description ?? ""],
            ...(detail === "" ? {} : { detail }),
          };
        });
        let persistTail = Promise.resolve();
        try {
          await terminal.chooseScopedModels(items, {
            all: scopedModels.length === 0,
            selected: orderModelsForScope(models, scopedModels)
              .map((model) => `${model.provider}/${model.model}`),
            live: true,
            onChange: (selection) => applyScopedModels(scopedPatterns(selection), false),
            onSave: (selection) => {
              const saved = scopedPatterns(selection);
              applyScopedModels(saved, false);
              const pendingSave = persistTail.then(async () => {
                await persistUiPreferences(runtime!.paths, { scopedModels: saved });
              });
              persistTail = pendingSave.catch(() => undefined);
              return pendingSave;
            },
          });
        } finally {
          await persistTail;
        }
        return;
      }
      applyScopedModels(next);
      await persistUiPreferences(runtime!.paths, { scopedModels });
    };

    const bindRuntimePresentation = async (): Promise<{ summary: string[]; inventory: StartupInventory }> => {
      const bundle = runtime!.extensions.bundle();
      doubleEscapeAction = runtime!.config.doubleEscapeAction;
      defaultProjectTrust = parseHarnessConfig(resolveConfig({
        globalPath: runtime!.paths.globalConfig,
        projectTrusted: false,
      }).value).defaultProjectTrust;
      codexTransport = selectedCodexTransport(runtime!);
      providerRetryAttempts = runtime!.config.providerRetry.maxAttempts;
      terminal.setDoubleEscapeAction(doubleEscapeAction);
      terminal.clearExtensionUi();
      const rendererHost = runtime!.runtimeExtensions;
      const rendererSignal = runtime!.generationSignal;
      terminal.setToolRenderers({
        has: (name) => rendererHost.renderers().some((renderer) => renderer.kind === "tool" && renderer.key === name),
        renderCall: (name, view, context) => rendererHost.renderToolCall(name, view, context),
        renderResult: (name, view, context) => rendererHost.renderToolResult(name, view, context),
      }, rendererSignal);
      terminal.setSessionRenderers({
        renderState: (envelope, selectedBranch, context) => rendererHost.renderExtensionState({
          ...envelope.event,
          threadId: envelope.threadId,
          branch: selectedBranch,
          eventId: envelope.eventId,
          timestamp: envelope.timestamp,
        }, context),
        renderMessage: (envelope, selectedBranch, context) => rendererHost.renderExtensionMessage({
          ...envelope.event,
          threadId: envelope.threadId,
          branch: selectedBranch,
          eventId: envelope.eventId,
          timestamp: envelope.timestamp,
        }, context),
      }, rendererSignal);
      extensionSessionPublicationCleanup?.();
      const publicationService = runtime!.service;
      extensionSessionPublicationCleanup = publicationService.onExtensionSessionEvent((publication) => {
        if (runtime?.service !== publicationService) return;
        const focused = extensionSession;
        if (focused === undefined || publication.envelope.threadId !== focused.threadId) return;
        const selectedBranch = focused.branch ?? runtime.store.getThread(focused.threadId).defaultBranch;
        if (publication.branch !== selectedBranch) return;
        terminal.renderExtensionSession(publication.envelope, publication.branch);
      });
      const shortcutDiagnostics = new Set<string>();
      const bindRuntimeInputs = (): void => {
        const resolved = resolveRuntimeShortcuts(rendererHost.shortcuts(), keybindings);
        activeRuntimeShortcuts = resolved.shortcuts.map(({ shortcut, description }) => ({
          shortcut,
          ...(description === undefined ? {} : { description }),
        }));
        terminal.setExtensionShortcuts(activeRuntimeShortcuts, rendererSignal);
        terminal.setCommandCompletionProvider(
          async (name, prefix, signal) => await rendererHost.completeCommandArguments(name, prefix, signal),
          rendererSignal,
        );
        if (rendererHost.hasAutocompleteProviders()) {
          terminal.setAutocompleteProvider(
            async (text, cursor, signal) => await rendererHost.completeInput({ text, cursor }, signal),
            rendererSignal,
          );
        } else terminal.setAutocompleteProvider();
        if (rendererHost.hasEditorMiddleware()) {
          terminal.setEditorMiddleware(
            (event, snapshot) => rendererHost.handleEditorInput(event, snapshot),
            rendererSignal,
          );
        } else terminal.setEditorMiddleware();
        for (const diagnostic of resolved.diagnostics) {
          if (shortcutDiagnostics.has(diagnostic)) continue;
          shortcutDiagnostics.add(diagnostic);
          terminal.notify(diagnostic, "warning");
        }
      };
      bindRuntimeInputs();
      const commandItems = (): PickerItem<string>[] => [
        ...bundle.commands.map((command): PickerItem<string> => ({
          id: `extension-command:${command.extensionId}:${command.name}`,
          label: `/${command.name}`,
          value: `/${command.name}`,
          ...(command.description === undefined ? {} : { detail: command.description }),
          keywords: [command.extensionId, command.argumentHint ?? ""],
        })),
        ...bundle.prompts.map((prompt): PickerItem<string> => ({
          id: `extension-prompt:${prompt.extensionId}:${prompt.id}`,
          label: `/${prompt.id}`,
          value: `/${prompt.id}`,
          ...(prompt.description === undefined ? {} : { detail: prompt.description }),
          keywords: [prompt.extensionId, prompt.argumentHint ?? "", "prompt template"],
        })),
        ...runtime!.service.skills.map((skill): PickerItem<string> => ({
          id: `skill:${skill.name}`,
          label: `/skill:${skill.name}`,
          value: `/skill:${skill.name}`,
          ...(skill.description === "" ? {} : { detail: skill.description }),
          keywords: [skill.scope, skill.manifestPath],
        })),
        ...runtime!.runtimeExtensions.commands().map((command): PickerItem<string> => ({
          id: `runtime-command:${command.extensionId}:${command.name}`,
          label: `/${command.name}`,
          value: `/${command.name}`,
          ...(command.description === undefined ? {} : { detail: command.description }),
          keywords: [command.extensionId, command.argumentHint ?? "", command.sourcePath],
        })),
      ];
      terminal.setCommandItems(commandItems());
      rendererHost.onChange((change) => {
        if (change === "command") {
          terminal.setCommandItems(commandItems());
          bindRuntimeInputs();
        }
        else if (change === "shortcut" || change === "autocomplete" || change === "editor_middleware") bindRuntimeInputs();
        else if (change === "tool_renderer") terminal.setToolRenderers({
          has: (name) => rendererHost.renderers().some((renderer) => renderer.kind === "tool" && renderer.key === name),
          renderCall: (name, view, context) => rendererHost.renderToolCall(name, view, context),
          renderResult: (name, view, context) => rendererHost.renderToolResult(name, view, context),
        }, rendererSignal);
        else if (change === "session_renderer") terminal.setSessionRenderers({
          renderState: (envelope, selectedBranch, context) => rendererHost.renderExtensionState({
            ...envelope.event,
            threadId: envelope.threadId,
            branch: selectedBranch,
            eventId: envelope.eventId,
            timestamp: envelope.timestamp,
          }, context),
          renderMessage: (envelope, selectedBranch, context) => rendererHost.renderExtensionMessage({
            ...envelope.event,
            threadId: envelope.threadId,
            branch: selectedBranch,
            eventId: envelope.eventId,
            timestamp: envelope.timestamp,
          }, context),
        }, rendererSignal);
        else if (change === "provider" || change === "provider_auth") scheduleModelRefresh();
      });
      const selectedTheme = terminal.selectedThemeName();
      terminal.setCustomThemes(bundle.themes.map((theme) => theme.definition));
      const desiredTheme = runtime!.config.theme ?? selectedTheme;
      try {
        terminal.setTheme(desiredTheme);
      } catch {
        terminal.notify(`Configured theme ${desiredTheme} is unavailable; using dark.`, "warning");
        terminal.setTheme("dark");
        await persistUiTheme(runtime!.paths, "dark");
      }
      terminal.onThemeChange((change) => {
        void rendererHost.dispatch("theme_change", {
          previous: change.previous,
          current: change.current,
          available: [...change.available],
          reason: change.reason,
        }).catch(() => undefined);
      }, rendererSignal);
      for (const operation of runtime!.runtimeExtensions.initialUi()) applyRuntimeUi(terminal, operation);
      runtime!.runtimeExtensions.setUiHandler((operation) => applyRuntimeUi(terminal, operation));
      runtime!.runtimeExtensions.setInteractiveUiHandler((extensionId, signal) =>
        runtimeUi(terminal, extensionId, signal));
      runtime!.runtimeExtensions.setSessionFocusHandler(async (session, signal) => {
        signal.throwIfAborted();
        if (active) throw new Error("Wait for the active response to finish before switching sessions");
        runtime!.store.bindThreadWorkspace(session.threadId, runtime!.workspace);
        await transitionExtensionSession(session.threadId, session.branch);
        signal.throwIfAborted();
        threadId = session.threadId;
        branch = session.branch;
        restoreStoredSelection(session.model === undefined ? undefined : {
          provider: session.model.provider,
          model: session.model.model,
          ...(session.model.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: thinkingLevel(session.model.reasoningEffort) }),
        });
        replayTranscript();
        syncContext();
        refreshSessions();
        scheduleModelRefresh();
        if (!ephemeral) scheduleSessionIndexUpdate(runtime!, threadId);
        terminal.notify(`Switched to ${session.name ?? session.threadId}`);
      });
      runtime!.runtimeExtensions.setModelFocusHandler(async (target, selection, signal) => {
        signal.throwIfAborted();
        const selectedBranch = branch ?? runtime!.store.getThread(threadId).defaultBranch;
        const targetBranch = target.branch ?? runtime!.store.getThread(target.threadId).defaultBranch;
        if (target.threadId !== threadId || targetBranch !== selectedBranch) return;
        choice = { provider: selection.provider, model: selection.model };
        thinking = thinkingLevel(selection.reasoningEffort ?? "off");
        await ensureThinkingSupported();
        syncContext();
        scheduleModelRefresh();
      });
      runtime!.runtimeExtensions.setReloadHandler(async (input) => {
        const controller = new AbortController();
        reloadAbort = controller;
        terminal.setInterruptHandler(() => controller.abort(new Error("reload cancelled from terminal")));
        terminal.setInputBlocked("Reloading keybindings, extensions, skills, prompts, themes, context, and providers...", "reload");
        let completed = false;
        let reloadWarnings: string[] = [];
        let reloadedSummary: string[] = [];
        try {
          const nextKeybindings = await loadKeybindings(keybindingsPath);
          const nextKeybindingConflicts = nextKeybindings.conflicts();
          let reloadedArguments: ParsedArguments | undefined;
          const signal = input.signal === undefined
            ? AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
            : AbortSignal.any([input.signal, controller.signal]);
          const result = await runtime!.reload({
            session: input.session ?? { threadId, ...(branch === undefined ? {} : { branch }) },
            signal,
            prepareExtensions: (extensions) => {
              reloadedArguments = applyRuntimeExtensionFlags(argumentsValue, extensions);
            },
            onCommit: async () => {
              if (reloadedArguments !== undefined) argumentsValue = reloadedArguments;
              terminal.setKeybindings(nextKeybindings);
              keybindings = nextKeybindings;
              thinking = thinkingLevel(flagString(argumentsValue, "thinking") ?? runtime!.config.thinking);
              steeringMode = runtime!.config.steeringMode;
              followUpMode = runtime!.config.followUpMode;
              autoCompaction = runtime!.config.autoCompaction;
              outboundImages = outboundImageOverride(argumentsValue) ?? runtime!.config.outboundImages;
              const configuredModels = flagString(argumentsValue, "models");
              scopedModels = configuredModels === undefined
                ? [...runtime!.config.scopedModels]
                : parseModelScope(configuredModels);
              if (choice !== undefined && !runtime!.providers.has(choice.provider)) {
                choice = undefined;
                terminal.notify("The selected provider was removed by reload; select another model.", "warning");
              }
              modelCatalog.clear();
              modelRefreshAbort?.abort(new Error("Runtime resources reloaded"));
              fileRefreshAbort?.abort(new Error("Runtime resources reloaded"));
              replayTranscript();
              reloadedSummary = (await bindRuntimePresentation()).summary;
            },
          });
          reloadWarnings = [
            ...result.warnings,
            ...(nextKeybindingConflicts.length === 0
              ? []
              : [`Keybinding conflicts: ${nextKeybindingConflicts.map((entry) => `${entry.key} in ${entry.scope} (${entry.actions.join(", ")})`).join("; ")}`]),
          ];
          completed = true;
          return result;
        } finally {
          if (reloadAbort === controller) reloadAbort = undefined;
          terminal.setInterruptHandler(undefined);
          terminal.setInputBlocked();
          if (completed) {
            for (const warning of reloadWarnings) terminal.notify(warning, "warning");
            terminal.notify(`Reloaded keybindings, extensions, skills, prompts, themes, context, and providers${reloadedSummary.length === 0 ? "" : ` · ${reloadedSummary.join(" · ")}`}`);
          }
        }
      });
      for (const diagnostic of runtime!.runtimeExtensions.diagnostics()) {
        terminal.notify(`Extension ${diagnostic.extensionId}: ${diagnostic.message}`, "warning");
      }
      refreshSessions();
      scheduleFileRefresh();
      scheduleModelRefresh();
      syncContext();
      let contextInstructions: string[] = [];
      try {
        const instructions = await discoverInstructions({
          workspaceRoot: runtime!.workspace,
          cwd: runtime!.workspace,
          trusted: runtime!.trusted,
          userInstructionFile: join(runtime!.paths.configDirectory, "AGENTS.md"),
          ...(flagBoolean(argumentsValue, "no-context-files") ? { includeFiles: false } : {}),
        });
        contextInstructions = instructions.entries.map((entry) => displayContextInstruction(entry.source, runtime!.workspace));
      } catch (error) {
        terminal.notify(`Context inventory unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      return {
        summary: [
        bundle.prompts.length === 0 ? undefined : `${bundle.prompts.length} prompts`,
        bundle.commands.length + runtime!.runtimeExtensions.commands().length === 0
          ? undefined
          : `${bundle.commands.length + runtime!.runtimeExtensions.commands().length} commands`,
        runtime!.service.skills.length === 0 ? undefined : `${runtime!.service.skills.length} skills`,
        bundle.themes.length === 0 ? undefined : `${bundle.themes.length} themes`,
        ].filter((value): value is string => value !== undefined),
        inventory: {
          contextInstructions,
          extensions: [
            ...runtime!.extensions.list().filter((extension) => extension.status === "active").map((extension) => extension.id),
            ...runtime!.runtimeExtensions.extensions()
              .filter((entry) => !bundle.runtime.some((bundled) => bundled.sourcePath === entry.sourcePath))
              .map((entry) => runtimeExtensionLabel(entry.sourcePath)),
          ],
          skills: runtime!.service.skills.map((skill) => skill.name),
          promptsAndCommands: bundle.prompts.map((prompt) => `/${prompt.id}`),
          themes: bundle.themes.map((theme) => theme.name),
        },
      };
    };

    const requireAllWorkspaceIndex = async (): Promise<WorkspaceSessionIndex> => {
      await sessionIndexTail;
      if (sessionIndex === undefined) sessionIndex = await openSessionIndex(runtime!);
      await refreshSessionIndex(sessionIndex, runtime!);
      return sessionIndex;
    };

    const loadSessionCatalog = async (
      scope: "current" | "all",
      query: string,
      append: boolean,
    ): Promise<void> => {
      if (append && (
        !sessionCatalogState.hasMore || sessionCatalogState.scope !== scope || sessionCatalogState.query !== query
      )) return;
      const cursor = append ? sessionCatalogState.cursor : undefined;
      let page: SessionPickerPage;
      if (scope === "current") {
        page = sessionPickerPage(runtime!, threadId, { query, ...(cursor === undefined ? {} : { cursor }) });
      } else {
        await sessionIndexTail;
        const index = sessionIndex ?? await requireAllWorkspaceIndex();
        page = indexedSessionPickerPage(index, {
            workspaceRoot: runtime!.workspace,
            databasePath: runtime!.databasePath,
            threadId,
          }, { query, ...(cursor === undefined ? {} : { cursor }) });
      }
      publishSessionPage(page, { scope, query, append });
    };

    const resumeIndexedSession = async (record: IndexedSessionRecord): Promise<void> => {
      const index = await requireAllWorkspaceIndex();
      if (currentIndexedRuntime(runtime!, record)) {
        const verified = await index.verify(record, { isTrusted: async () => true });
        const resumed = runtime!.store.bindThreadWorkspace(verified.threadId, runtime!.workspace);
        const nextChoice = configuredSelection(runtime!, argumentsValue, resumed.threadId);
        const previousThreadId = threadId;
        await transitionExtensionSession(resumed.threadId, undefined);
        try {
          await removeEmptyThread(runtime!, previousThreadId, index);
        } catch (error) {
          terminal.notify(`Session index cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        threadId = resumed.threadId;
        branch = undefined;
        restoreStoredSelection(nextChoice);
        replayTranscript();
        syncContext();
        refreshSessions();
        scheduleModelRefresh();
        terminal.notify(`Resumed ${threadId}`);
        return;
      }
      if (active) throw new Error("Wait for the active response to finish before switching workspaces");
      if (stagedQueueLease !== undefined) {
        throw new Error("Submit or discard the restored queued message before switching workspaces");
      }
      if (deferredSubmissions.size > 0) {
        throw new Error("Wait for deferred submissions to finish before switching workspaces");
      }
      if (shellAbort !== undefined || branchSummaryAbort !== undefined || authAbort !== undefined || extensionActionAbort !== undefined) {
        throw new Error("Finish or cancel the current shell, extension, authorization, or summary operation before switching workspaces");
      }
      if (terminal.getEditorText().trim() !== "") {
        throw new Error("Submit or clear the current editor draft before switching workspaces");
      }
      const previousRuntime = runtime!;
      const previousThreadId = threadId;
      const previousExtensionSession = extensionSession;
      const previousArguments = argumentsValue;
      const previousPromptOptions = promptOptions;
      const previousBranch = branch;
      const previousChoice = choice;
      const previousThinking = thinking;
      const previousSteeringMode = steeringMode;
      const previousFollowUpMode = followUpMode;
      const previousAutoCompaction = autoCompaction;
      const previousOutboundImages = outboundImages;
      const previousScopedModels = [...scopedModels];
      const previousModelCatalog = new Map(modelCatalog);
      const prepared = await stageIndexedRuntime(record, previousRuntime, index, argumentsValue, terminal, projectTrust);
      let candidateArguments: ParsedArguments;
      let candidatePromptOptions: SystemPromptCliOptions;
      let candidateChoice: ModelSelection | undefined;
      try {
        candidateArguments = applyRuntimeExtensionFlags(argumentsValue, prepared.runtime.runtimeExtensions);
        candidatePromptOptions = await systemPromptCliOptions(candidateArguments, prepared.runtime.workspace);
        candidateChoice = configuredSelection(prepared.runtime, candidateArguments, prepared.target.thread.threadId);
      } catch (error) {
        await prepared.rollback();
        throw error;
      }

      runtime = prepared.commit();
      argumentsValue = candidateArguments;
      promptOptions = candidatePromptOptions;
      threadId = prepared.target.thread.threadId;
      branch = undefined;
      restoreStoredSelection(candidateChoice);
      steeringMode = runtime.config.steeringMode;
      followUpMode = runtime.config.followUpMode;
      autoCompaction = runtime.config.autoCompaction;
      outboundImages = outboundImageOverride(argumentsValue) ?? runtime.config.outboundImages;
      const configuredModels = flagString(argumentsValue, "models");
      scopedModels = configuredModels === undefined ? [...runtime.config.scopedModels] : parseModelScope(configuredModels);
      modelCatalog.clear();
      modelRefreshAbort?.abort(new Error("Workspace session switched"));
      fileRefreshAbort?.abort(new Error("Workspace session switched"));
      replayTranscript();
      try {
        await bindRuntimePresentation();
        await runtime.service.activateWorkspaceRuntime();
      } catch (error) {
        const candidateRuntime = runtime;
        const cleanupFailures: unknown[] = [];
        try {
          await candidateRuntime.close();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        runtime = previousRuntime;
        argumentsValue = previousArguments;
        promptOptions = previousPromptOptions;
        threadId = previousThreadId;
        branch = previousBranch;
        choice = previousChoice;
        thinking = previousThinking;
        steeringMode = previousSteeringMode;
        followUpMode = previousFollowUpMode;
        autoCompaction = previousAutoCompaction;
        outboundImages = previousOutboundImages;
        scopedModels = previousScopedModels;
        extensionSession = previousExtensionSession;
        modelCatalog.clear();
        for (const [key, value] of previousModelCatalog) modelCatalog.set(key, value);
        draftScope = "";
        try {
          replayTranscript();
          await bindRuntimePresentation();
        } catch (restoreError) {
          cleanupFailures.push(restoreError);
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError([error, ...cleanupFailures], "Workspace switch failed and presentation rollback was incomplete");
        }
        throw error;
      }
      if (previousExtensionSession !== undefined) {
        await previousRuntime.runtimeExtensions.dispatch("session_end", {
          ...previousExtensionSession,
          workspace: previousRuntime.workspace,
          reason: "resume",
        }).catch((error) => terminal.notify(
          `Extension session end failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        ));
      }
      extensionSession = { threadId };
      await runtime.runtimeExtensions.dispatch("session_start", {
        threadId,
        workspace: runtime.workspace,
        reason: "resume",
      }).catch((error) => terminal.notify(
        `Extension session start failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      ));
      try {
        await removeEmptyThread(previousRuntime, previousThreadId, index);
      } catch (error) {
        terminal.notify(`Previous session cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      try {
        await previousRuntime.close();
      } catch (error) {
        terminal.notify(`Previous workspace cleanup failed after session switch: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      try {
        await upsertIndexedThread(index, runtime, threadId);
      } catch (error) {
        terminal.notify(`Session index update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      replayTranscript();
      syncContext();
      refreshSessions();
      terminal.notify(`Resumed ${threadId} in ${runtime.workspace}`);
    };

    syncContext({ announceRecovered: false });
    refreshSessions();
    replayTranscript();
    syncContext();
    const presentation = await bindRuntimePresentation();
    await transitionExtensionSession(threadId, branch);
    if (startupPreviousRuntime !== undefined) {
      try {
        await startupPreviousRuntime.close();
      } catch (error) {
        terminal.notify(`Previous workspace cleanup failed after session switch: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      startupPreviousRuntime = undefined;
    }

    const reduceTuiInput = async (
      text: string,
      images: readonly ImageBlock[],
      delivery?: "steer" | "follow_up",
    ) => {
      const before = runtime!.runtimeExtensions.diagnostics().length;
      const result = await runtime!.runtimeExtensions.reduceInput({
        text,
        ...(images.length === 0 ? {} : { images: images.map((image) => ({ ...image })) }),
        source: "tui",
        ...(delivery === undefined ? {} : { delivery }),
      }, AbortSignal.any([catalogAbort.signal, runtime!.generationSignal]));
      for (const diagnostic of runtime!.runtimeExtensions.diagnostics().slice(before)) {
        terminal.notify(`Extension ${diagnostic.extensionId}: ${diagnostic.message}`, "warning");
      }
      return result;
    };

    const copyText = async (text: string, label: string): Promise<void> => {
      const backend = await copyToNativeClipboard(text);
      if (backend === undefined) terminal.copyToClipboard(text);
      terminal.notify(`Copied ${label}${backend === undefined ? " using terminal clipboard fallback" : ` via ${backend}`}`);
    };

    const copyLatestAssistant = async (): Promise<void> => {
      const text = latestAssistantText(runtime!.store.listEvents(threadId, branch));
      if (text === undefined) throw new Error("This session has no assistant text to copy");
      await copyText(text, "the last assistant message");
    };

    const runAction = async (action: TuiAction): Promise<void> => {
      if (action.type === "error") {
        terminal.notify(action.error.message, "error");
        return;
      }
      if (action.type === "queue_restore_discard") {
        if (stagedQueueLease !== undefined) {
          runtime!.service.releaseQueueLease(stagedQueueLease);
          stagedQueueLease = undefined;
          terminal.setQueuedMessages(runtime!.service.queuedMessages(threadId, branch));
          terminal.notify("Recovered queue item returned to the durable queue");
        }
        return;
      }
      if (action.type === "exit") {
        if (active) runtime!.service.cancel(threadId, "terminal closed");
        await terminal.drainInput();
        terminal.close();
        return;
      }
      if (action.type === "suspend") {
        await terminal.drainInput();
        terminal.suspend();
        return;
      }
      if (action.type === "submit" || action.type === "steer" || action.type === "follow_up") {
        const images = action.images ?? [];
        const recoveredImages = action.recoveredImages ?? [];
        if (recoveredImages.length > 0 || action.recoveredQueueDraft === true) {
          restoreInteractiveSubmission(action.text, images, recoveredImages, action.recoveredQueueDraft === true);
          terminal.notify("Input received while another command was finishing; it was restored to the editor.", "warning");
          return;
        }
        enqueueDeferredSubmission(
          action.text,
          images,
          "Input received while another command was finishing",
        );
        return;
      }
      if (action.type === "cancel" || (action.type === "command" && action.item.value === "/cancel")) {
        if (extensionActionAbort !== undefined) {
          extensionActionAbort.abort(new Error("extension action cancelled from terminal"));
          return;
        }
        if (shellAbort !== undefined) {
          shellAbort.abort(new Error("shell shortcut cancelled from terminal"));
          return;
        }
        if (branchSummaryAbort !== undefined) {
          branchSummaryAbort.abort(new Error("branch summary cancelled from terminal"));
          return;
        }
        if (active) {
          restoreQueueAfterCancellation = true;
          runtime!.service.cancel(threadId, "cancelled from terminal");
          activeRunAbort?.abort(new Error("run cancelled from terminal"));
        }
        return;
      }
      if (action.type === "dequeue") {
        const restored = restoreQueuedMessages();
        terminal.notify(restored === 0 ? "No queued messages" : `Restored ${restored} queued message${restored === 1 ? "" : "s"} to the editor`);
        return;
      }
      if (action.type === "cycle_thinking") {
        const levels = availableThinkingLevels();
        if (levels.length === 0) {
          terminal.notify("The selected model reports no compatible harness thinking levels.", "warning");
          return;
        }
        thinking = levels[(levels.indexOf(thinking) + 1) % levels.length] ?? "off";
        await persistUiPreferences(runtime!.paths, { thinking });
        if (choice !== undefined) await persistSelection(choice);
        syncContext();
        terminal.notify(`Thinking ${thinking}`);
        return;
      }
      if (action.type === "extension_shortcut") {
        if (action.generation !== runtime!.generationSignal || action.generation.aborted) return;
        if (extensionActionAbort !== undefined) {
          terminal.notify("Another extension action is still running; press Esc to cancel it.", "warning");
          return;
        }
        const selected = runtime!.runtimeExtensions.shortcuts().find((shortcut) => shortcut.shortcut === action.shortcut);
        if (selected === undefined) return;
        const before = runtime!.runtimeExtensions.diagnostics().length;
        const controller = new AbortController();
        extensionActionAbort = controller;
        terminal.setInterruptHandler(() => controller.abort(new Error("extension shortcut cancelled from terminal")));
        try {
          await runtime!.runtimeExtensions.runShortcut(action.shortcut, {
            threadId,
            ...(branch === undefined ? {} : { branch }),
            signal: AbortSignal.any([catalogAbort.signal, runtime!.generationSignal, controller.signal]),
            ui: runtimeUi(terminal, selected.extensionId, runtime!.generationSignal),
          });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          if (extensionActionAbort === controller) {
            extensionActionAbort = undefined;
            terminal.setInterruptHandler(undefined);
          }
          for (const diagnostic of runtime!.runtimeExtensions.diagnostics().slice(before)) {
            terminal.notify(`Extension ${diagnostic.extensionId}: ${diagnostic.message}`, "warning");
          }
        }
        return;
      }
      if (action.type === "paste_image") {
        await pasteClipboardImage(terminal, catalogAbort.signal);
        return;
      }
      if (action.type === "copy") {
        await copyLatestAssistant();
        return;
      }
      if (action.type === "copy_text") {
        await copyText(action.text, action.label);
        return;
      }
      if (action.type === "session_scope") {
        if (ephemeral) {
          terminal.setSessionPickerScope("current", "Session resume is unavailable in --no-session mode");
          return;
        }
        try {
          await loadSessionCatalog(action.scope, "", false);
        } catch (error) {
          terminal.setSessionPickerScope("current", `Could not load all workspaces: ${error instanceof Error ? error.message : String(error)}`);
          publishSessionPage(sessionPickerPage(runtime!, threadId), { scope: "current", query: "", append: false });
        }
        return;
      }
      if (action.type === "session_search" || action.type === "session_more") {
        if (ephemeral) {
          terminal.setSessionPickerPagination(false, "Session resume is unavailable in --no-session mode");
          return;
        }
        try {
          await loadSessionCatalog(action.scope, action.query, action.type === "session_more");
        } catch (error) {
          terminal.setSessionPickerPagination(
            sessionCatalogState.hasMore,
            `Could not load sessions: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      if (action.type === "session_rename" || action.type === "session_delete") {
        await sessionIndexTail;
        if (action.scope !== sessionCatalogState.scope || action.query !== sessionCatalogState.query) {
          terminal.setPickerStatus("session", "Session results changed; select the session again");
          return;
        }
        const selectedById = sessionCatalogItems.find((item) =>
          typeof action.item.value === "string" && item.value === action.item.value);
        const selectedItem = selectedById;
        if (selectedItem === undefined || typeof selectedItem.value !== "string" || selectedItem.value === "") {
          terminal.setPickerStatus("session", "Session results changed; select the session again");
          return;
        }
        if (selectedItem.session?.path === selectedItem.value) {
          terminal.setPickerStatus("session", "Resume this session first; rename and delete are available in the current-workspace picker");
          return;
        }
        const selectedThreadId = selectedItem.value;
        try {
          runtime!.store.bindThreadWorkspace(selectedThreadId, runtime!.workspace);
          if (action.type === "session_rename") {
            const renamed = await runtime!.service.setSessionName({ threadId: selectedThreadId, name: action.name });
            await upsertIndexedThread(sessionIndex, runtime!, selectedThreadId);
            await loadSessionCatalog("current", sessionCatalogState.scope === "current" ? sessionCatalogState.query : "", false);
            if (selectedThreadId === threadId) syncContext();
            terminal.setPickerStatus("session", `Renamed session to ${renamed.name ?? renamed.threadId}`);
            return;
          }
          if (selectedThreadId === threadId) {
            await loadSessionCatalog("current", sessionCatalogState.scope === "current" ? sessionCatalogState.query : "", false);
            terminal.setPickerStatus("session", "The active session cannot be deleted");
            return;
          }
          const label = selectedItem.session?.name ?? selectedItem.label;
          await runtime!.service.deleteSession(selectedThreadId);
          await removeIndexedThread(sessionIndex, runtime!, selectedThreadId);
          await loadSessionCatalog("current", sessionCatalogState.scope === "current" ? sessionCatalogState.query : "", false);
          terminal.setPickerStatus("session", `Deleted session ${label}`);
        } catch (error) {
          try {
            await loadSessionCatalog("current", sessionCatalogState.scope === "current" ? sessionCatalogState.query : "", false);
          } catch {}
          terminal.setPickerStatus("session", error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (action.type !== "select") return;
      if (active) {
        terminal.notify("Wait for the active response to finish before switching context.", "warning");
        return;
      }
      if (action.picker === "model") {
        const selected = action.item.value;
        if (selected === null || typeof selected !== "object"
          || !("provider" in selected) || typeof selected.provider !== "string" || selected.provider === ""
          || !("model" in selected) || typeof selected.model !== "string" || selected.model === "") return;
        const requestedThinking = "reasoningEffort" in selected && typeof selected.reasoningEffort === "string"
          ? selected.reasoningEffort
          : undefined;
        const resolved = await runtime!.service.resolveModelSelection(selected.model, {
          provider: selected.provider,
          refresh: false,
          ...(requestedThinking === undefined ? {} : { reasoningEffort: requestedThinking }),
          signal: AbortSignal.any([catalogAbort.signal, runtime!.generationSignal]),
        });
        choice = { provider: resolved.provider, model: resolved.model };
        if (resolved.reasoningEffort !== undefined) thinking = resolved.reasoningEffort;
        await ensureThinkingSupported();
        await persistSelection(choice);
        syncContext();
        scheduleModelRefresh();
        terminal.notify(`Model ${choice.provider}/${choice.model}`);
        return;
      }
      await sessionIndexTail;
      if (typeof action.item.value !== "string") return;
      if (action.item.session?.path === action.item.value) {
        const index = await requireAllWorkspaceIndex();
        await resumeIndexedSession(resolveIndexedSessionReference(index, action.item.value));
        return;
      }
      if (ephemeral) {
        terminal.notify("Session resume is disabled by --no-session.", "warning");
        return;
      }
      const nextThreadId = action.item.value;
      runtime!.store.bindThreadWorkspace(nextThreadId, runtime!.workspace);
      const nextChoice = configuredSelection(runtime!, argumentsValue, nextThreadId);
      const previousThreadId = threadId;
      await transitionExtensionSession(nextThreadId, undefined);
      try {
        await removeEmptyThread(runtime!, previousThreadId, sessionIndex);
      } catch (error) {
        terminal.notify(`Session index cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      threadId = nextThreadId;
      branch = undefined;
      restoreStoredSelection(nextChoice);
      replayTranscript();
      syncContext();
      refreshSessions();
      scheduleModelRefresh();
      terminal.notify(`Resumed ${threadId}`);
    };
    handleAction = (action) => {
      if (!acceptActions) return;
      if (reloadAbort !== undefined && (
        action.type === "cancel" ||
        (action.type === "command" && action.item.value === "/cancel") ||
        (action.type === "submit" && action.text.trim() === "/cancel")
      )) {
        reloadAbort.abort(new Error("reload cancelled from terminal"));
        return;
      }
      if (authAbort !== undefined && (
        action.type === "cancel" ||
        (action.type === "command" && action.item.value === "/cancel") ||
        (action.type === "submit" && action.text.trim() === "/cancel")
      )) {
        authAbort.abort(new Error("authorization cancelled from terminal"));
        return;
      }
      if (extensionActionAbort !== undefined && (
        action.type === "cancel" ||
        (action.type === "command" && action.item.value === "/cancel") ||
        (action.type === "submit" && action.text.trim() === "/cancel")
      )) {
        extensionActionAbort.abort(new Error("extension action cancelled from terminal"));
        return;
      }
      if (action.type === "paste_image") terminal.setInputBlocked("Reading clipboard…", "clipboard");
      actionQueue = actionQueue.then(() => runAction(action)).catch((error) => {
        if (!(error instanceof TuiSelectionCancelledError)) {
          try {
            terminal.notify(error instanceof Error ? error.message : String(error), "error");
          } catch {}
        }
      }).finally(() => {
        if (action.type === "paste_image") terminal.setInputBlocked();
      });
    };

    const initialArguments = [...argumentsValue.positionals];
    const initialReferences: string[] = [];
    while (initialArguments[0]?.startsWith("@") === true) {
      const reference = initialArguments.shift()!;
      const path = reference.slice(1);
      if (/\s/u.test(path)) {
        if (path.includes('"')) throw new Error("CLI @file paths containing both whitespace and quotes are not supported");
        initialReferences.push(`@"${path}"`);
      } else initialReferences.push(reference);
    }
    const firstInitialMessage = initialArguments.shift();
    const firstInitialSubmission = [...initialReferences, firstInitialMessage]
      .filter((value): value is string => value !== undefined && value !== "")
      .join("\n\n");
    for (const text of [firstInitialSubmission, ...initialArguments]) {
      if (text.trim() === "") continue;
      pendingStartupSubmissions.push({ text, images: [], recoveredImages: [], recoveredQueueDraft: false });
    }

    for (const action of pendingStartupActions.splice(0)) {
      if (action.type === "submit") {
        await actionQueue;
        pendingStartupSubmissions.push({
          text: action.text,
          images: [...(action.images ?? []), ...terminal.takePendingInputImages()],
          recoveredImages: [...(action.recoveredImages ?? []), ...terminal.takePendingRecoveredImages()],
          recoveredQueueDraft: action.recoveredQueueDraft === true,
        });
      } else {
        handleAction(action);
        await actionQueue;
      }
    }
    await actionQueue;
    if (startupActionOverflow) {
      terminal.notify("Some startup input was rejected after the 64-action safety limit", "warning");
    }

    terminal.setStartup(
      formatCompactStartupReport(keybindings, choice !== undefined, presentation.inventory),
      formatStartupReport(keybindings, choice !== undefined, presentation.inventory),
    );
    if (flagBoolean(argumentsValue, "verbose")) terminal.toggleTool();
    while (true) {
      let submission: string;
      let submittedImages: TuiInputImageAttachment[] = [];
      let submittedRecoveredImages: ImageBlock[] = [];
      let submittedRecoveredQueueDraft = false;
      let submittedQueueDraftText = "";
      let attachmentsConsumed = false;
      let recoveredImagesCommitted = false;
      try {
        const deferred = deferredSubmissions.shift();
        const pending = deferred === undefined
          ? pendingStartupSubmissions.shift()
          : { ...deferred, recoveredImages: [] as ImageBlock[], recoveredQueueDraft: false };
        if (pending === undefined) {
          submission = await terminal.question("you> ", undefined, { cancelable: false });
          submittedImages = terminal.takeSubmittedImages();
          submittedRecoveredImages = terminal.takeSubmittedRecoveredImages();
          submittedRecoveredQueueDraft = terminal.takeSubmittedRecoveredQueueDraft();
        } else {
          submission = pending.text;
          submittedImages = pending.images;
          submittedRecoveredImages = pending.recoveredImages;
          submittedRecoveredQueueDraft = pending.recoveredQueueDraft;
        }
      } catch {
        break;
      }
      await sessionIndexTail;
      const line = submission.trim();
      submittedQueueDraftText = submission;
      if (line === "" && submittedImages.length === 0 && submittedRecoveredImages.length === 0) continue;
      try {
      if (!submittedRecoveredQueueDraft) {
      if (line === "/exit" || line === "/quit") break;
      if (line.startsWith("!")) {
        const hidden = line.startsWith("!!");
        const command = line.slice(hidden ? 2 : 1).trim();
        const controller = new AbortController();
        const signal = AbortSignal.any([catalogAbort.signal, controller.signal]);
        shellAbort = controller;
        terminal.setSteering((steering) => {
          if (steering.trim() === "/cancel") controller.abort(new Error("shell shortcut cancelled from terminal"));
          else terminal.notify("A shell shortcut is still running; press Esc to cancel it.", "warning");
        });
        terminal.setTransientStatus(shellShortcutProgressStatus(command));
        try {
          const reduction = await runtime.runtimeExtensions.reduceBeforeUserShell({
            command,
            cwd: runtime.workspace,
            hidden,
          }, signal);
          signal.throwIfAborted();
          const boundary = await WorkspaceBoundary.create(runtime.workspace);
          const cwd = await boundary.readable(reduction.cwd);
          if (!(await stat(cwd)).isDirectory()) throw new Error(`Shell shortcut cwd is not a directory: ${reduction.cwd}`);
          signal.throwIfAborted();
          const selectedCommand = reduction.command;
          terminal.setTransientStatus(shellShortcutProgressStatus(selectedCommand));
          const result = reduction.action === "handled"
            ? reduction.result
            : await runShellShortcut(
              selectedCommand,
              cwd,
              signal,
              120_000,
              process.env,
              (progress) => terminal.setTransientStatus(shellShortcutProgressStatus(selectedCommand, progress)),
              runtime.config.shellPath,
            );
          signal.throwIfAborted();
          if (!hidden) {
            const envelope = runtime.store.appendEvent({
              threadId,
              ...(branch === undefined ? {} : { branch }),
              event: {
                type: "message_appended",
                message: {
                  id: createId("msg"),
                  role: "user",
                  content: [{ type: "text", text: `[User shell command]\n${result.text}` }],
                  createdAt: new Date().toISOString(),
                },
              },
            });
            terminal.render(envelope);
          }
          await runtime.runtimeExtensions.dispatch(
            "event",
            { type: "user_shell", command: selectedCommand, hidden, result },
            signal,
          ).catch((error) => {
            if (signal.aborted) return;
            terminal.notify(`Extension event failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
          });
        } finally {
          terminal.setTransientStatus();
          if (shellAbort === controller) shellAbort = undefined;
          terminal.setSteering(undefined);
        }
        continue;
      }
      if (line === "/new") {
        const nextThreadId = (await runtime.service.createSession({
          cwd: currentWorkspaceCwd(runtime.workspace),
        })).threadId;
        await upsertIndexedThread(sessionIndex, runtime, nextThreadId);
        const previousThreadId = threadId;
        await transitionExtensionSession(nextThreadId, undefined);
        try {
          await removeEmptyThread(runtime, previousThreadId, sessionIndex);
        } catch (error) {
          terminal.notify(`Session index cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        threadId = nextThreadId;
        if (ephemeral) ephemeralThreads.add(nextThreadId);
        branch = undefined;
        replayTranscript();
        syncContext();
        refreshSessions();
        terminal.notify(`Session ${threadId}`);
        continue;
      }
      if (
        line === "/resume"
        || line.startsWith("/resume ")
      ) {
        if (ephemeral) {
          terminal.notify("Session resume is unavailable in --no-session mode. Start Rigyn without --no-session to save and resume conversations.", "warning");
          continue;
        }
        const argumentsText = line.startsWith("/resume ") ? line.slice(8).trim() : "";
        const allWorkspaces = argumentsText === "--all" || argumentsText.startsWith("--all ");
        if (allWorkspaces) {
          if (submittedImages.length > 0 || submittedRecoveredImages.length > 0 || submittedRecoveredQueueDraft) {
            throw new Error("Submit or clear attached and recovered input before switching workspaces");
          }
          const index = await requireAllWorkspaceIndex();
          const reference = argumentsText.slice("--all".length).trim();
          if (reference === "" && terminal.mode === "full") {
            await loadSessionCatalog("all", "", false);
            terminal.openPicker("session", "Resume Session · All Workspaces");
            terminal.setSessionPickerScope("all");
            continue;
          }
          const record = reference === ""
            ? await pickIndexedThread(index, runtime, terminal, threadId)
            : resolveIndexedSessionReference(index, reference);
          await resumeIndexedSession(record);
          continue;
        }
        if (argumentsText.startsWith("--")) throw new Error(`Unknown resume option: ${argumentsText.split(/\s/u, 1)[0]}`);
        const requested = argumentsText === "" ? undefined : argumentsText;
        if (requested === undefined && terminal.mode === "full") {
          await loadSessionCatalog("current", "", false);
          terminal.openPicker("session", "Resume Session");
          continue;
        }
        const resumed = requested === undefined
          ? await pickThread(runtime, terminal, threadId)
          : runtime.store.bindThreadWorkspace(
              resolveSessionReference(runtime.store, requested, { workspaceRoot: runtime.workspace }).threadId,
              runtime.workspace,
            );
        const nextChoice = configuredSelection(runtime, argumentsValue, resumed.threadId);
        const previousThreadId = threadId;
        await transitionExtensionSession(resumed.threadId, undefined);
        try {
          await removeEmptyThread(runtime, previousThreadId, sessionIndex);
        } catch (error) {
          terminal.notify(`Session index cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        threadId = resumed.threadId;
        branch = undefined;
        restoreStoredSelection(nextChoice);
        replayTranscript();
        syncContext();
        refreshSessions();
        scheduleModelRefresh();
        terminal.notify(`Resumed ${threadId}`);
        continue;
      }
      if (line === "/fork" || line.startsWith("/fork ")) {
        const supplied = line.startsWith("/fork ") ? line.slice(6).trim() : "";
        const selected = await pickTimelineEvent(runtime, terminal, threadId, branch, { userOnly: true });
        const forked = await runtime.service.cloneSessionPath({
          threadId,
          branch: selected.sourceBranch,
          atEventId: selected.rewindEventId ?? null,
          ...(supplied === "" ? {} : { name: supplied }),
          signal: AbortSignal.any([catalogAbort.signal, runtime.generationSignal]),
        });
        await upsertIndexedThread(sessionIndex, runtime, forked.thread.threadId);
        await transitionExtensionSession(forked.thread.threadId, undefined);
        threadId = forked.thread.threadId;
        if (ephemeral) ephemeralThreads.add(threadId);
        branch = undefined;
        restoreStoredSelection(configuredSelection(runtime, argumentsValue, threadId));
        replayTranscript();
        syncContext();
        terminal.setEditorText(selected.restoreText ?? "");
        refreshSessions();
        terminal.notify(`Forked a new session before ${selected.eventId}; the selected prompt is ready to edit.`);
        continue;
      }
      if (line === "/clone" || line.startsWith("/clone ")) {
        const supplied = line.startsWith("/clone ") ? line.slice(7).trim() : "";
        const cloned = await runtime.service.cloneSessionPath({
          threadId,
          ...(branch === undefined ? {} : { branch }),
          ...(supplied === "" ? {} : { name: supplied }),
          signal: AbortSignal.any([catalogAbort.signal, runtime.generationSignal]),
        });
        await upsertIndexedThread(sessionIndex, runtime, cloned.thread.threadId);
        await transitionExtensionSession(cloned.thread.threadId, undefined);
        threadId = cloned.thread.threadId;
        if (ephemeral) ephemeralThreads.add(threadId);
        branch = undefined;
        restoreStoredSelection(configuredSelection(runtime, argumentsValue, threadId));
        replayTranscript();
        syncContext();
        refreshSessions();
        terminal.notify(`Cloned session ${cloned.thread.threadId}`);
        continue;
      }
      if (line === "/tree") {
        const selected = await pickTimelineEvent(runtime, terminal, threadId, branch);
        const summaryMode = await terminal.choose("Summarize abandoned branch?", [
          { label: "No summary", detail: "Move without adding model-generated context", value: "none" as const },
          { label: "Summarize", detail: "Attach a bounded continuation note at the selected point", value: "summary" as const },
          { label: "Summarize with focus", detail: "Add a short operator instruction for the summary", value: "custom" as const },
        ]);
        const summarize = summaryMode !== "none";
        if (summarize) requireModelSelection(choice);
        const summaryInstructions = summaryMode === "custom"
          ? (await terminal.question("Branch summary focus: ")).trim()
          : undefined;
        if (summaryMode === "custom" && summaryInstructions === "") throw new Error("Branch summary focus cannot be empty");
        const name = automaticBranchName("tree");
        const controller = new AbortController();
        if (summarize) branchSummaryAbort = controller;
        active = summarize;
        if (summarize) terminal.setTransientStatus("Summarizing abandoned branch… Esc cancels");
        syncContext();
        let navigation: Awaited<ReturnType<typeof runtime.service.navigateTree>>;
        try {
          navigation = await runtime.service.navigateTree({
            threadId,
            ...(branch === undefined ? {} : { branch }),
            targetBranch: selected.sourceBranch,
            targetEventId: selected.kind === "user" ? selected.rewindEventId ?? null : selected.eventId,
            newBranch: name,
            summarize,
            ...(choice === undefined ? {} : { provider: choice.provider, model: choice.model }),
            ...(runtime.config.summaryTokenBudget === undefined
              ? {}
              : { summaryTokenBudget: Math.min(runtime.config.summaryTokenBudget, 4_096) }),
            ...(summaryInstructions === undefined ? {} : { summaryInstructions }),
            signal: AbortSignal.any([catalogAbort.signal, controller.signal]),
          });
        } finally {
          if (branchSummaryAbort === controller) branchSummaryAbort = undefined;
          active = false;
          if (summarize) terminal.setTransientStatus();
          syncContext();
        }
        if (navigation.cancelled) {
          terminal.notify("Branch summarization cancelled; the session was not changed.", "warning");
          continue;
        }
        await transitionExtensionSession(threadId, name);
        branch = name;
        restoreStoredSelection(configuredSelection(runtime, argumentsValue, threadId, branch));
        replayTranscript();
        syncContext();
        if (selected.kind === "user") terminal.setEditorText(selected.restoreText ?? "");
        terminal.notify(selected.kind === "user"
          ? `Moved before ${selected.eventId} on branch ${name}; the selected prompt is ready to edit.${navigation.summaryEvent === undefined ? "" : " Abandoned context was summarized."}`
          : `Continued from ${selected.eventId} on branch ${name}; existing history was preserved.${navigation.summaryEvent === undefined ? "" : " Abandoned context was summarized."}`);
        continue;
      }
      if (line === "/login" || line.startsWith("/login ")) {
        const requested = line.startsWith("/login ") ? line.slice(7).trim() : undefined;
        await connectProvider(requested);
        continue;
      }
      if (line === "/logout" || line.startsWith("/logout ")) {
        const logoutArguments = line.startsWith("/logout ") ? line.slice(8).trim().split(/\s+/u).filter(Boolean) : [];
        const revokeRemote = logoutArguments[0] === "--revoke";
        if (revokeRemote) logoutArguments.shift();
        if (logoutArguments.length > 1) throw new Error("Usage: /logout [--revoke] [provider]");
        const requested = logoutArguments[0];
        const provider = requested === undefined || requested === ""
          ? await pickProvider(runtime, terminal)
          : requested;
        runtime.providers.get(provider);
        const controller = new AbortController();
        authAbort = controller;
        terminal.setInterruptHandler(() => controller.abort(new Error("authorization cancelled from terminal")));
        if (terminal.mode === "full") terminal.setTransientStatus("Signing out… Esc cancels");
        let result: Awaited<ReturnType<typeof runtime.auth.logout>>;
        try {
          result = await runtime.auth.logout(provider, {
            revokeRemote,
            fetch: runtime.network.fetch,
            signal: AbortSignal.any([catalogAbort.signal, runtime.generationSignal, controller.signal]),
          });
        } catch (error) {
          if (controller.signal.aborted) throw new TuiSelectionCancelledError();
          throw error;
        } finally {
          if (authAbort === controller) authAbort = undefined;
          terminal.setInterruptHandler(undefined);
          if (terminal.mode === "full") terminal.setTransientStatus();
        }
        for (const affected of runtime.auth.affectedProviders(provider)) {
          runtime.providers.invalidateModels(affected);
          for (const key of modelCatalog.keys()) if (key.startsWith(`${affected}\u0000`)) modelCatalog.delete(key);
        }
        syncContext();
        scheduleModelRefresh();
        const remaining = result.state.status === "connected"
          ? `${result.state.source ?? "another source"} remains active`
          : result.state.source === "ambient"
            ? "ambient identity remains available but has not been verified"
            : result.state.source === "external"
              ? "authentication remains provider-managed"
              : undefined;
        terminal.notify(remaining === undefined
          ? `${result.removedStored ? "Signed out" : "No stored credential found"} for ${provider}${result.profile === undefined ? "" : ` profile ${result.profile}`}${result.remoteRevocation === "revoked" ? " and revoked its remote OAuth grant" : result.remoteRevocation === "unsupported" ? "; the issuer has no configured revocation endpoint" : ""}. Run /login ${provider} to connect.`
          : `${result.removedStored ? "Removed the stored credential" : "No stored credential was present"} for ${provider}; ${remaining}.`);
        continue;
      }
      if (line === "/model" || line.startsWith("/model ")) {
        const requested = line.startsWith("/model ") ? line.slice(7).trim() : undefined;
        if (terminal.mode === "full") {
          if (requested === undefined || requested === "") {
            terminal.openPicker("model", "Models");
            continue;
          }
          if (modelCatalog.size === 0 && modelRefreshTask !== undefined) {
            await Promise.race([
              modelRefreshTask.catch(() => undefined),
              new Promise<void>((resolveWait) => {
                const timer = setTimeout(resolveWait, 1_000);
                timer.unref();
              }),
            ]);
          }
          const resolution = await runtime.providers.resolveModelReference(
            requested,
            AbortSignal.any([catalogAbort.signal, runtime.generationSignal]),
            { refresh: false },
          );
          if (resolution.match !== "exact" || resolution.model === undefined) {
            if (resolution.match === "unsupported-thinking") {
              throw new Error(modelReferenceFailureMessage(resolution) ?? `Unsupported model selection: ${requested}`);
            }
            terminal.openPicker("model", "Models", requested);
            continue;
          }
          choice = { provider: resolution.model.provider, model: resolution.model.id };
          if (resolution.reasoningEffort !== undefined) thinking = resolution.reasoningEffort;
          await ensureThinkingSupported();
          await persistSelection(choice);
          syncContext();
          scheduleModelRefresh();
          terminal.notify(`Model ${choice.provider}/${choice.model}${resolution.reasoningEffort === undefined ? "" : ` · thinking ${resolution.reasoningEffort}`}`);
          continue;
        }
        const provider = choice?.provider ?? selectionDefaults(runtime, argumentsValue, threadId, branch).provider;
        const reference = requested === undefined || requested === ""
          ? await pickModel(runtime, provider, terminal)
          : requested;
        const resolved = await resolveRequestedModel(runtime.providers, {
          reference,
          ...(requested === undefined || requested === "" ? { provider } : {}),
          fallbackProvider: provider,
          refresh: false,
        }, AbortSignal.any([catalogAbort.signal, runtime.generationSignal]));
        choice = { provider: resolved.provider, model: resolved.model };
        if (resolved.reasoningEffort !== undefined) thinking = resolved.reasoningEffort;
        await ensureThinkingSupported();
        await persistSelection(choice);
        syncContext();
        scheduleModelRefresh();
        terminal.notify(`Model ${choice.provider}/${choice.model}${resolved.reasoningEffort === undefined ? "" : ` · thinking ${resolved.reasoningEffort}`}`);
        continue;
      }
      if (line === "/name" || line.startsWith("/name ")) {
        const name = line === "/name" ? (await terminal.question("Session name: ")).trim() : line.slice(6).trim();
        if (name === "") throw new Error("Session name cannot be empty");
        const renamed = await runtime.service.setSessionName({
          threadId,
          ...(branch === undefined ? {} : { branch }),
          name,
        });
        await upsertIndexedThread(sessionIndex, runtime, threadId);
        syncContext();
        refreshSessions();
        terminal.notify(`Named session ${renamed.name ?? renamed.threadId}`);
        continue;
      }
      if (line === "/session") {
        const thread = runtime.store.getThread(threadId);
        const runs = runtime.store.listRuns(threadId);
        terminal.notify(formatSessionReport({
          thread,
          branch: branch ?? thread.defaultBranch,
          databasePath: runtime.databasePath,
          events: runtime.store.listEvents(threadId, branch),
          runs,
          ...(choice === undefined ? {} : { provider: choice.provider, model: choice.model }),
        }));
        continue;
      }
      if (line === "/resources") {
        terminal.notify(formatResourceCatalogReport(await runtime.service.resourceCatalog()));
        continue;
      }
      if (line === "/compact" || line.startsWith("/compact ")) {
        requireModelSelection(choice);
        const compactionInstructions = line.startsWith("/compact ") ? line.slice(9).trim() : undefined;
        const controller = new AbortController();
        activeRunAbort = controller;
        terminal.setInterruptHandler(() => {
          controller.abort(new Error("compaction cancelled from terminal"));
          runtime!.service.cancel(threadId, "cancelled from terminal");
        });
        active = true;
        syncContext();
        try {
          const result = await runtime.service.compact({
            threadId,
            ...(branch === undefined ? {} : { branch }),
            ...choice,
            ...outboundImageOptions(argumentsValue),
            ...(runtime.config.contextTokenBudget === undefined ? {} : { contextTokenBudget: runtime.config.contextTokenBudget }),
            ...(runtime.config.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: runtime.config.summaryTokenBudget }),
            ...(thinking === "off" ? {} : { reasoningEffort: thinking }),
            ...(compactionInstructions === undefined ? {} : { compactionInstructions }),
            signal: AbortSignal.any([catalogAbort.signal, runtime.generationSignal, controller.signal]),
            onEvent: async (event) => {
              terminal.render(event);
              await runtime!.runtimeExtensions.dispatch("event", event, controller.signal).catch((error) => {
                if (controller.signal.aborted) return;
                terminal.notify(`Extension event failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
              });
            },
          });
          terminal.notify(result.finalText);
        } catch (error) {
          if (controller.signal.aborted) throw new TuiSelectionCancelledError();
          throw error;
        } finally {
          if (activeRunAbort === controller) activeRunAbort = undefined;
          terminal.setInterruptHandler(undefined);
          active = false;
          syncContext();
        }
        continue;
      }
      if (line === "/trust") {
        if (runtime.trusted) terminal.notify(`Workspace already trusted: ${runtime.workspace}`);
        else {
          await new TrustStore(runtime.paths.trustStore).trust(runtime.workspace);
          terminal.notify("Workspace trusted. Run /reload to activate project extensions, skills, prompts, and themes.");
        }
        continue;
      }
      if (line === "/copy") {
        await copyLatestAssistant();
        continue;
      }
      if (line === "/reload") {
        const controller = new AbortController();
        reloadAbort = controller;
        terminal.setInterruptHandler(() => controller.abort(new Error("reload cancelled from terminal")));
        terminal.setInputBlocked("Reloading keybindings, extensions, skills, prompts, themes, context, and providers...", "reload");
        let reloadWarnings: string[] = [];
        let reloadMessage = "";
        try {
          const nextKeybindings = await loadKeybindings(keybindingsPath);
          let reloadedSummary: string[] = [];
          let reloadedArguments: ParsedArguments | undefined;
          const result = await runtime.reload({
            session: { threadId, ...(branch === undefined ? {} : { branch }) },
            signal: AbortSignal.any([catalogAbort.signal, runtime.generationSignal, controller.signal, AbortSignal.timeout(60_000)]),
            prepareExtensions: (extensions) => {
              reloadedArguments = applyRuntimeExtensionFlags(argumentsValue, extensions);
            },
            onCommit: async () => {
              if (reloadedArguments !== undefined) argumentsValue = reloadedArguments;
              terminal.setKeybindings(nextKeybindings);
              keybindings = nextKeybindings;
              thinking = thinkingLevel(flagString(argumentsValue, "thinking") ?? runtime!.config.thinking);
              steeringMode = runtime!.config.steeringMode;
              followUpMode = runtime!.config.followUpMode;
              autoCompaction = runtime!.config.autoCompaction;
              outboundImages = outboundImageOverride(argumentsValue) ?? runtime!.config.outboundImages;
              const configuredModels = flagString(argumentsValue, "models");
              scopedModels = configuredModels === undefined
                ? [...runtime!.config.scopedModels]
                : parseModelScope(configuredModels);
              if (choice !== undefined && !runtime!.providers.has(choice.provider)) {
                choice = undefined;
                terminal.notify("The selected provider was removed by reload; select another model.", "warning");
              }
              modelCatalog.clear();
              modelRefreshAbort?.abort(new Error("Runtime resources reloaded"));
              fileRefreshAbort?.abort(new Error("Runtime resources reloaded"));
              replayTranscript();
              reloadedSummary = (await bindRuntimePresentation()).summary;
            },
          });
          reloadWarnings = result.warnings;
          reloadMessage = `Reloaded keybindings, extensions, skills, prompts, themes, context, and providers${reloadedSummary.length === 0 ? "" : ` · ${reloadedSummary.join(" · ")}`}`;
        } catch (error) {
          if (controller.signal.aborted) throw new TuiSelectionCancelledError();
          throw error;
        } finally {
          if (reloadAbort === controller) reloadAbort = undefined;
          terminal.setInterruptHandler(undefined);
          terminal.setInputBlocked();
        }
        for (const warning of reloadWarnings) terminal.notify(warning, "warning");
        terminal.notify(reloadMessage);
        continue;
      }
      if (line === "/export" || line.startsWith("/export ")) {
        const requested = line.startsWith("/export ") ? parseInteractivePathArgument(line.slice(8), "/export") : "";
        const outputPath = expandPath(requested || `rigyn-${threadId}.html`, runtime.workspace);
        const lower = outputPath.toLowerCase();
        const data = lower.endsWith(".jsonl")
          ? runtime.store.exportThread(threadId)
          : lower.endsWith(".md")
            ? exportThreadMarkdown(runtime.store, threadId, branch)
            : exportThreadHtml(runtime.store, threadId, branch);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
        terminal.notify(`Exported session to ${outputPath}`);
        continue;
      }
      if (line === "/import" || line.startsWith("/import ")) {
        if (ephemeral) throw new Error("Session import is disabled by --no-session");
        const requestedPath = line === "/import" ? (await terminal.question("Import JSONL path: ")).trim() : line.slice(8);
        if (requestedPath === "") throw new Error("Import path cannot be empty");
        const inputPath = expandPath(parseInteractivePathArgument(requestedPath, "/import"), runtime.workspace);
        const loaded = await readFileBounded(inputPath, 256 * 1024 * 1024);
        if (loaded.truncated) throw new Error("Session import exceeds 256 MiB");
        const imported = importThreadJsonl(runtime.store, loaded.data.toString("utf8"), { workspaceRoot: runtime.workspace });
        await upsertIndexedThread(sessionIndex, runtime, imported.thread.threadId);
        const nextChoice = configuredSelection(runtime, argumentsValue, imported.thread.threadId);
        const previousThreadId = threadId;
        await transitionExtensionSession(imported.thread.threadId, undefined);
        try {
          await removeEmptyThread(runtime, previousThreadId, sessionIndex);
        } catch (error) {
          terminal.notify(`Session index cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        threadId = imported.thread.threadId;
        branch = undefined;
        restoreStoredSelection(nextChoice);
        replayTranscript();
        syncContext();
        refreshSessions();
        scheduleModelRefresh();
        terminal.notify(`Imported ${imported.events} events into session ${threadId}`);
        continue;
      }
      if (line === "/hotkeys") {
        const extensionKeys = activeRuntimeShortcuts.length === 0
          ? undefined
          : `Extensions: ${activeRuntimeShortcuts.map((entry) => `${displayKeybinding(entry.shortcut)}${entry.description === undefined ? "" : ` ${entry.description}`}`).join(" · ")}`;
        terminal.notify([formatHotkeys(keybindings), extensionKeys].filter((value): value is string => value !== undefined).join("\n"));
        continue;
      }
      if (line === "/scoped-models" || line.startsWith("/scoped-models ")) {
        const requested = line.startsWith("/scoped-models ")
          ? line.slice(15).trim()
          : undefined;
        await configureScopedModels(requested);
        continue;
      }
      if (line === "/settings") {
        const thinkingLevels = availableThinkingLevels();
        const settings: TuiSettingItem[] = [
          {
            id: "autocompact",
            label: "Auto-compact",
            description: "Automatically compact context when it gets too large",
            value: String(autoCompaction),
            values: ["true", "false"],
          },
          {
            id: "default-project-trust",
            label: "Project trust default",
            description: "Ask, enable, or disable project resources for undecided workspaces on the next launch",
            value: defaultProjectTrust,
            values: ["ask", "always", "never"],
          },
          {
            id: "provider-retry-attempts",
            label: "Provider retry attempts",
            description: "Maximum safe provider attempts per response; changes apply after /reload",
            value: String(providerRetryAttempts),
            values: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          },
          {
            id: "block-images",
            label: "Block images",
            description: "Prevent images from being sent to model providers",
            value: String(outboundImages === "block"),
            values: ["false", "true"],
          },
          {
            id: "steering-mode",
            label: "Steering mode",
            description: "Choose whether queued steering messages are delivered one at a time or all together",
            value: steeringMode,
            values: ["one-at-a-time", "all"],
          },
          {
            id: "follow-up-mode",
            label: "Follow-up mode",
            description: "Choose whether queued follow-ups are delivered one at a time or all together",
            value: followUpMode,
            values: ["one-at-a-time", "all"],
          },
          {
            id: "double-escape-action",
            label: "Double-Escape action",
            description: "Open the session tree, fork picker, or do nothing when Escape is pressed twice on an empty editor",
            value: doubleEscapeAction,
            values: ["tree", "fork", "none"],
          },
          {
            id: "codex-transport",
            label: "ChatGPT transport",
            description: "OpenAI Codex response transport; the new value applies after /reload",
            value: codexTransport,
            values: ["auto", "websocket-cached", "websocket", "sse"],
          },
          ...(thinkingLevels.length === 0 ? [] : [{
            id: "thinking",
            label: "Thinking level",
            description: "Reasoning depth for thinking-capable models",
            value: thinking,
            values: thinkingLevels,
          } satisfies TuiSettingItem]),
          {
            id: "theme",
            label: "Theme",
            description: "Color theme for the interface",
            value: terminal.selectedThemeName(),
            values: terminal.themeNames(),
          },
        ];
        if (terminal.mode === "full") {
          await terminal.chooseSettings(settings, async (setting, value) => {
            if (setting.id === "autocompact") {
              autoCompaction = value === "true";
              await persistUiPreferences(runtime!.paths, { autoCompaction });
              syncContext();
            } else if (setting.id === "default-project-trust") {
              defaultProjectTrust = value as DefaultProjectTrust;
              await persistUiPreferences(runtime!.paths, { defaultProjectTrust });
            } else if (setting.id === "provider-retry-attempts") {
              providerRetryAttempts = Number(value);
              await persistProviderRetryAttempts(runtime!, providerRetryAttempts);
            } else if (setting.id === "block-images") {
              outboundImages = value === "true" ? "block" : "allow";
              await persistUiPreferences(runtime!.paths, { outboundImages });
            } else if (setting.id === "steering-mode") {
              steeringMode = value as QueueMode;
              await persistUiPreferences(runtime!.paths, { steeringMode });
            } else if (setting.id === "follow-up-mode") {
              followUpMode = value as QueueMode;
              await persistUiPreferences(runtime!.paths, { followUpMode });
            } else if (setting.id === "double-escape-action") {
              doubleEscapeAction = value as typeof doubleEscapeAction;
              terminal.setDoubleEscapeAction(doubleEscapeAction);
              await persistUiPreferences(runtime!.paths, { doubleEscapeAction });
            } else if (setting.id === "codex-transport") {
              codexTransport = value as CodexTransportSetting;
              await persistCodexTransport(runtime!, codexTransport);
            } else if (setting.id === "thinking") {
              thinking = thinkingLevel(value);
              await persistUiPreferences(runtime!.paths, { thinking });
              if (choice !== undefined) await persistSelection(choice);
              syncContext();
            } else if (setting.id === "theme") {
              terminal.setTheme(value);
              await persistUiTheme(runtime!.paths, value);
            }
          });
        } else {
          const selected = await terminal.choose("Settings", settings.map((setting) => ({
            label: `${setting.label} · ${setting.value}`,
            detail: setting.description,
            value: setting,
          })));
          const index = selected.values.indexOf(selected.value);
          const value = selected.values[(index + 1) % selected.values.length]!;
          if (selected.id === "autocompact") {
            autoCompaction = value === "true";
            await persistUiPreferences(runtime.paths, { autoCompaction });
          } else if (selected.id === "default-project-trust") {
            defaultProjectTrust = value as DefaultProjectTrust;
            await persistUiPreferences(runtime.paths, { defaultProjectTrust });
          } else if (selected.id === "provider-retry-attempts") {
            providerRetryAttempts = Number(value);
            await persistProviderRetryAttempts(runtime, providerRetryAttempts);
          } else if (selected.id === "block-images") {
            outboundImages = value === "true" ? "block" : "allow";
            await persistUiPreferences(runtime.paths, { outboundImages });
          } else if (selected.id === "steering-mode") {
            steeringMode = value as QueueMode;
            await persistUiPreferences(runtime.paths, { steeringMode });
          } else if (selected.id === "follow-up-mode") {
            followUpMode = value as QueueMode;
            await persistUiPreferences(runtime.paths, { followUpMode });
          } else if (selected.id === "double-escape-action") {
            doubleEscapeAction = value as typeof doubleEscapeAction;
            terminal.setDoubleEscapeAction(doubleEscapeAction);
            await persistUiPreferences(runtime.paths, { doubleEscapeAction });
          } else if (selected.id === "codex-transport") {
            codexTransport = value as CodexTransportSetting;
            await persistCodexTransport(runtime, codexTransport);
          } else if (selected.id === "thinking") {
            thinking = thinkingLevel(value);
            await persistUiPreferences(runtime.paths, { thinking });
            syncContext();
          } else {
            terminal.setTheme(value);
            await persistUiTheme(runtime.paths, value);
          }
        }
        continue;
      }
      if (line.startsWith("/prompt ")) {
        const [id, ...input] = line.slice(8).trim().split(/\s+/u);
        if (id === undefined || id === "") throw new Error("Prompt ID is required");
        const prompt = runtime.extensions.prompt(id);
        if (prompt === undefined) throw new Error(`Unknown extension prompt: ${id}`);
        submission = renderExtensionPrompt(prompt, input.join(" "));
        terminal.notify(`Expanded prompt ${id} from extension ${prompt.extensionId}`);
      } else if (line.startsWith("/skill:")) {
        const separator = line.indexOf(" ");
        const name = line.slice(7, separator < 0 ? undefined : separator);
        const skill = runtime.service.skills.find((entry) => entry.name === name);
        if (skill === undefined) throw new Error(`Unknown skill: ${name}`);
        const loaded = await loadSkill(skill);
        submission = skillInvocation(skill, loaded.instructions, separator < 0 ? "" : line.slice(separator + 1));
        terminal.notify(`Loaded skill ${name}`);
      } else if (line.startsWith("/")) {
        const separator = line.indexOf(" ");
        const name = line.slice(1, separator < 0 ? undefined : separator);
        const runtimeCommand = runtime.runtimeExtensions.commands().find((command) => command.name === name);
        let runtimeResult: { handled: boolean; prompt?: string } = { handled: false };
        if (runtimeCommand !== undefined) {
          if (extensionActionAbort !== undefined) {
            throw new Error("Another extension action is still running; press Esc to cancel it");
          }
          const before = runtime.runtimeExtensions.diagnostics().length;
          const controller = new AbortController();
          const uiLifetime = new AbortController();
          extensionActionAbort = controller;
          terminal.setInterruptHandler(() => controller.abort(new Error("extension command cancelled from terminal")));
          try {
            const actionSignal = AbortSignal.any([catalogAbort.signal, runtime.generationSignal, controller.signal]);
            runtimeResult = await runtime.runtimeExtensions.runCommand(name, {
              args: separator < 0 ? "" : line.slice(separator + 1),
              threadId,
              ...(branch === undefined ? {} : { branch }),
              signal: actionSignal,
              ui: runtimeUi(terminal, runtimeCommand.extensionId, uiLifetime.signal, actionSignal),
            });
          } catch (error) {
            if (!controller.signal.aborted) throw error;
            throw new TuiSelectionCancelledError();
          } finally {
            uiLifetime.abort(new Error("extension command UI context ended"));
            if (extensionActionAbort === controller) {
              extensionActionAbort = undefined;
              terminal.setInterruptHandler(undefined);
            }
            for (const diagnostic of runtime.runtimeExtensions.diagnostics().slice(before)) {
              terminal.notify(`Extension ${diagnostic.extensionId}: ${diagnostic.message}`, "warning");
            }
          }
        }
        if (runtimeResult.handled) {
          if (runtimeResult.prompt === undefined) continue;
          submission = runtimeResult.prompt;
        } else {
          const command = runtime.extensions.command(name);
          if (command !== undefined) {
            submission = renderExtensionCommand(command, separator < 0 ? "" : line.slice(separator + 1));
            terminal.notify(`Expanded /${name} from extension ${command.extensionId}`);
          } else {
            const prompt = runtime.extensions.prompt(name);
            if (prompt === undefined) throw new Error(`Unknown command: /${name}`);
            submission = renderExtensionPrompt(prompt, separator < 0 ? "" : line.slice(separator + 1));
            terminal.notify(`Expanded /${name} from extension ${prompt.extensionId}`);
          }
        }
      }
      }
      const submittedBlocks = [
        ...attachmentBlocks(submittedImages),
        ...submittedRecoveredImages.map((image) => ({ ...image })),
      ];
      const inputResult = await reduceTuiInput(submission, submittedBlocks);
      if (inputResult.action === "handled") {
        if (submittedRecoveredQueueDraft && stagedQueueLease !== undefined) {
          runtime.service.acknowledgeQueueLease(stagedQueueLease);
          stagedQueueLease = undefined;
          submittedRecoveredQueueDraft = false;
        }
        attachmentsConsumed = true;
        continue;
      }
      if (inputResult.action === "transform") {
        submission = inputResult.text;
      }
      requireModelSelection(choice);
      const expandedPrompt = await expandPromptReferences(submission, runtime.workspace, catalogAbort.signal);
      const prompt = inputResult.action === "transform"
        ? expandedPrompt.text
        : attachmentPrompt(expandedPrompt.text, submittedImages);
      const images = combinePromptImages(
        inputResult.action === "transform",
        submittedBlocks,
        inputResult.action === "transform" ? inputResult.images : undefined,
        expandedPrompt.images,
      );
      if (submittedRecoveredQueueDraft && stagedQueueLease === undefined) {
        throw new Error("Recovered queue draft lost its durable lease; restore it again with Alt+Up");
      }
      const runController = new AbortController();
      activeRunAbort = runController;
      terminal.setInterruptHandler(() => {
        restoreQueueAfterCancellation = true;
        runtime!.service.cancel(threadId, "cancelled from terminal");
        runController.abort(new Error("run cancelled from terminal"));
      });
      active = true;
      syncContext();
      terminal.setSteering((steering, inputImages, inputRecoveredImages, recoveredQueueDraft) => {
        try {
          const submissionOrder = activeSubmissionOrder++;
          if (recoveredQueueDraft === true) {
            restoreInteractiveSubmission(steering, inputImages ?? [], inputRecoveredImages ?? [], true);
            terminal.notify("Recovered queue input remains in the editor until the active response finishes", "warning");
            return;
          }
          const classified = classifyActiveSubmission(steering);
          if (classified.kind === "cancel") {
            restoreInteractiveSubmission("", inputImages ?? [], inputRecoveredImages ?? []);
            restoreQueueAfterCancellation = true;
            runtime!.service.cancel(threadId, "cancelled from terminal");
            runController.abort(new Error("run cancelled from terminal"));
            return;
          }
          const attachments = [...(inputImages ?? [])];
          const recoveredImages = [...(inputRecoveredImages ?? [])];
          if (classified.kind === "defer") {
            if (recoveredImages.length > 0) {
              restoreInteractiveSubmission(classified.text, attachments, recoveredImages);
              terminal.notify("Recovered image input remains in the editor; submit it after the active response finishes", "warning");
              return;
            }
            enqueueDeferredSubmission(classified.text, attachments, "Deferred command until the response finishes", submissionOrder);
            return;
          }
          const followUp = classified.kind === "follow_up";
          const text = classified.text;
          inputDeliveryQueue = inputDeliveryQueue.then(async () => {
            const blocks = [
              ...attachmentBlocks(attachments),
              ...recoveredImages.map((image) => ({ ...image })),
            ];
            let result: Awaited<ReturnType<typeof reduceTuiInput>>;
            try {
              result = await reduceTuiInput(text, blocks, followUp ? "follow_up" : "steer");
            } catch (error) {
              restoreInteractiveSubmission(steering, attachments, recoveredImages);
              terminal.notify(`Input extension failed: ${error instanceof Error ? error.message : String(error)}`, "error");
              return;
            }
            if (result.action === "handled") return;
            const deliveredText = result.action === "transform" ? result.text : attachmentPrompt(text, attachments);
            const deliveredImages = result.action === "transform" ? result.images ?? [] : blocks;
            try {
              if (followUp) runtime!.service.followUp(threadId, deliveredText, deliveredImages);
              else runtime!.service.steer(threadId, deliveredText, deliveredImages);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!active || message === "Run message queue is closed" || message.startsWith("Thread has no active run:")) {
                if (recoveredImages.length > 0) {
                  restoreInteractiveSubmission(text, attachments, recoveredImages);
                  terminal.notify("Response finished; recovered image input was restored to the editor", "warning");
                  return;
                }
                enqueueDeferredSubmission(text, attachments, "Response finished; moved input to the normal dispatcher", submissionOrder);
                return;
              }
              restoreInteractiveSubmission(steering, attachments, recoveredImages);
              terminal.notify(message, "error");
              return;
            }
            terminal.setQueuedMessages(runtime!.service.queuedMessages(threadId, branch));
          }).catch((error) => {
            restoreInteractiveSubmission(steering, attachments, recoveredImages);
            terminal.notify(`Input delivery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
        } catch (error) {
          restoreInteractiveSubmission("", inputImages ?? [], inputRecoveredImages ?? []);
          try {
            terminal.notify(error instanceof Error ? error.message : String(error), "error");
          } catch {}
        }
      });
      const runProvider = choice.provider;
      let runFailureRendered = false;
      try {
        attachmentsConsumed = true;
        await runtime.service.run({
          threadId,
          ...(branch === undefined ? {} : { branch }),
          prompt,
          displayPrompt: line,
          ...(images.length === 0 ? {} : { images }),
          ...(submittedRecoveredQueueDraft && stagedQueueLease !== undefined ? { queueLease: stagedQueueLease } : {}),
          ...choice,
          outboundImages,
          autoCompaction,
          ...promptOptions,
          ...selectedTools(
            argumentsValue,
            runtime!.runtimeExtensions.tools().map((tool) => tool.definition.name),
          ),
          cwd: currentWorkspaceCwd(runtime.workspace),
          ...(flagBoolean(argumentsValue, "no-context-files") ? { noContextFiles: true } : {}),
          ...(runtime.config.maxSteps === undefined ? {} : { maxSteps: runtime.config.maxSteps }),
          ...(runtime.config.contextTokenBudget === undefined ? {} : { contextTokenBudget: runtime.config.contextTokenBudget }),
          ...(runtime.config.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: runtime.config.summaryTokenBudget }),
          ...(thinking === "off" ? {} : { reasoningEffort: thinking }),
          steeringMode,
          followUpMode,
          onEvent: async (event) => {
            if (event.event.type === "run_failed") runFailureRendered = true;
            if (event.event.type === "message_appended" && event.event.message.role === "user") {
              recoveredImagesCommitted = true;
              if (submittedRecoveredQueueDraft) stagedQueueLease = undefined;
            }
            terminal.render(event.event.type === "run_failed"
              ? {
                  ...event,
                  event: {
                    ...event.event,
                    error: {
                      ...event.event.error,
                      message: runFailureMessage(event.event.error, runProvider),
                    },
                  },
                }
              : event);
            terminal.setQueuedMessages(runtime!.service.queuedMessages(threadId, branch));
            await runtime!.runtimeExtensions.dispatch("event", event, runController.signal).catch((error) => {
              if (runController.signal.aborted) return;
              terminal.notify(`Extension event failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
            });
          },
        });
      } catch (error) {
        if (!runFailureRendered && !runController.signal.aborted) {
          try {
            terminal.notify(`Run failed: ${runFailureMessage(error, choice.provider)}`, "error");
          } catch {}
        }
      } finally {
        await inputDeliveryQueue;
        active = false;
        terminal.setSteering(undefined);
        if (activeRunAbort === runController) activeRunAbort = undefined;
        terminal.setInterruptHandler(undefined);
        if (restoreQueueAfterCancellation) {
          restoreQueueAfterCancellation = false;
          const restored = restoreQueuedMessages();
          if (restored > 0) {
            terminal.notify(`Restored ${restored} queued message${restored === 1 ? "" : "s"} to the editor after cancellation`);
          }
        }
        if (!ephemeral) {
          scheduleSessionIndexUpdate(runtime, threadId);
        }
        syncContext();
        refreshSessions();
      }
      } catch (error) {
        active = false;
        terminal.setSteering(undefined);
        syncContext();
        if (!(error instanceof TuiSelectionCancelledError)) {
          try {
            terminal.notify(`Command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          } catch {}
        }
      } finally {
        if (submittedRecoveredQueueDraft && !recoveredImagesCommitted) {
          restoreInteractiveSubmission(submittedQueueDraftText, submittedImages, submittedRecoveredImages, true);
        } else if (!attachmentsConsumed) {
          for (const image of submittedImages) {
            try {
              terminal.attachInputImage(image);
            } catch (error) {
              terminal.notify(`Could not restore image attachment: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          }
        }
        if (!submittedRecoveredQueueDraft && submittedRecoveredImages.length > 0 && !recoveredImagesCommitted) {
          try {
            terminal.restoreQueuedMessages([{ mode: "steer", text: "", images: submittedRecoveredImages }]);
          } catch (error) {
            terminal.notify(`Could not restore recovered image payload: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        }
      }
    }
  } finally {
    uninstallEmergencyRecovery?.();
    acceptActions = false;
    if (runtime !== undefined && stagedQueueLease !== undefined) {
      try { runtime.service.releaseQueueLease(stagedQueueLease); } catch {}
      stagedQueueLease = undefined;
    }
    modelRefreshAbort?.abort(new Error("Terminal session closed"));
    fileRefreshAbort?.abort(new Error("Terminal session closed"));
    extensionActionAbort?.abort(new Error("Terminal session closed"));
    terminal.setInterruptHandler(undefined);
    catalogAbort.abort(new Error("Terminal session closed"));
    extensionSessionPublicationCleanup?.();
    extensionSessionPublicationCleanup = undefined;
    await terminal.drainInput().catch(() => undefined);
    terminal.close();
    await actionQueue.catch(() => undefined);
    await inputDeliveryQueue.catch(() => undefined);
    await endExtensionSession();
    if (runtime !== undefined && ephemeral) {
      for (const id of ephemeralThreads) {
        try {
          await runtime.service.deleteSession(id);
        } catch {}
      }
    }
    uninstallTermination();
    await Promise.allSettled([...catalogTasks]);
    await sessionIndexTail;
    const resumeCommand = runtime !== undefined && threadId !== "" && !ephemeral
      && runtime.store.listEvents(threadId, branch).length > 0
      ? formatResumeCommand(threadId, flagString(argumentsValue, "session-dir"))
      : undefined;
    if (runtime !== undefined && threadId !== "") {
      try {
        await removeEmptyThread(runtime, threadId, sessionIndex);
      } catch {}
    }
    if (resumeCommand !== undefined && process.stdout.isTTY) {
      process.stdout.write(`To resume this session: ${resumeCommand}\n`);
    }
    try {
      await runtime?.close();
    } finally {
      await startupPreviousRuntime?.close().catch(() => undefined);
      sessionIndex?.close();
    }
  }
}

function printValue(value: unknown, json: boolean): void {
  if (json) writeMachineOutput(`${JSON.stringify(value)}\n`);
  else writeMachineOutput(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function openBrowser(url: URL, disabled: boolean): void {
  if (disabled) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

async function listModelsFlagCommand(argumentsValue: ParsedArguments): Promise<void> {
  const runtime = await loadRuntime({
    ...runtimeOptions(argumentsValue),
    ...invocationExtensionOptions(argumentsValue),
    extensionRuntime: true,
    recover: false,
  });
  try {
    const rawSearch = argumentsValue.flags.get("list-models");
    const search = typeof rawSearch === "string" ? rawSearch.trim().toLowerCase() : "";
    const available: string[] = [];
    for (const adapter of runtime.providers.list()) {
      const state = await runtime.auth.state(adapter.id);
      if (state.status === "connected" || (
        state.status === "available"
        && state.source !== undefined
        && state.error === undefined
      )) available.push(adapter.id);
    }
    const catalogs = await Promise.all(available.map(async (provider) => {
      try {
        return await runtime.providers.listModels(provider, AbortSignal.timeout(30_000), {
          refresh: !flagBoolean(argumentsValue, "offline"),
        });
      } catch {
        return [];
      }
    }));
    const models = catalogs.flat()
      .filter((model) => model.provider !== "openai" || isAgentOpenAIModel(model.id))
      .filter((model) => search === "" || [model.provider, model.id, model.displayName, model.description]
        .some((value) => value?.toLowerCase().includes(search) === true))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
    if (flagBoolean(argumentsValue, "json")) printValue(models, true);
    else if (models.length === 0) writeMachineOutput("No matching models from available providers. Use /login to connect one.\n");
    else for (const model of models) {
      const context = model.contextTokens === undefined ? "" : `  ${model.contextTokens.toLocaleString()} context`;
      const display = model.displayName === undefined ? "" : `  ${model.displayName}`;
      writeMachineOutput(`${model.provider}/${model.id}${context}${display}\n`);
    }
  } finally {
    await runtime.close();
  }
}

async function exportFlagCommand(argumentsValue: ParsedArguments): Promise<void> {
  const output = flagString(argumentsValue, "export");
  if (output === undefined) throw new Error("--export requires an output file");
  if (flagBoolean(argumentsValue, "no-session")) throw new Error("--export cannot be combined with --no-session");
  const runtime = await loadRuntime({
    ...runtimeOptions(argumentsValue),
    extensions: false,
    extensionRuntime: false,
    recover: false,
  });
  try {
    const reference = flagString(argumentsValue, "session-id")
      ?? flagString(argumentsValue, "session")
      ?? flagString(argumentsValue, "thread");
    const thread = reference === undefined
      ? runtime.store.listThreads({ workspaceRoot: runtime.workspace, limit: 1 })[0]
      : resolveSessionReference(runtime.store, reference, { workspaceRoot: runtime.workspace });
    if (thread === undefined) throw new Error("No saved session exists in this workspace");
    const branch = flagString(argumentsValue, "branch");
    const lower = output.toLowerCase();
    const data = lower.endsWith(".jsonl")
      ? runtime.store.exportThread(thread.threadId)
      : lower.endsWith(".md") || lower.endsWith(".markdown")
        ? exportThreadMarkdown(runtime.store, thread.threadId, branch)
        : exportThreadHtml(runtime.store, thread.threadId, branch);
    if (output === "-") {
      writeMachineOutput(data.endsWith("\n") ? data : `${data}\n`);
      return;
    }
    const outputPath = expandPath(output, runtime.workspace);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (!flagBoolean(argumentsValue, "json")) process.stderr.write(`Exported ${thread.threadId} to ${outputPath}.\n`);
    else printValue({ threadId: thread.threadId, path: outputPath }, true);
  } finally {
    await runtime.close();
  }
}

async function configCommand(argumentsValue: ParsedArguments): Promise<void> {
  const action = argumentsValue.positionals[0];
  if (action === undefined) {
    await runPackageConfigCommand(argumentsValue);
    return;
  }
  const paths = harnessPaths();
  const workspace = expandPath(flagString(argumentsValue, "workspace") ?? process.cwd());
  const trust = new TrustStore(paths.trustStore);
  if (action === "trust") {
    if (!flagBoolean(argumentsValue, "yes")) {
      throw new Error("Trust enables project configuration, extensions, skills, prompts, and themes; pass --yes after review");
    }
    await trust.trust(workspace);
  } else if (action === "untrust") await trust.untrust(workspace);
  else if (action === "trusted") printValue(await trust.list(), flagBoolean(argumentsValue, "json"));
  else if (action === "show") {
    const trusted = await trust.isTrusted(workspace);
    const resolved = resolveConfig({
      globalPath: paths.globalConfig,
      projectPath: join(workspace, ".rigyn", "config.jsonc"),
      projectTrusted: trusted,
    });
    printValue({
      ...parseHarnessConfig(resolved.value),
      sources: resolved.appliedSources,
      projectIgnored: resolved.projectIgnored,
    }, flagBoolean(argumentsValue, "json"));
  } else throw new Error(`Unknown config action: ${action}`);
}

async function runLifecycleOwnedCommand(operation: () => Promise<void>): Promise<void> {
  await withGracefulTermination(async (termination) => {
    termination.throwIfTerminated();
    await operation();
    termination.throwIfTerminated();
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let argumentsValue = parseArguments(argv, { deferUnknown: true });
  if (argumentsValue.deferredFlags.length > 0 && (
    (argumentsValue.command !== "run" && argumentsValue.command !== "chat")
    || flagBoolean(argumentsValue, "help")
    || flagBoolean(argumentsValue, "version")
  )) {
    argumentsValue = parseArguments(argv);
  }
  const outputMode = flagString(argumentsValue, "mode") ?? "text";
  if (outputMode !== "text" && outputMode !== "json" && outputMode !== "rpc") {
    throw new Error("--mode must be text, json, or rpc");
  }
  if (outputMode === "json") argumentsValue.flags.set("json", true);
  const machineOutput = outputMode === "rpc"
    || argumentsValue.flags.has("list-models")
    || argumentsValue.flags.has("export")
    || argumentsValue.command === "rpc"
    || argumentsValue.command === "diagnostics"
    || flagBoolean(argumentsValue, "json")
    || flagBoolean(argumentsValue, "print")
    || (argumentsValue.command === "run" && !process.stdout.isTTY);
  const execute = async (): Promise<void> => {
    if (flagBoolean(argumentsValue, "version")) {
      writeMachineOutput(`${RIGYN_VERSION}\n`);
      return;
    }
    if (flagBoolean(argumentsValue, "help") || argumentsValue.command === "help") {
      const topic = argumentsValue.command === "help"
        ? argumentsValue.positionals[0]
        : argumentsValue.source.includes(argumentsValue.command)
          ? argumentsValue.command
          : undefined;
      writeMachineOutput(renderCliHelp(topic));
      return;
    }
    if (outputMode === "rpc") {
      await runRpcServer(argumentsValue);
      return;
    }
    if (argumentsValue.flags.has("list-models")) {
      await listModelsFlagCommand(argumentsValue);
      return;
    }
    if (argumentsValue.flags.has("export")) {
      await exportFlagCommand(argumentsValue);
      return;
    }
    switch (argumentsValue.command) {
      case "run": await runCommand(argumentsValue); break;
      case "chat": await chatCommand(argumentsValue); break;
      case "config": await configCommand(argumentsValue); break;
      case "diagnostics": await runDiagnosticsCommand(argumentsValue); break;
      case "sessions": await runLifecycleOwnedCommand(async () => await runSessionsCommand(argumentsValue)); break;
      case "extensions": await runLifecycleOwnedCommand(async () => await runExtensionsCommand(argumentsValue)); break;
      case "packages": await runLifecycleOwnedCommand(async () => await runProjectPackageCommand(argumentsValue)); break;
      case "install":
      case "remove":
      case "update":
      case "list": await runLifecycleOwnedCommand(async () => await runPackageCommand(argumentsValue)); break;
      case "self-install": await runProductInstallAction("install"); break;
      case "self-update": await runProductInstallAction("update"); break;
      case "uninstall":
      case "self-uninstall":
        if (argumentsValue.positionals.length > 0) throw new Error("Product uninstall does not accept a package source; use `rigyn remove SOURCE` for extensions");
        await runProductInstallAction("uninstall", { yes: flagBoolean(argumentsValue, "yes") });
        break;
      case "rpc": await runRpcServer(argumentsValue); break;
      default: throw new Error(`Unknown command: ${argumentsValue.command}`);
    }
  };
  if (machineOutput) await withMachineOutputGuard(execute);
  else await execute();
}
