import type { RuntimeProviderConfig } from "../service/provider-factory.js";
import type { JsonObject } from "./jsonc.js";
import type { OAuthRegistrationConfig } from "../auth/index.js";
import type { QueueMode } from "../core/agent.js";
import {
  normalizeChildRunPolicy,
  type ChildRunPolicy,
} from "../core/child-runs.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../core/retry.js";
import type { OutboundImagePolicy } from "../core/types.js";
import type { NetworkProxyOptions } from "../net/index.js";
import { parseConfiguredModels, type ConfiguredModel } from "../providers/registry.js";
import { isAbsolute } from "node:path";

export interface HarnessHttpTransportConfig {
  proxy?: NetworkProxyOptions;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export interface HarnessExecutionBackendConfig {
  id: string;
  argv: [string, ...string[]];
  cwd: string;
  workspace: string;
  tools: Record<string, "read" | "write">;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export interface HarnessConfig {
  defaultProvider?: string;
  defaultModel?: string;
  theme?: string;
  thinking?: string;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  outboundImages: OutboundImagePolicy;
  scopedModels: string[];
  packageResources: Record<string, string[]>;
  databasePath?: string;
  shellPath?: string;
  npmCommand?: string[];
  gitCommand?: string[];
  executionBackend?: HarnessExecutionBackendConfig;
  httpTransport: HarnessHttpTransportConfig;
  providerRetry: RetryPolicy;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  autoCompaction: boolean;
  compactionRetainRecentTurns: number;
  compactionToolResultBytes: number;
  maxSteps?: number;
  childRuns: ChildRunPolicy;
  providers: Record<string, RuntimeProviderConfig>;
  models: ConfiguredModel[];
  oauthRegistrations: Record<string, OAuthRegistrationConfig>;
  skillRoots: string[];
  extensionRoots: string[];
  doubleEscapeAction: "tree" | "fork" | "none";
  defaultProjectTrust: DefaultProjectTrust;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (result === undefined) throw new Error(`${label} is required`);
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown, label: string, minimum = 1): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return value as number;
}

function parseChildRuns(value: unknown): ChildRunPolicy {
  if (value === undefined) return normalizeChildRunPolicy(undefined);
  const input = object(value, "childRuns");
  const fields = [
    "maxConcurrent",
    "defaultMaxSteps",
    "maxSteps",
    "defaultTimeoutMs",
    "maxTimeoutMs",
    "defaultOutputLimitBytes",
    "maxOutputLimitBytes",
  ] as const satisfies readonly (keyof ChildRunPolicy)[];
  assertAllowed(input, [...fields], "childRuns");
  return normalizeChildRunPolicy(Object.fromEntries(
    fields.flatMap((field) => input[field] === undefined ? [] : [[field, input[field]]]),
  ));
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function commandArgv(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const selected = stringArray(value, label);
  if (selected.length < 1 || selected.length > 32 || selected.some((entry) => entry.includes("\0") || Buffer.byteLength(entry) > 4096)) {
    throw new Error(`${label} must contain 1 through 32 arguments no larger than 4096 bytes`);
  }
  return selected;
}

function parseExecutionBackend(value: unknown): HarnessExecutionBackendConfig | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "executionBackend");
  assertAllowed(
    input,
    ["id", "argv", "cwd", "workspace", "tools", "timeoutMs", "outputLimitBytes"],
    "executionBackend",
  );
  const id = requiredString(input.id, "executionBackend.id");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(id)) throw new Error("executionBackend.id is invalid");
  const argv = commandArgv(input.argv, "executionBackend.argv");
  if (argv === undefined || !isAbsolute(argv[0]!)) {
    throw new Error("executionBackend.argv[0] must be an absolute executable path");
  }
  const cwd = requiredString(input.cwd, "executionBackend.cwd");
  if (!isAbsolute(cwd) || cwd.includes("\0") || Buffer.byteLength(cwd) > 4096) {
    throw new Error("executionBackend.cwd must be an absolute path no larger than 4096 bytes");
  }
  const workspace = requiredString(input.workspace, "executionBackend.workspace");
  if (workspace.includes("\0") || Buffer.byteLength(workspace) > 4096) {
    throw new Error("executionBackend.workspace must be no larger than 4096 bytes and contain no NUL");
  }
  const configuredTools = object(input.tools, "executionBackend.tools");
  if (Object.keys(configuredTools).length < 1 || Object.keys(configuredTools).length > 128) {
    throw new Error("executionBackend.tools must contain between 1 and 128 tools");
  }
  const tools: Record<string, "read" | "write"> = {};
  for (const [name, mode] of Object.entries(configuredTools)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(name) || (mode !== "read" && mode !== "write")) {
      throw new Error(`executionBackend.tools.${name || "<empty>"} must be read or write`);
    }
    tools[name] = mode;
  }
  const timeoutMs = optionalInteger(input.timeoutMs, "executionBackend.timeoutMs");
  const outputLimitBytes = optionalInteger(input.outputLimitBytes, "executionBackend.outputLimitBytes");
  if ((timeoutMs ?? 0) > 60 * 60_000) throw new Error("executionBackend.timeoutMs must not exceed 3600000");
  if ((outputLimitBytes ?? 0) > 16 * 1024 * 1024) {
    throw new Error("executionBackend.outputLimitBytes must not exceed 16777216");
  }
  return {
    id,
    argv: argv as [string, ...string[]],
    cwd,
    workspace,
    tools,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
  };
}

function packageResourceFilters(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  const input = object(value, "packageResources");
  if (Object.keys(input).length > 256) throw new Error("packageResources cannot contain more than 256 packages");
  const result: Record<string, string[]> = {};
  for (const [extensionId, raw] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(extensionId)) throw new Error(`packageResources contains an invalid package ID: ${extensionId}`);
    const values = stringArray(raw, `packageResources.${extensionId}`);
    if (values.length > 512 || values.some((entry) => entry.includes("\0") || Buffer.byteLength(entry) > 4096)) {
      throw new Error(`packageResources.${extensionId} exceeds its resource limits`);
    }
    result[extensionId] = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  }
  return result;
}

function assertAllowed(input: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function proxySetting(value: unknown, label: string): string | false | undefined {
  if (value === undefined || value === false) return value;
  if (typeof value !== "string" || value === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 8 * 1024) {
    throw new Error(`${label} must be false or a non-empty proxy URL no larger than 8192 bytes`);
  }
  return value;
}

function parseHttpTransport(value: unknown): HarnessHttpTransportConfig {
  if (value === undefined) return {};
  const input = object(value, "httpTransport");
  assertAllowed(input, ["proxy", "connectTimeoutMs", "headersTimeoutMs", "bodyTimeoutMs"], "httpTransport");
  let proxy: NetworkProxyOptions | undefined;
  if (input.proxy !== undefined) {
    const configured = object(input.proxy, "httpTransport.proxy");
    assertAllowed(configured, ["http", "https", "all", "noProxy"], "httpTransport.proxy");
    proxy = {
      ...(configured.http === undefined ? {} : { http: proxySetting(configured.http, "httpTransport.proxy.http")! }),
      ...(configured.https === undefined ? {} : { https: proxySetting(configured.https, "httpTransport.proxy.https")! }),
      ...(configured.all === undefined ? {} : { all: proxySetting(configured.all, "httpTransport.proxy.all")! }),
      ...(configured.noProxy === undefined ? {} : { noProxy: proxySetting(configured.noProxy, "httpTransport.proxy.noProxy")! }),
    };
  }
  const connectTimeoutMs = optionalInteger(input.connectTimeoutMs, "httpTransport.connectTimeoutMs");
  const headersTimeoutMs = optionalInteger(input.headersTimeoutMs, "httpTransport.headersTimeoutMs");
  const bodyTimeoutMs = optionalInteger(input.bodyTimeoutMs, "httpTransport.bodyTimeoutMs");
  for (const [label, timeout] of Object.entries({ connectTimeoutMs, headersTimeoutMs, bodyTimeoutMs })) {
    if (timeout !== undefined && timeout > 10 * 60_000) throw new Error(`httpTransport.${label} must not exceed 600000`);
  }
  return {
    ...(proxy === undefined ? {} : { proxy }),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...(headersTimeoutMs === undefined ? {} : { headersTimeoutMs }),
    ...(bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs }),
  };
}

function parseProviderRetry(value: unknown): RetryPolicy {
  if (value === undefined) return { ...DEFAULT_RETRY_POLICY };
  const input = object(value, "providerRetry");
  assertAllowed(input, ["maxAttempts", "baseDelayMs", "maxDelayMs", "jitter"], "providerRetry");
  const maxAttempts = optionalInteger(input.maxAttempts, "providerRetry.maxAttempts") ?? DEFAULT_RETRY_POLICY.maxAttempts;
  const baseDelayMs = optionalInteger(input.baseDelayMs, "providerRetry.baseDelayMs", 0) ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  const maxDelayMs = optionalInteger(input.maxDelayMs, "providerRetry.maxDelayMs", 0) ?? DEFAULT_RETRY_POLICY.maxDelayMs;
  const jitter = input.jitter === undefined ? DEFAULT_RETRY_POLICY.jitter : input.jitter;
  if (maxAttempts > 10) throw new Error("providerRetry.maxAttempts must not exceed 10");
  if (baseDelayMs > 600_000 || maxDelayMs > 600_000) throw new Error("providerRetry delays must not exceed 600000");
  if (baseDelayMs > maxDelayMs) throw new Error("providerRetry.baseDelayMs must not exceed maxDelayMs");
  if (typeof jitter !== "number" || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error("providerRetry.jitter must be a finite number from 0 through 1");
  }
  return { maxAttempts, baseDelayMs, maxDelayMs, jitter };
}

function parseAnthropicThinking(value: unknown, label: string): Extract<RuntimeProviderConfig, { kind: "anthropic" }>["thinking"] {
  if (value === undefined) return undefined;
  const input = object(value, label);
  assertAllowed(input, ["budgets", "models"], label);

  let budgets: NonNullable<Extract<RuntimeProviderConfig, { kind: "anthropic" }>["thinking"]>["budgets"];
  if (input.budgets !== undefined) {
    const configured = object(input.budgets, `${label}.budgets`);
    const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    assertAllowed(configured, [...efforts], `${label}.budgets`);
    budgets = {};
    for (const effort of efforts) {
      const budget = optionalInteger(configured[effort], `${label}.budgets.${effort}`, 1024);
      if (budget !== undefined && budget > 1_000_000) {
        throw new Error(`${label}.budgets.${effort} must not exceed 1000000`);
      }
      if (budget !== undefined) budgets[effort] = budget;
    }
  }

  let models: NonNullable<Extract<RuntimeProviderConfig, { kind: "anthropic" }>["thinking"]>["models"];
  if (input.models !== undefined) {
    const configured = object(input.models, `${label}.models`);
    if (Object.keys(configured).length > 256) throw new Error(`${label}.models cannot contain more than 256 entries`);
    models = {};
    for (const [model, rawCompatibility] of Object.entries(configured)) {
      if (model === "" || model.includes("\0") || Buffer.byteLength(model, "utf8") > 256) {
        throw new Error(`${label}.models keys must contain 1 through 256 bytes without NUL`);
      }
      const compatibility = object(rawCompatibility, `${label}.models.${model}`);
      assertAllowed(compatibility, ["mode", "off", "interleaved", "allowEmptySignature"], `${label}.models.${model}`);
      const mode = optionalString(compatibility.mode, `${label}.models.${model}.mode`);
      if (mode !== undefined && mode !== "adaptive" && mode !== "enabled") {
        throw new Error(`${label}.models.${model}.mode must be adaptive or enabled`);
      }
      const off = optionalString(compatibility.off, `${label}.models.${model}.off`);
      if (off !== undefined && off !== "omit" && off !== "disabled" && off !== "always-on") {
        throw new Error(`${label}.models.${model}.off must be omit, disabled, or always-on`);
      }
      const interleaved = optionalString(compatibility.interleaved, `${label}.models.${model}.interleaved`);
      if (interleaved !== undefined && interleaved !== "automatic" && interleaved !== "beta" && interleaved !== "off") {
        throw new Error(`${label}.models.${model}.interleaved must be automatic, beta, or off`);
      }
      const allowEmptySignature = optionalBoolean(
        compatibility.allowEmptySignature,
        `${label}.models.${model}.allowEmptySignature`,
      );
      models[model] = {
        ...(mode === undefined ? {} : { mode }),
        ...(off === undefined ? {} : { off }),
        ...(interleaved === undefined ? {} : { interleaved }),
        ...(allowEmptySignature === undefined ? {} : { allowEmptySignature }),
      };
    }
  }

  return {
    ...(budgets === undefined ? {} : { budgets }),
    ...(models === undefined ? {} : { models }),
  };
}

function parseProvider(value: unknown, name: string): RuntimeProviderConfig {
  const input = object(value, `providers.${name}`);
  const kind = optionalString(input.kind, `providers.${name}.kind`) ?? name;
  const baseUrl = optionalString(input.baseUrl, `providers.${name}.baseUrl`);
  if (kind !== "openai-compatible" && name !== kind) {
    throw new Error(`Provider ${name} must use its protocol name ${kind}; aliases are supported only for openai-compatible endpoints`);
  }
  switch (kind) {
    case "openai-codex":
      {
        assertAllowed(input, ["kind", "baseUrl", "transport", "webSocketConnectTimeoutMs", "webSocketIdleTimeoutMs"], `providers.${name}`);
        const transport = optionalString(input.transport, `providers.${name}.transport`);
        if (transport !== undefined && !["sse", "websocket", "websocket-cached", "auto"].includes(transport)) {
          throw new Error(`providers.${name}.transport must be sse, websocket, websocket-cached, or auto`);
        }
        const webSocketConnectTimeoutMs = optionalInteger(input.webSocketConnectTimeoutMs, `providers.${name}.webSocketConnectTimeoutMs`, 0);
        const webSocketIdleTimeoutMs = optionalInteger(input.webSocketIdleTimeoutMs, `providers.${name}.webSocketIdleTimeoutMs`, 0);
        if ((webSocketConnectTimeoutMs ?? 0) > 600_000 || (webSocketIdleTimeoutMs ?? 0) > 600_000) {
          throw new Error(`providers.${name} WebSocket timeouts must not exceed 600000`);
        }
        return {
          kind,
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(transport === undefined ? {} : { transport: transport as "sse" | "websocket" | "websocket-cached" | "auto" }),
          ...(webSocketConnectTimeoutMs === undefined ? {} : { webSocketConnectTimeoutMs }),
          ...(webSocketIdleTimeoutMs === undefined ? {} : { webSocketIdleTimeoutMs }),
        };
      }
    case "openai": {
      assertAllowed(input, ["kind", "baseUrl", "organization", "project", "store", "promptCacheOptions", "promptCacheRetention", "serviceTier", "deferredToolLoading"], `providers.${name}`);
      let promptCacheOptions: { ttl: "30m" } | undefined;
      if (input.promptCacheOptions !== undefined) {
        const configured = object(input.promptCacheOptions, `providers.${name}.promptCacheOptions`);
        assertAllowed(configured, ["ttl"], `providers.${name}.promptCacheOptions`);
        const ttl = requiredString(configured.ttl, `providers.${name}.promptCacheOptions.ttl`);
        if (ttl !== "30m") throw new Error(`providers.${name}.promptCacheOptions.ttl must be 30m`);
        promptCacheOptions = { ttl };
      }
      const promptCacheRetention = optionalString(input.promptCacheRetention, `providers.${name}.promptCacheRetention`);
      if (promptCacheRetention !== undefined && promptCacheRetention !== "in-memory" && promptCacheRetention !== "24h") {
        throw new Error(`providers.${name}.promptCacheRetention must be in-memory or 24h`);
      }
      const serviceTier = optionalString(input.serviceTier, `providers.${name}.serviceTier`);
      if (serviceTier !== undefined && !["auto", "default", "flex", "priority"].includes(serviceTier)) {
        throw new Error(`providers.${name}.serviceTier must be auto, default, flex, or priority`);
      }
      return {
        kind,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(optionalString(input.organization, `providers.${name}.organization`) === undefined ? {} : { organization: input.organization as string }),
        ...(optionalString(input.project, `providers.${name}.project`) === undefined ? {} : { project: input.project as string }),
        ...(optionalBoolean(input.store, `providers.${name}.store`) === undefined ? {} : { store: input.store as boolean }),
        ...(promptCacheOptions === undefined ? {} : { promptCacheOptions }),
        ...(promptCacheRetention === undefined ? {} : { promptCacheRetention }),
        ...(serviceTier === undefined ? {} : { serviceTier: serviceTier as "auto" | "default" | "flex" | "priority" }),
        ...(optionalBoolean(input.deferredToolLoading, `providers.${name}.deferredToolLoading`) === undefined
          ? {}
          : { deferredToolLoading: input.deferredToolLoading as boolean }),
      };
    }
    case "azure-openai":
      assertAllowed(input, ["kind", "endpoint", "store"], `providers.${name}`);
      return {
        kind,
        endpoint: requiredString(input.endpoint, `providers.${name}.endpoint`),
        ...(optionalBoolean(input.store, `providers.${name}.store`) === undefined ? {} : { store: input.store as boolean }),
      };
    case "anthropic":
      assertAllowed(input, ["kind", "baseUrl", "beta", "promptCache", "thinking", "deferredToolLoading"], `providers.${name}`);
      {
        const promptCache = optionalString(input.promptCache, `providers.${name}.promptCache`);
        const thinking = parseAnthropicThinking(input.thinking, `providers.${name}.thinking`);
        if (promptCache !== undefined && promptCache !== "off" && promptCache !== "5m" && promptCache !== "1h") {
          throw new Error(`providers.${name}.promptCache must be off, 5m, or 1h`);
        }
        return {
          kind,
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(input.beta === undefined ? {} : { beta: stringArray(input.beta, `providers.${name}.beta`) }),
          ...(promptCache === undefined ? {} : { promptCache }),
          ...(thinking === undefined ? {} : { thinking }),
          ...(optionalBoolean(input.deferredToolLoading, `providers.${name}.deferredToolLoading`) === undefined
            ? {}
            : { deferredToolLoading: input.deferredToolLoading as boolean }),
        };
      }
    case "github-copilot":
      assertAllowed(input, ["kind", "host"], `providers.${name}`);
      return {
        kind,
        ...(optionalString(input.host, `providers.${name}.host`) === undefined ? {} : { host: input.host as string }),
      };
    case "gemini": {
      assertAllowed(input, ["kind", "protocol", "baseUrl", "store", "userProject"], `providers.${name}`);
      const protocol = optionalString(input.protocol, `providers.${name}.protocol`);
      if (protocol !== undefined && protocol !== "interactions" && protocol !== "generate-content") {
        throw new Error(`providers.${name}.protocol must be interactions or generate-content`);
      }
      const userProject = optionalString(input.userProject, `providers.${name}.userProject`);
      return {
        kind,
        ...(protocol === undefined ? {} : { protocol }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(optionalBoolean(input.store, `providers.${name}.store`) === undefined ? {} : { store: input.store as boolean }),
        ...(userProject === undefined ? {} : { userProject }),
      };
    }
    case "vertex":
      assertAllowed(input, ["kind", "project", "location", "baseUrl", "userProject"], `providers.${name}`);
      return {
        kind,
        project: requiredString(input.project, `providers.${name}.project`),
        ...(optionalString(input.location, `providers.${name}.location`) === undefined ? {} : { location: input.location as string }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(optionalString(input.userProject, `providers.${name}.userProject`) === undefined ? {} : { userProject: input.userProject as string }),
      };
    case "bedrock":
      {
        assertAllowed(input, ["kind", "region", "runtimeEndpoint", "controlEndpoint", "promptCache"], `providers.${name}`);
        const promptCache = optionalString(input.promptCache, `providers.${name}.promptCache`);
        if (promptCache !== undefined && promptCache !== "off" && promptCache !== "5m" && promptCache !== "1h") {
          throw new Error(`providers.${name}.promptCache must be off, 5m, or 1h`);
        }
        return {
          kind,
          region: requiredString(input.region, `providers.${name}.region`),
          ...(optionalString(input.runtimeEndpoint, `providers.${name}.runtimeEndpoint`) === undefined ? {} : { runtimeEndpoint: input.runtimeEndpoint as string }),
          ...(optionalString(input.controlEndpoint, `providers.${name}.controlEndpoint`) === undefined ? {} : { controlEndpoint: input.controlEndpoint as string }),
          ...(promptCache === undefined ? {} : { promptCache }),
        };
      }
    case "openrouter":
      assertAllowed(input, ["kind", "baseUrl", "appName", "siteUrl", "promptCache"], `providers.${name}`);
      {
        const promptCache = optionalString(input.promptCache, `providers.${name}.promptCache`);
        if (promptCache !== undefined && promptCache !== "off" && promptCache !== "5m" && promptCache !== "1h") {
          throw new Error(`providers.${name}.promptCache must be off, 5m, or 1h`);
        }
      return {
        kind,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(optionalString(input.appName, `providers.${name}.appName`) === undefined ? {} : { appName: input.appName as string }),
        ...(optionalString(input.siteUrl, `providers.${name}.siteUrl`) === undefined ? {} : { siteUrl: input.siteUrl as string }),
        ...(promptCache === undefined ? {} : { promptCache }),
      };
    }
    case "mistral": {
      assertAllowed(input, ["kind", "protocol", "baseUrl", "store", "promptCache", "reasoningMode"], `providers.${name}`);
      const protocol = optionalString(input.protocol, `providers.${name}.protocol`);
      if (protocol !== undefined && protocol !== "chat-completions" && protocol !== "conversations") {
        throw new Error(`providers.${name}.protocol must be chat-completions or conversations`);
      }
      const promptCache = optionalString(input.promptCache, `providers.${name}.promptCache`);
      if (promptCache !== undefined && promptCache !== "off" && promptCache !== "session") {
        throw new Error(`providers.${name}.promptCache must be off or session`);
      }
      const reasoningMode = optionalString(input.reasoningMode, `providers.${name}.reasoningMode`);
      if (reasoningMode !== undefined && reasoningMode !== "effort" && reasoningMode !== "prompt") {
        throw new Error(`providers.${name}.reasoningMode must be effort or prompt`);
      }
      const store = optionalBoolean(input.store, `providers.${name}.store`);
      if (protocol !== "conversations" && store !== undefined) {
        throw new Error(`providers.${name}.store is available only with protocol conversations`);
      }
      if (protocol === "conversations" && promptCache !== undefined && promptCache !== "off") {
        throw new Error(`providers.${name}.promptCache must be off with protocol conversations because that API has no prompt_cache_key field`);
      }
      if (protocol === "conversations" && reasoningMode === "prompt") {
        throw new Error(`providers.${name}.reasoningMode must be effort with protocol conversations`);
      }
      return {
        kind,
        ...(protocol === undefined ? {} : { protocol }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(store === undefined ? {} : { store }),
        ...(promptCache === undefined ? {} : { promptCache }),
        ...(reasoningMode === undefined ? {} : { reasoningMode }),
      };
    }
    case "ollama":
      assertAllowed(input, ["kind", "host"], `providers.${name}`);
      return { kind, ...(optionalString(input.host, `providers.${name}.host`) === undefined ? {} : { host: input.host as string }) };
    case "openai-compatible":
      assertAllowed(input, ["kind", "baseUrl", "credentialProvider", "profile"], `providers.${name}`);
      {
        const profile = optionalString(input.profile, `providers.${name}.profile`);
        if (profile !== undefined && ![
          "default", "vercel-ai-gateway", "zai", "kimi-coding", "minimax",
        ].includes(profile)) {
          throw new Error(
            `providers.${name}.profile must be default, vercel-ai-gateway, zai, kimi-coding, or minimax`,
          );
        }
        return {
          kind,
          id: name,
          baseUrl: requiredString(input.baseUrl, `providers.${name}.baseUrl`),
          ...(optionalString(input.credentialProvider, `providers.${name}.credentialProvider`) === undefined ? {} : { credentialProvider: input.credentialProvider as string }),
          ...(profile === undefined ? {} : { profile: profile as "default" | "vercel-ai-gateway" | "zai" | "kimi-coding" | "minimax" }),
        };
      }
    default:
      throw new Error(`Unsupported provider kind: ${kind}`);
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const input = object(value, label);
  if (Object.values(input).some((entry) => typeof entry !== "string")) throw new Error(`${label} values must be strings`);
  return input as Record<string, string>;
}

function oauthEndpoint(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error(`${label} is too large`);
  let endpoint: URL;
  try {
    endpoint = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (endpoint.username !== "" || endpoint.password !== "") throw new Error(`${label} must not contain credentials`);
  if (endpoint.hash !== "") throw new Error(`${label} must not contain a fragment`);
  return endpoint.toString();
}

function parseOAuthRegistrations(value: unknown): Record<string, OAuthRegistrationConfig> {
  if (value === undefined) return {};
  const registrations = object(value, "oauthRegistrations");
  if (Object.keys(registrations).length > 64) throw new Error("oauthRegistrations may contain at most 64 registrations");
  return Object.fromEntries(Object.entries(registrations).map(([id, entry]): [string, OAuthRegistrationConfig] => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new Error(`Invalid OAuth registration name: ${id}`);
    const input = object(entry, `oauthRegistrations.${id}`);
    const flow = requiredString(input.flow, `oauthRegistrations.${id}.flow`);
    const provider = requiredString(input.provider, `oauthRegistrations.${id}.provider`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider)) {
      throw new Error(`oauthRegistrations.${id}.provider is invalid`);
    }
    const clientId = requiredString(input.clientId, `oauthRegistrations.${id}.clientId`);
    if (clientId.includes("\0") || Buffer.byteLength(clientId) > 4096) throw new Error(`oauthRegistrations.${id}.clientId is invalid`);
    const label = optionalString(input.label, `oauthRegistrations.${id}.label`);
    if (label !== undefined && Buffer.byteLength(label) > 256) throw new Error(`oauthRegistrations.${id}.label is too large`);
    const scopes = stringArray(input.scopes, `oauthRegistrations.${id}.scopes`);
    if (scopes.length > 256 || scopes.some((scope) => /[\s\0]/u.test(scope) || Buffer.byteLength(scope) > 1024)) {
      throw new Error(`oauthRegistrations.${id}.scopes are invalid`);
    }
    const tokenEndpoint = oauthEndpoint(input.tokenEndpoint, `oauthRegistrations.${id}.tokenEndpoint`);
    const revocationEndpoint = input.revocationEndpoint === undefined
      ? undefined
      : oauthEndpoint(input.revocationEndpoint, `oauthRegistrations.${id}.revocationEndpoint`);
    if (flow === "pkce") {
      assertAllowed(input, [
        "provider", "flow", "label", "clientId", "authorizationEndpoint", "tokenEndpoint", "revocationEndpoint", "scopes", "callbackPath", "authorizationParameters",
      ], `oauthRegistrations.${id}`);
      const callbackPath = optionalString(input.callbackPath, `oauthRegistrations.${id}.callbackPath`);
      if (callbackPath !== undefined && (!callbackPath.startsWith("/") || callbackPath.includes("?") || callbackPath.includes("#") || Buffer.byteLength(callbackPath) > 1024)) {
        throw new Error(`oauthRegistrations.${id}.callbackPath must be an absolute URL path`);
      }
      const authorizationParameters = input.authorizationParameters === undefined
        ? undefined
        : stringRecord(input.authorizationParameters, `oauthRegistrations.${id}.authorizationParameters`);
      if (authorizationParameters !== undefined && (
        Object.keys(authorizationParameters).length > 64 ||
        Object.entries(authorizationParameters).some(([name, parameter]) =>
          name === "" ||
          !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(name) ||
          Buffer.byteLength(name) > 256 ||
          ["client_id", "client_secret", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "state"].includes(name.toLowerCase()) ||
          /secret|password|token/iu.test(name) ||
          /[\0\r\n]/u.test(parameter) ||
          Buffer.byteLength(parameter) > 4096)
      )) throw new Error(`oauthRegistrations.${id}.authorizationParameters are invalid`);
      return [id, {
        provider,
        flow,
        clientId,
        authorizationEndpoint: oauthEndpoint(input.authorizationEndpoint, `oauthRegistrations.${id}.authorizationEndpoint`),
        tokenEndpoint,
        ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
        scopes,
        ...(label === undefined ? {} : { label }),
        ...(callbackPath === undefined ? {} : { callbackPath }),
        ...(authorizationParameters === undefined ? {} : { authorizationParameters }),
      }];
    }
    if (flow === "device") {
      assertAllowed(input, ["provider", "flow", "label", "clientId", "deviceEndpoint", "tokenEndpoint", "revocationEndpoint", "scopes"], `oauthRegistrations.${id}`);
      return [id, {
        provider,
        flow,
        clientId,
        deviceEndpoint: oauthEndpoint(input.deviceEndpoint, `oauthRegistrations.${id}.deviceEndpoint`),
        tokenEndpoint,
        ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
        scopes,
        ...(label === undefined ? {} : { label }),
      }];
    }
    throw new Error(`oauthRegistrations.${id}.flow must be pkce or device`);
  }));
}

export function parseHarnessConfig(value: JsonObject): HarnessConfig {
  assertAllowed(value, [
    "defaultProvider", "defaultModel", "theme", "thinking", "steeringMode", "followUpMode", "outboundImages", "scopedModels", "packageResources", "databasePath", "shellPath", "npmCommand", "gitCommand", "executionBackend", "httpTransport", "providerRetry",
    "contextTokenBudget", "summaryTokenBudget", "autoCompaction", "compactionRetainRecentTurns", "compactionToolResultBytes", "maxSteps", "childRuns", "providers", "models", "oauthRegistrations", "skillRoots", "extensionRoots", "doubleEscapeAction", "defaultProjectTrust",
  ], "configuration");
  const providersInput = value.providers === undefined ? {} : object(value.providers, "providers");
  const providers = Object.fromEntries(Object.entries(providersInput).map(([name, entry]) => [name, parseProvider(entry, name)]));
  const defaultProvider = optionalString(value.defaultProvider, "defaultProvider");
  const defaultModel = optionalString(value.defaultModel, "defaultModel");
  const theme = optionalString(value.theme, "theme");
  const thinking = optionalString(value.thinking, "thinking");
  if (thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
    throw new Error("thinking must be off, minimal, low, medium, high, xhigh, or max");
  }
  const steeringMode = optionalString(value.steeringMode, "steeringMode") ?? "one-at-a-time";
  const followUpMode = optionalString(value.followUpMode, "followUpMode") ?? "one-at-a-time";
  if (steeringMode !== "all" && steeringMode !== "one-at-a-time") {
    throw new Error("steeringMode must be all or one-at-a-time");
  }
  if (followUpMode !== "all" && followUpMode !== "one-at-a-time") {
    throw new Error("followUpMode must be all or one-at-a-time");
  }
  const outboundImages = optionalString(value.outboundImages, "outboundImages") ?? "allow";
  if (outboundImages !== "allow" && outboundImages !== "block") {
    throw new Error("outboundImages must be allow or block");
  }
  const scopedModels = stringArray(value.scopedModels, "scopedModels");
  if (scopedModels.length > 100 || scopedModels.some((pattern) => Buffer.byteLength(pattern) > 256)) {
    throw new Error("scopedModels must contain at most 100 patterns no larger than 256 bytes");
  }
  const packageResources = packageResourceFilters(value.packageResources);
  const databasePath = optionalString(value.databasePath, "databasePath");
  const shellPath = optionalString(value.shellPath, "shellPath");
  if (shellPath !== undefined && (!isAbsolute(shellPath) || shellPath.includes("\0") || Buffer.byteLength(shellPath) > 4096)) {
    throw new Error("shellPath must be an absolute path no larger than 4096 bytes");
  }
  const npmCommand = commandArgv(value.npmCommand, "npmCommand");
  const gitCommand = commandArgv(value.gitCommand, "gitCommand");
  const contextTokenBudget = optionalInteger(value.contextTokenBudget, "contextTokenBudget");
  const summaryTokenBudget = optionalInteger(value.summaryTokenBudget, "summaryTokenBudget");
  const autoCompaction = optionalBoolean(value.autoCompaction, "autoCompaction") ?? true;
  const doubleEscapeAction = optionalString(value.doubleEscapeAction, "doubleEscapeAction") ?? "tree";
  if (doubleEscapeAction !== "tree" && doubleEscapeAction !== "fork" && doubleEscapeAction !== "none") {
    throw new Error("doubleEscapeAction must be tree, fork, or none");
  }
  const defaultProjectTrust = optionalString(value.defaultProjectTrust, "defaultProjectTrust") ?? "ask";
  if (defaultProjectTrust !== "ask" && defaultProjectTrust !== "always" && defaultProjectTrust !== "never") {
    throw new Error("defaultProjectTrust must be ask, always, or never");
  }
  const compactionRetainRecentTurns = optionalInteger(value.compactionRetainRecentTurns, "compactionRetainRecentTurns", 0) ?? 2;
  if (compactionRetainRecentTurns > 1_000) throw new Error("compactionRetainRecentTurns must not exceed 1000");
  const compactionToolResultBytes = optionalInteger(value.compactionToolResultBytes, "compactionToolResultBytes", 64) ?? 4 * 1_024;
  if (compactionToolResultBytes > 1024 * 1024) throw new Error("compactionToolResultBytes must not exceed 1048576");
  const extensionRoots = stringArray(value.extensionRoots, "extensionRoots");
  if (extensionRoots.length > 32 || extensionRoots.some((path) => path.includes("\0") || Buffer.byteLength(path) > 4096)) {
    throw new Error("extensionRoots must contain at most 32 paths no larger than 4096 bytes");
  }
  return {
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(theme === undefined ? {} : { theme }),
    ...(thinking === undefined ? {} : { thinking }),
    steeringMode,
    followUpMode,
    outboundImages,
    scopedModels,
    packageResources,
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(shellPath === undefined ? {} : { shellPath }),
    ...(npmCommand === undefined ? {} : { npmCommand }),
    ...(gitCommand === undefined ? {} : { gitCommand }),
    ...(value.executionBackend === undefined ? {} : { executionBackend: parseExecutionBackend(value.executionBackend)! }),
    httpTransport: parseHttpTransport(value.httpTransport),
    providerRetry: parseProviderRetry(value.providerRetry),
    ...(contextTokenBudget === undefined ? {} : { contextTokenBudget }),
    ...(summaryTokenBudget === undefined ? {} : { summaryTokenBudget }),
    autoCompaction,
    compactionRetainRecentTurns,
    compactionToolResultBytes,
    ...(value.maxSteps === undefined ? {} : { maxSteps: optionalInteger(value.maxSteps, "maxSteps")! }),
    childRuns: parseChildRuns(value.childRuns),
    providers,
    models: parseConfiguredModels(value.models),
    oauthRegistrations: parseOAuthRegistrations(value.oauthRegistrations),
    skillRoots: stringArray(value.skillRoots, "skillRoots"),
    extensionRoots,
    doubleEscapeAction,
    defaultProjectTrust,
  };
}
