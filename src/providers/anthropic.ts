import type { JsonValue } from "../core/json.js";
import { RIGYN_VERSION } from "../version.js";
import type {
  AdapterEvent,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderState,
} from "../core/types.js";
import { requireBody } from "./lines.js";
import { normalizeImageSource, requireImageMediaType, requireImageUrlProtocol } from "./images.js";
import { sanitizeUnicode, stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { decodeSSE } from "./sse.js";
import { requestAnthropicWithSdk } from "./anthropic-sdk-transport.js";
import { toolResultText } from "./tool-results.js";
import { mergeUsageSnapshots, normalizeUsage } from "./usage.js";
import {
  baseModelCompatibility,
  capabilityModalities,
  modelEvidence,
  providerReasoningEfforts,
} from "./model-metadata.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  assertResponseOk,
  assertSecureEndpoint,
  type FetchLike,
  InvalidProviderRequestError,
  jsonValueOrString,
  normalizeError,
  PrematureStreamEndError,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
  responseDiagnostics,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";

export interface AnthropicConfig {
  /** Public provider identity. Defaults to `anthropic`. */
  id?: ProviderId;
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  oauth?: (signal?: AbortSignal) => boolean | Promise<boolean>;
  beta?: string[];
  baseUrl?: string;
  version?: string;
  defaultMaxOutputTokens?: number;
  headers?: HeadersInit;
  fetch?: FetchLike;
  promptCache?: "off" | "5m" | "1h";
  thinking?: AnthropicThinkingConfig;
  /** Use the current per-tool partial-input streaming contract. Disable only for legacy-compatible endpoints. */
  eagerToolInputStreaming?: boolean;
  /** Enable documented Anthropic server tool search on a compatible endpoint. */
  deferredToolLoading?: boolean;
}

export interface AnthropicThinkingConfig {
  budgets?: Partial<Record<AnthropicReasoningEffort, number>>;
  models?: Record<string, AnthropicModelCompatibility>;
}

export type AnthropicReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicModelCompatibility {
  mode?: "adaptive" | "enabled";
  off?: "omit" | "disabled" | "always-on";
  interleaved?: "automatic" | "beta" | "off";
  allowEmptySignature?: boolean;
}

interface ToolAccumulator {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
  ended: boolean;
}

// Source for the explicit-marker limits: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
const MAX_CACHE_BREAKPOINTS = 4;
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const CACHE_LOOKBACK_BLOCKS = 20;
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const LEGACY_TOOL_INPUT_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const TOOL_SEARCH_TYPE = "tool_search_tool_bm25_20251119";
const TOOL_SEARCH_NAME = "tool_search_tool_bm25";
const MIN_THINKING_BUDGET = 1024;
const RESERVED_ANSWER_TOKENS = 1024;
const MAX_CONFIGURED_THINKING_BUDGET = 1_000_000;
const DEFAULT_THINKING_BUDGETS: Readonly<Record<AnthropicReasoningEffort, number>> = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16_384,
  xhigh: 32_768,
  max: 65_536,
});

interface ResolvedAnthropicModelCompatibility {
  mode: "adaptive" | "enabled";
  off: "omit" | "disabled" | "always-on";
  interleaved: "automatic" | "beta" | "off";
  allowEmptySignature: boolean;
}

const DEFAULT_MODEL_COMPATIBILITY: ResolvedAnthropicModelCompatibility = Object.freeze({
  mode: "enabled",
  off: "omit",
  interleaved: "off",
  allowEmptySignature: false,
});

// Sources: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
// and https://platform.claude.com/docs/en/build-with-claude/extended-thinking
// Live Models API capability metadata and explicit configuration override this offline fallback.
const BUILTIN_MODEL_COMPATIBILITY: ReadonlyArray<readonly [string, AnthropicModelCompatibility]> = [
  ["claude-fable-5", { mode: "adaptive", off: "always-on", interleaved: "automatic" }],
  ["claude-mythos-5", { mode: "adaptive", off: "always-on", interleaved: "automatic" }],
  ["claude-mythos-preview", { mode: "adaptive", off: "always-on", interleaved: "automatic" }],
  ["claude-opus-4-8", { mode: "adaptive", off: "omit", interleaved: "automatic" }],
  ["claude-opus-4-7", { mode: "adaptive", off: "omit", interleaved: "automatic" }],
  ["claude-opus-4-6", { mode: "adaptive", off: "omit", interleaved: "automatic" }],
  ["claude-sonnet-5", { mode: "adaptive", off: "disabled", interleaved: "automatic" }],
  ["claude-sonnet-4-6", { mode: "adaptive", off: "omit", interleaved: "automatic" }],
  ["claude-opus-4-5", { mode: "enabled", off: "omit", interleaved: "beta" }],
  ["claude-sonnet-4-5", { mode: "enabled", off: "omit", interleaved: "beta" }],
  ["claude-opus-4-1", { mode: "enabled", off: "omit", interleaved: "beta" }],
  ["claude-opus-4-20250514", { mode: "enabled", off: "omit", interleaved: "beta" }],
  ["claude-sonnet-4-20250514", { mode: "enabled", off: "omit", interleaved: "beta" }],
  ["claude-haiku-4-5", { mode: "enabled", off: "omit", interleaved: "off" }],
];

const TOOL_SEARCH_MODEL_FAMILIES = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

const OAUTH_TOOL_NAMES = new Map<string, string>([
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["bash", "Bash"],
  ["grep", "Grep"],
]);

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #config: Required<Pick<
    AnthropicConfig,
    "baseUrl" | "version" | "defaultMaxOutputTokens" | "deferredToolLoading" | "eagerToolInputStreaming"
  >> & Omit<
    AnthropicConfig,
    "baseUrl" | "version" | "defaultMaxOutputTokens" | "deferredToolLoading" | "eagerToolInputStreaming"
  >;
  readonly #fetch: FetchLike;
  readonly #discoveredCompatibility = new Map<string, AnthropicModelCompatibility>();

  constructor(config: AnthropicConfig) {
    if (config.promptCache !== undefined && !["off", "5m", "1h"].includes(config.promptCache)) {
      throw new TypeError("Anthropic promptCache must be off, 5m, or 1h");
    }
    if (config.deferredToolLoading !== undefined && typeof config.deferredToolLoading !== "boolean") {
      throw new TypeError("Anthropic deferredToolLoading must be a boolean");
    }
    if (config.eagerToolInputStreaming !== undefined && typeof config.eagerToolInputStreaming !== "boolean") {
      throw new TypeError("Anthropic eagerToolInputStreaming must be a boolean");
    }
    const baseUrl = trimSlash(config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL);
    assertSecureEndpoint(baseUrl, "Anthropic base URL");
    if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(config.id ?? "anthropic")) {
      throw new TypeError("Anthropic provider ID is invalid");
    }
    this.id = config.id ?? "anthropic";
    const thinking = normalizeAnthropicThinkingConfig(config.thinking);
    this.#config = {
      ...config,
      ...(thinking === undefined ? {} : { thinking }),
      baseUrl,
      version: config.version ?? "2023-06-01",
      defaultMaxOutputTokens: config.defaultMaxOutputTokens ?? 8192,
      deferredToolLoading: config.deferredToolLoading ?? baseUrl === DEFAULT_ANTHROPIC_BASE_URL,
      eagerToolInputStreaming: config.eagerToolInputStreaming ?? true,
    };
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;

    try {
      const compatibility = this.#modelCompatibility(request.model);
      const interleavedBeta = shouldRequestInterleavedThinkingBeta(request, compatibility);
      const additionalBeta = [
        ...(interleavedBeta ? [INTERLEAVED_THINKING_BETA] : []),
        ...(request.tools.length > 0 && !this.#config.eagerToolInputStreaming
          ? [LEGACY_TOOL_INPUT_STREAMING_BETA]
          : []),
      ];
      const auth = await this.#headers(signal, additionalBeta);
      const headers = auth.headers;
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      const response = await this.#request("/messages", {
        method: "POST",
        headers,
        body: stringifyProviderJson(buildAnthropicBody(
          request,
          this.#config.defaultMaxOutputTokens,
          this.#config.promptCache ?? "5m",
          compatibility,
          this.#config.thinking?.budgets,
          auth.oauth,
          this.#config.deferredToolLoading,
          this.#config.eagerToolInputStreaming,
        )),
        signal,
      }, auth.apiKey);
      requestId = requestIdFromHeaders(response.headers);
      diagnostics = responseDiagnostics(response);
      await assertResponseOk(response);

      let started = false;
      let responseModel = request.model;
      let responseId: string | undefined;
      let stopReason: string | undefined;
      let refusalExplanation: string | undefined;
      let usageSnapshot: NormalizedUsage | undefined;
      const pendingUsage: NormalizedUsage[] = [];
      const blocks = new Map<number, Record<string, unknown>>();
      const tools = new Map<number, ToolAccumulator>();
      const serverToolInputs = new Map<number, string>();
      const startResponse = (): AdapterEvent[] => {
        if (started) return [];
        started = true;
        const start: AdapterEvent = {
          type: "response_start",
          model: responseModel,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        };
        if (responseId !== undefined) start.responseId = responseId;
        if (requestId !== undefined) start.requestId = requestId;
        const events: AdapterEvent[] = [start];
        for (const usage of pendingUsage) events.push({ type: "usage", usage, semantics: "cumulative" });
        pendingUsage.length = 0;
        return events;
      };

      for await (const sse of decodeSSE(requireBody(response))) {
        const parsed: unknown = parseJson(sse.data);
        const event = asRecord(parsed);
        if (event === undefined) throw new ProtocolError("Anthropic stream event was not an object", jsonValueOrString(parsed));
        const type = asString(event.type) ?? sse.event;
        if (type === undefined) throw new ProtocolError("Anthropic stream event did not contain a type", jsonValueOrString(event));

        if (type === "ping") continue;
        if (type === "error") {
          const error = asRecord(event.error) ?? event;
          throw new ProviderStreamError(
            asString(error.message) ?? "Anthropic stream failed",
            asString(error.type),
            jsonValueOrString(event),
          );
        }

        if (type === "message_start") {
          const message = asRecord(event.message);
          responseModel = asString(message?.model) ?? responseModel;
          responseId = asString(message?.id) ?? responseId;
          const usage = anthropicUsage(message?.usage);
          if (usage !== undefined) {
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, usage);
            if (started) yield { type: "usage", usage: usageSnapshot, semantics: "cumulative" };
            else pendingUsage.push(usageSnapshot);
          }
          continue;
        }

        if (type === "content_block_start") {
          const index = asNumber(event.index) ?? blocks.size;
          const block = asRecord(event.content_block);
          if (block === undefined) throw new ProtocolError("Anthropic content block start omitted its block", jsonValueOrString(event));
          blocks.set(index, { ...block });
          const blockType = asString(block.type);
          if (blockType === "tool_use") {
            const initialInput = asRecord(block.input);
            const tool: ToolAccumulator = {
              index,
              arguments: initialInput === undefined || Object.keys(initialInput).length === 0 ? "" : stringifyProviderJson(initialInput),
              ended: false,
            };
            const id = asString(block.id);
            const wireName = asString(block.name);
            const name = wireName === undefined ? undefined : originalToolName(wireName, request.tools, auth.oauth);
            if (name !== undefined) blocks.get(index)!.name = name;
            if (id !== undefined) tool.id = id;
            if (name !== undefined) tool.name = name;
            tools.set(index, tool);
            partial = true;
            for (const pending of startResponse()) yield pending;
            const start: AdapterEvent = { type: "tool_call_start", index };
            if (id !== undefined) start.id = id;
            if (name !== undefined) start.name = name;
            yield start;
          } else if (blockType === "server_tool_use") {
            const initialInput = asRecord(block.input);
            serverToolInputs.set(
              index,
              initialInput === undefined || Object.keys(initialInput).length === 0 ? "" : stringifyProviderJson(initialInput),
            );
            partial = true;
            for (const pending of startResponse()) yield pending;
          } else if (blockType === "text") {
            const text = asString(block.text) ?? "";
            if (text !== "") {
              partial = true;
              for (const pending of startResponse()) yield pending;
              yield { type: "text_delta", part: index, text };
            }
          } else if (blockType === "thinking") {
            const thinking = asString(block.thinking) ?? "";
            if (thinking !== "") {
              partial = true;
              for (const pending of startResponse()) yield pending;
              yield { type: "reasoning_delta", part: index, text: thinking, visibility: "provider_trace" };
            }
          } else if (blockType !== undefined) {
            partial = true;
            for (const pending of startResponse()) yield pending;
          }
          continue;
        }

        if (type === "content_block_delta") {
          const index = asNumber(event.index) ?? 0;
          const delta = asRecord(event.delta);
          if (delta === undefined) throw new ProtocolError("Anthropic content delta omitted its delta", jsonValueOrString(event));
          const block = blocks.get(index);
          const deltaType = asString(delta.type);
          if (deltaType === "text_delta") {
            const text = asString(delta.text) ?? "";
            appendString(block, "text", text);
            if (text !== "") {
              partial = true;
              for (const pending of startResponse()) yield pending;
              yield { type: "text_delta", part: index, text };
            }
          } else if (deltaType === "thinking_delta") {
            const text = asString(delta.thinking) ?? "";
            appendString(block, "thinking", text);
            if (text !== "") {
              partial = true;
              for (const pending of startResponse()) yield pending;
              yield { type: "reasoning_delta", part: index, text, visibility: "provider_trace" };
            }
          } else if (deltaType === "signature_delta") {
            const signature = asString(delta.signature) ?? "";
            appendString(block, "signature", signature);
            if (signature !== "") {
              partial = true;
              for (const pending of startResponse()) yield pending;
            }
          } else if (deltaType === "input_json_delta") {
            const tool = tools.get(index);
            const fragment = asString(delta.partial_json) ?? "";
            if (tool !== undefined) {
              tool.arguments += fragment;
              partial = true;
              for (const pending of startResponse()) yield pending;
              yield { type: "tool_call_delta", index, jsonFragment: fragment };
            } else if (serverToolInputs.has(index)) {
              serverToolInputs.set(index, (serverToolInputs.get(index) ?? "") + fragment);
              partial = true;
              for (const pending of startResponse()) yield pending;
            } else {
              throw new ProtocolError("Anthropic tool delta preceded its tool block", jsonValueOrString(event));
            }
          } else {
            partial = true;
            for (const pending of startResponse()) yield pending;
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
          }
          continue;
        }

        if (type === "content_block_stop") {
          const index = asNumber(event.index) ?? 0;
          const tool = tools.get(index);
          if (tool !== undefined && !tool.ended) {
            const finished = finishTool(tool);
            const block = blocks.get(index);
            if (block !== undefined && finished.type === "tool_call_end" && finished.arguments !== undefined) {
              block.input = finished.arguments;
            }
            yield finished;
          }
          const serverInput = serverToolInputs.get(index);
          if (serverInput !== undefined) {
            const block = blocks.get(index);
            if (block !== undefined) block.input = parseAnthropicToolInput(serverInput);
          }
          continue;
        }

        if (type === "message_delta") {
          const delta = asRecord(event.delta);
          stopReason = asString(delta?.stop_reason) ?? stopReason;
          if (stopReason === "refusal") {
            const stopDetails = asRecord(delta?.stop_details);
            refusalExplanation = boundedRefusalExplanation(asString(stopDetails?.explanation)) ?? refusalExplanation;
          }
          const usage = anthropicUsage(event.usage);
          if (usage !== undefined) {
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, usage);
            if (started) yield { type: "usage", usage: usageSnapshot, semantics: "cumulative" };
            else pendingUsage.push(usageSnapshot);
          }
          continue;
        }

        if (type === "message_stop") {
          for (const pending of startResponse()) yield pending;
          for (const tool of tools.values()) {
            if (!tool.ended) {
              const finished = finishTool(tool);
              const block = blocks.get(tool.index);
              if (block !== undefined && finished.type === "tool_call_end" && finished.arguments !== undefined) {
                block.input = finished.arguments;
              }
              yield finished;
            }
          }
          terminal = true;
          const end: AdapterEvent = {
            type: "response_end",
            reason: mapAnthropicStop(stopReason, tools.size > 0),
            state: anthropicState(blocks),
          };
          if (stopReason !== undefined) end.rawReason = stopReason;
          if (stopReason === "refusal" && refusalExplanation !== undefined) end.explanation = refusalExplanation;
          yield end;
          return;
        }

        partial = true;
        for (const pending of startResponse()) yield pending;
        yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
      }

      if (!terminal) throw new PrematureStreamEndError("Anthropic stream ended before message_stop");
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const auth = await this.#headers(signal);
    const headers = auth.headers;
    headers.set("accept", "application/json");
    const entries: unknown[] = [];
    const seen = new Set<string>();
    let afterId: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (afterId !== undefined) query.set("after_id", afterId);
      const response = await this.#request(`/models?${query.toString()}`, {
        method: "GET",
        headers,
        signal,
      }, auth.apiKey);
      await assertResponseOk(response);
      const body = asRecord(await readJsonResponse(response));
      entries.push(...asArray(body?.data));
      if (body?.has_more !== true) break;
      const next = asString(body.last_id);
      if (next === undefined || next === "" || seen.has(next)) throw new ProtocolError("Anthropic model catalog returned an invalid cursor");
      seen.add(next);
      afterId = next;
    }
    const observedAt = new Date().toISOString();
    return entries.flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const id = asString(model?.id);
      if (id === undefined) return [];
      const discoveredCompatibility = anthropicCompatibilityFromModel(model);
      if (discoveredCompatibility !== undefined) this.#discoveredCompatibility.set(id, discoveredCompatibility);
      const resolvedCompatibility = this.#modelCompatibility(id);
      const capabilities = capabilitiesFromModel(model, observedAt);
      const compatibility = baseModelCompatibility("anthropic-messages", capabilities.tools, observedAt);
      compatibility.deferredTools = this.#config.deferredToolLoading
        ? anthropicDeferredToolsCapability(id, observedAt)
        : modelEvidence("unknown", "configuration", observedAt);
      const inputModalities = capabilityModalities(capabilities.images, observedAt);
      if (inputModalities !== undefined) compatibility.inputModalities = inputModalities;
      const reasoningEfforts = anthropicReasoningEfforts(model, resolvedCompatibility, observedAt);
      if (reasoningEfforts !== undefined) compatibility.reasoningEfforts = reasoningEfforts;
      const promptCache = this.#config.promptCache ?? "5m";
      compatibility.cacheMode = modelEvidence(promptCache === "off" ? "none" : "explicit", "configuration", observedAt);
      compatibility.cacheAffinity = modelEvidence(promptCache === "off" ? "none" : "prefix", "configuration", observedAt);
      if (promptCache !== "off") compatibility.cacheTiers = modelEvidence([promptCache], "configuration", observedAt);
      const info: ModelInfo = {
        id,
        provider: this.id,
        capabilities,
        compatibility,
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model?.display_name);
      const contextTokens = asNumber(model?.max_input_tokens);
      const maxOutputTokens = asNumber(model?.max_tokens);
      if (displayName !== undefined) info.displayName = displayName;
      if (contextTokens !== undefined) info.contextTokens = contextTokens;
      if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
      return [info];
    });
  }

  #modelCompatibility(model: string): ResolvedAnthropicModelCompatibility {
    const builtin = builtinAnthropicCompatibility(model);
    const discovered = this.#discoveredCompatibility.get(model);
    const configuredDefault = this.#config.thinking?.models?.["*"];
    const configuredModel = this.#config.thinking?.models?.[model];
    return {
      ...DEFAULT_MODEL_COMPATIBILITY,
      ...builtin,
      ...discovered,
      ...configuredDefault,
      ...configuredModel,
    };
  }

  async #headers(
    signal: AbortSignal,
    additionalBeta: readonly string[] = [],
  ): Promise<{ headers: Headers; oauth: boolean; apiKey?: string }> {
    const headers = new Headers(this.#config.headers);
    headers.set("anthropic-version", this.#config.version);
    const accessToken = await resolveToken(this.#config.accessToken, signal);
    if (accessToken !== undefined) {
      const oauth = await this.#config.oauth?.(signal) ?? false;
      const beta = new Set([
        ...(oauth ? ["claude-code-20250219", "oauth-2025-04-20"] : []),
        ...(this.#config.beta ?? []),
        ...additionalBeta,
      ]);
      if (beta.size > 0) headers.set("anthropic-beta", [...beta].join(","));
      if (oauth) {
        headers.set("anthropic-dangerous-direct-browser-access", "true");
        headers.set("user-agent", `rigyn/${RIGYN_VERSION}`);
        headers.set("x-app", "cli");
      }
      headers.set("authorization", `Bearer ${accessToken}`);
      return { headers, oauth };
    }
    const beta = new Set([...(this.#config.beta ?? []), ...additionalBeta]);
    if (beta.size > 0) headers.set("anthropic-beta", [...beta].join(","));
    const apiKey = await resolveToken(this.#config.apiKey, signal);
    if (apiKey !== undefined) headers.set("x-api-key", apiKey);
    return { headers, oauth: false, ...(apiKey === undefined ? {} : { apiKey }) };
  }

  async #request(
    path: string,
    init: { method: "GET" | "POST"; headers: Headers; body?: string; signal: AbortSignal },
    apiKey?: string,
  ): Promise<Response> {
    if (this.#config.baseUrl === DEFAULT_ANTHROPIC_BASE_URL && apiKey !== undefined && apiKey !== "") {
      return await requestAnthropicWithSdk({
        apiKey,
        baseUrl: this.#config.baseUrl,
        path,
        method: init.method,
        headers: init.headers,
        stream: init.headers.get("accept") === "text/event-stream",
        signal: init.signal,
        fetch: this.#fetch,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    }
    return await this.#fetch(`${this.#config.baseUrl}${path}`, { ...init, redirect: "error" });
  }
}

function buildAnthropicBody(
  request: ProviderRequest,
  defaultMaxOutputTokens: number,
  promptCache: "off" | "5m" | "1h",
  compatibility: ResolvedAnthropicModelCompatibility,
  configuredBudgets: AnthropicThinkingConfig["budgets"],
  oauth: boolean,
  deferredToolLoading: boolean,
  eagerToolInputStreaming: boolean,
): Record<string, unknown> {
  request = providerWireRequest(request, request.providerState?.kind === "anthropic_messages");
  const system = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  let messages = buildAnthropicMessages(request, compatibility.allowEmptySignature, oauth);
  const useDeferredTools = deferredToolLoading && anthropicDeferredToolsSupported(request.model) &&
    request.tools.some((tool) => tool.loading === "deferred") &&
    request.tools.every((tool) => outboundToolName(tool.name, oauth) !== TOOL_SEARCH_NAME);
  let tools: Array<Record<string, unknown>> = request.tools.map((tool) => ({
    name: outboundToolName(tool.name, oauth),
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(eagerToolInputStreaming ? { eager_input_streaming: true } : {}),
    ...(useDeferredTools && tool.loading === "deferred" ? { defer_loading: true } : {}),
  }));
  if (useDeferredTools) tools.unshift({ type: TOOL_SEARCH_TYPE, name: TOOL_SEARCH_NAME });
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    messages,
    stream: true,
  };

  if (promptCache !== "off") {
    const cacheControl = {
      type: "ephemeral",
      ...(promptCache === "1h" ? { ttl: "1h" } : {}),
    };
    let remainingBreakpoints = MAX_CACHE_BREAKPOINTS;
    if (tools.length > 0) {
      const lastEager = tools.findLastIndex((tool) => tool.defer_loading !== true);
      if (lastEager >= 0) {
        tools = tools.map((tool, index) => index === lastEager ? { ...tool, cache_control: cacheControl } : tool);
        remainingBreakpoints -= 1;
      }
    }
    if (system !== "") {
      body.system = [{ type: "text", text: system, cache_control: cacheControl }];
      remainingBreakpoints -= 1;
    }
    messages = addAnthropicMessageCacheBreakpoints(messages, remainingBreakpoints, cacheControl);
    body.messages = messages;
  } else if (system !== "") {
    body.system = system;
  }
  if (tools.length > 0) body.tools = tools;
  applyAnthropicThinking(
    body,
    request.reasoningEffort,
    compatibility,
    request.thinkingBudgets === undefined
      ? configuredBudgets
      : { ...configuredBudgets, ...request.thinkingBudgets },
  );
  if (request.metadata !== undefined) body.metadata = request.metadata;
  return body;
}

function applyAnthropicThinking(
  body: Record<string, unknown>,
  effort: string | undefined,
  compatibility: ResolvedAnthropicModelCompatibility,
  configuredBudgets: AnthropicThinkingConfig["budgets"],
): void {
  if (effort === undefined) return;
  if (effort === "off" || effort === "none") {
    if (compatibility.off === "disabled") body.thinking = { type: "disabled" };
    return;
  }
  if (compatibility.mode === "adaptive") {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: effort === "minimal" ? "low" : effort };
    return;
  }

  const maxTokens = asNumber(body.max_tokens);
  if (maxTokens === undefined || !Number.isSafeInteger(maxTokens) || maxTokens <= MIN_THINKING_BUDGET) {
    throw new InvalidProviderRequestError(
      `Anthropic manual thinking requires max_tokens greater than ${MIN_THINKING_BUDGET}`,
    );
  }
  if (!(effort in DEFAULT_THINKING_BUDGETS)) {
    throw new InvalidProviderRequestError(`Anthropic has no manual thinking budget for effort ${JSON.stringify(effort)}`);
  }
  const reasoningEffort = effort as AnthropicReasoningEffort;
  const requestedBudget = Math.max(
    MIN_THINKING_BUDGET,
    configuredBudgets?.[reasoningEffort] ?? DEFAULT_THINKING_BUDGETS[reasoningEffort],
  );
  const answerAwareLimit = Math.max(MIN_THINKING_BUDGET, maxTokens - RESERVED_ANSWER_TOKENS);
  const budgetTokens = Math.min(requestedBudget, maxTokens - 1, answerAwareLimit);
  body.thinking = { type: "enabled", budget_tokens: budgetTokens };
}

function shouldRequestInterleavedThinkingBeta(
  request: ProviderRequest,
  compatibility: ResolvedAnthropicModelCompatibility,
): boolean {
  return request.tools.length > 0 &&
    request.reasoningEffort !== undefined &&
    request.reasoningEffort !== "off" &&
    request.reasoningEffort !== "none" &&
    compatibility.interleaved === "beta";
}

function addAnthropicMessageCacheBreakpoints(
  messages: unknown[],
  limit: number,
  cacheControl: Record<string, string>,
): unknown[] {
  if (limit <= 0 || messages.length < 2) return messages;

  const eligible: Array<{ message: number; block: number; position: number }> = [];
  let position = 0;
  // The final message is the changing request suffix. Cache only the reusable history before it.
  for (let messageIndex = 0; messageIndex < messages.length - 1; messageIndex += 1) {
    const content = asArray(asRecord(messages[messageIndex])?.content);
    const preserveServerToolState = content.some((block) => {
      const type = asString(asRecord(block)?.type);
      return type === "server_tool_use" || type === "tool_search_tool_result";
    });
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      if (!preserveServerToolState && isAnthropicCacheableBlock(content[blockIndex])) {
        eligible.push({ message: messageIndex, block: blockIndex, position });
      }
      position += 1;
    }
  }
  if (eligible.length === 0) return messages;

  const selected = new Set<string>();
  let candidate = eligible.at(-1);
  for (let count = 0; count < limit && candidate !== undefined; count += 1) {
    selected.add(`${candidate.message}:${candidate.block}`);
    // A second marker starts where Anthropic's 20-block backward search can no longer reach.
    const nextPosition = candidate.position - CACHE_LOOKBACK_BLOCKS;
    candidate = eligible.findLast((entry) => entry.position <= nextPosition);
  }

  return messages.map((value, messageIndex) => {
    const message = asRecord(value);
    if (message === undefined) return value;
    const content = asArray(message.content);
    if (!content.some((_, blockIndex) => selected.has(`${messageIndex}:${blockIndex}`))) return value;
    return {
      ...message,
      content: content.map((block, blockIndex) => {
        if (!selected.has(`${messageIndex}:${blockIndex}`)) return block;
        return { ...asRecord(block), cache_control: cacheControl };
      }),
    };
  });
}

function isAnthropicCacheableBlock(value: unknown): boolean {
  const block = asRecord(value);
  const type = asString(block?.type);
  if (type === "text") return (asString(block?.text) ?? "") !== "";
  return type === "image" || type === "document" || type === "tool_use" || type === "tool_result";
}

function buildAnthropicMessages(request: ProviderRequest, allowEmptySignature: boolean, oauth: boolean): unknown[] {
  const state = request.providerState?.kind === "anthropic_messages" ? request.providerState : undefined;
  const lastAssistant = findLastAssistant(request);
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const sourceIndex = request.messages.indexOf(message);
      if (state !== undefined && sourceIndex === lastAssistant) {
        return {
          role: "assistant",
          content: normalizeAnthropicAssistantBlocks(state.assistantBlocks, allowEmptySignature, oauth),
        };
      }
      const role = message.role === "assistant" ? "assistant" : "user";
      const content = message.content.flatMap((block): unknown[] => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "image") return [anthropicImageContent(block)];
        if (block.type === "tool_call") {
          return [{
            type: "tool_use",
            id: block.callId,
            name: outboundToolName(block.name, oauth),
            input: asRecord(block.arguments) ?? {},
          }];
        }
        if (block.type === "tool_result") {
          const content = (block.images?.length ?? 0) === 0
            ? toolResultText(block)
            : [
                { type: "text", text: toolResultText(block) },
                ...(block.images ?? []).map(anthropicImageContent),
              ];
          return [{ type: "tool_result", tool_use_id: block.callId, content, is_error: block.isError }];
        }
        if (block.type === "provider_opaque" && block.provider === request.provider) {
          return normalizeAnthropicAssistantBlocks([block.value], allowEmptySignature, oauth);
        }
        return [];
      });
      return { role, content };
    });
}

function normalizeAnthropicAssistantBlocks(
  values: readonly unknown[],
  allowEmptySignature: boolean,
  oauth: boolean,
): unknown[] {
  return values.flatMap((value): unknown[] => {
    const block = asRecord(value);
    if (block === undefined) return [value];
    const type = asString(block.type);
    if (type === "tool_use") {
      const name = asString(block.name);
      const normalized = { ...block, input: asRecord(block.input) ?? {} };
      return name === undefined ? [normalized] : [{ ...normalized, name: outboundToolName(name, oauth) }];
    }
    if (type !== "thinking") return [value];

    const thinking = asString(block.thinking) ?? "";
    const signature = asString(block.signature);
    if (signature !== undefined && signature.trim() !== "") return [value];
    if (allowEmptySignature) return [{ ...block, thinking, signature: "" }];
    return thinking === "" ? [] : [{ type: "text", text: thinking }];
  });
}

function anthropicImageContent(block: ImageBlock): unknown {
  const source = normalizeImageSource(block, "Anthropic");
  requireImageMediaType(source, "Anthropic", ["image/jpeg", "image/png", "image/gif", "image/webp"]);
  requireImageUrlProtocol(source, "Anthropic", ["http:", "https:"]);
  return source.kind === "url"
    ? { type: "image", source: { type: "url", url: source.url } }
    : { type: "image", source: { type: "base64", media_type: source.mediaType, data: source.data } };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function appendString(record: Record<string, unknown> | undefined, key: string, value: string): void {
  if (record === undefined) return;
  record[key] = (asString(record[key]) ?? "") + value;
}

function finishTool(tool: ToolAccumulator): AdapterEvent {
  tool.ended = true;
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: tool.index,
    name: tool.name ?? "unknown_tool",
    rawArguments: tool.arguments,
  };
  if (tool.id !== undefined) event.id = tool.id;
  try {
    event.arguments = jsonValueOrString(JSON.parse(tool.arguments === "" ? "{}" : tool.arguments));
  } catch (error) {
    event.parseError = error instanceof Error ? error.message : String(error);
  }
  return event;
}

function parseAnthropicToolInput(value: string): JsonValue {
  try {
    return jsonValueOrString(JSON.parse(value === "" ? "{}" : value));
  } catch {
    throw new ProtocolError("Anthropic server tool returned malformed input", value);
  }
}

function anthropicUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const outputDetails = asRecord(usage.output_tokens_details);
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: anthropicCacheCreationTokens(usage),
    reasoningTokens: outputDetails?.thinking_tokens,
  });
}

function anthropicCacheCreationTokens(usage: Record<string, unknown>): unknown {
  if (usage.cache_creation_input_tokens !== undefined) return usage.cache_creation_input_tokens;
  const creation = asRecord(usage.cache_creation);
  if (creation === undefined) return undefined;
  const rawFiveMinutes = creation.ephemeral_5m_input_tokens;
  const rawOneHour = creation.ephemeral_1h_input_tokens;
  const fiveMinutes = reportedTokenCount(rawFiveMinutes);
  const oneHour = reportedTokenCount(rawOneHour);
  if (rawFiveMinutes !== undefined && fiveMinutes === undefined) return undefined;
  if (rawOneHour !== undefined && oneHour === undefined) return undefined;
  if (rawFiveMinutes === undefined && rawOneHour === undefined) return undefined;
  const total = (fiveMinutes ?? 0) + (oneHour ?? 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function reportedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedRefusalExplanation(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = sanitizeUnicode(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const encoded = Buffer.from(normalized, "utf8");
  if (encoded.byteLength <= 4 * 1024) return normalized;
  return encoded.subarray(0, 4 * 1024).toString("utf8").replace(/\uFFFD+$/u, "");
}

function mapAnthropicStop(reason: string | undefined, sawTools: boolean): FinishReason {
  if (reason === "tool_use" || (reason === undefined && sawTools)) return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "model_context_window_exceeded") return "context_limit";
  if (reason === "pause_turn") return "pause";
  if (reason === "refusal") return "refusal";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return "unknown";
}

function anthropicState(blocks: Map<number, Record<string, unknown>>): ProviderState {
  return {
    kind: "anthropic_messages",
    assistantBlocks: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => jsonValueOrString(block)),
  };
}

function outboundToolName(name: string, oauth: boolean): string {
  return oauth ? OAUTH_TOOL_NAMES.get(name.toLocaleLowerCase("en-US")) ?? name : name;
}

function originalToolName(name: string, tools: ProviderRequest["tools"], oauth: boolean): string {
  if (!oauth) return name;
  const normalized = name.toLocaleLowerCase("en-US");
  return tools.find((tool) => outboundToolName(tool.name, true).toLocaleLowerCase("en-US") === normalized)?.name ?? name;
}

function builtinAnthropicCompatibility(model: string): AnthropicModelCompatibility | undefined {
  for (const [family, compatibility] of BUILTIN_MODEL_COMPATIBILITY) {
    if (model === family || model.startsWith(`${family}-`)) return compatibility;
  }
  return undefined;
}

function anthropicDeferredToolsSupported(model: string): boolean {
  return TOOL_SEARCH_MODEL_FAMILIES.some((family) => model === family || model.startsWith(`${family}-`));
}

function anthropicDeferredToolsCapability(model: string, observedAt: string): ModelCapability {
  return modelEvidence(
    anthropicDeferredToolsSupported(model) ? "supported" : model.startsWith("claude-") ? "unsupported" : "unknown",
    "maintained",
    observedAt,
  );
}

function anthropicCompatibilityFromModel(
  model: Record<string, unknown> | undefined,
): AnthropicModelCompatibility | undefined {
  const thinking = asRecord(asRecord(model?.capabilities)?.thinking);
  const types = asRecord(thinking?.types);
  const adaptive = asRecord(types?.adaptive)?.supported === true;
  const enabled = asRecord(types?.enabled)?.supported === true;
  if (!adaptive && !enabled) return undefined;
  return adaptive
    ? { mode: "adaptive", interleaved: "automatic" }
    : { mode: "enabled" };
}

function anthropicReasoningEfforts(
  model: Record<string, unknown> | undefined,
  compatibility: ResolvedAnthropicModelCompatibility,
  observedAt: string,
): ReturnType<typeof providerReasoningEfforts> {
  const capabilities = asRecord(model?.capabilities);
  const effort = asRecord(capabilities?.effort);
  const reported = providerReasoningEfforts(effort?.levels ?? model?.supported_reasoning_efforts, observedAt);
  if (reported !== undefined) return reported;
  if (effort?.supported !== true) return undefined;

  const providerEfforts = ["low", "medium", "high", "xhigh", "max"]
    .filter((level) => asRecord(effort[level])?.supported === true);
  if (providerEfforts.length === 0) return undefined;
  const values = [
    ...(compatibility.off === "always-on" ? [] : ["off"]),
    ...(providerEfforts.includes("low") ? ["minimal"] : []),
    ...providerEfforts,
  ];
  return modelEvidence(values, "provider", observedAt);
}

function normalizeAnthropicThinkingConfig(value: AnthropicThinkingConfig | undefined): AnthropicThinkingConfig | undefined {
  if (value === undefined) return undefined;
  const input = asRecord(value);
  if (input === undefined) throw new TypeError("Anthropic thinking must be an object");
  assertObjectKeys(input, ["budgets", "models"], "Anthropic thinking");

  let budgets: AnthropicThinkingConfig["budgets"];
  if (input.budgets !== undefined) {
    const rawBudgets = asRecord(input.budgets);
    if (rawBudgets === undefined) throw new TypeError("Anthropic thinking budgets must be an object");
    assertObjectKeys(rawBudgets, Object.keys(DEFAULT_THINKING_BUDGETS), "Anthropic thinking budgets");
    budgets = {};
    for (const effort of Object.keys(rawBudgets) as AnthropicReasoningEffort[]) {
      const budget = rawBudgets[effort];
      if (!Number.isSafeInteger(budget) || (budget as number) < MIN_THINKING_BUDGET ||
        (budget as number) > MAX_CONFIGURED_THINKING_BUDGET) {
        throw new TypeError(
          `Anthropic thinking budget ${effort} must be an integer from ${MIN_THINKING_BUDGET} through ${MAX_CONFIGURED_THINKING_BUDGET}`,
        );
      }
      budgets[effort] = budget as number;
    }
  }

  let models: Record<string, AnthropicModelCompatibility> | undefined;
  if (input.models !== undefined) {
    const rawModels = asRecord(input.models);
    if (rawModels === undefined) throw new TypeError("Anthropic thinking models must be an object");
    if (Object.keys(rawModels).length > 256) throw new TypeError("Anthropic thinking models cannot contain more than 256 entries");
    models = {};
    for (const [model, rawCompatibility] of Object.entries(rawModels)) {
      if (model === "" || model.includes("\0") || Buffer.byteLength(model, "utf8") > 256) {
        throw new TypeError("Anthropic thinking model IDs must contain 1 through 256 bytes without NUL");
      }
      const compatibility = asRecord(rawCompatibility);
      if (compatibility === undefined) throw new TypeError(`Anthropic thinking model ${model} must be an object`);
      assertObjectKeys(compatibility, ["mode", "off", "interleaved", "allowEmptySignature"], `Anthropic thinking model ${model}`);
      const mode = optionalEnum(compatibility.mode, ["adaptive", "enabled"], `Anthropic thinking model ${model}.mode`);
      const off = optionalEnum(compatibility.off, ["omit", "disabled", "always-on"], `Anthropic thinking model ${model}.off`);
      const interleaved = optionalEnum(
        compatibility.interleaved,
        ["automatic", "beta", "off"],
        `Anthropic thinking model ${model}.interleaved`,
      );
      if (compatibility.allowEmptySignature !== undefined && typeof compatibility.allowEmptySignature !== "boolean") {
        throw new TypeError(`Anthropic thinking model ${model}.allowEmptySignature must be a boolean`);
      }
      models[model] = {
        ...(mode === undefined ? {} : { mode: mode as NonNullable<AnthropicModelCompatibility["mode"]> }),
        ...(off === undefined ? {} : { off: off as NonNullable<AnthropicModelCompatibility["off"]> }),
        ...(interleaved === undefined ? {} : {
          interleaved: interleaved as NonNullable<AnthropicModelCompatibility["interleaved"]>,
        }),
        ...(compatibility.allowEmptySignature === undefined
          ? {}
          : { allowEmptySignature: compatibility.allowEmptySignature }),
      };
    }
  }

  return {
    ...(budgets === undefined ? {} : { budgets }),
    ...(models === undefined ? {} : { models }),
  };
}

function assertObjectKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function optionalEnum(value: unknown, allowed: readonly string[], label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${label} must be ${allowed.join(", ")}`);
  }
  return value;
}

function capabilitiesFromModel(
  model: Record<string, unknown> | undefined,
  observedAt: string,
): ModelInfo["capabilities"] {
  const capabilities = asRecord(model?.capabilities);
  const thinking = asRecord(capabilities?.thinking);
  const effort = asRecord(capabilities?.effort);
  const imageInput = asRecord(capabilities?.image_input);
  return {
    tools: capability(capabilities?.tool_use, observedAt),
    reasoning: capability(thinking?.supported ?? effort?.supported ?? capabilities?.thinking, observedAt),
    images: capability(imageInput?.supported ?? capabilities?.vision, observedAt),
  };
}

function capability(value: unknown, observedAt: string): ModelCapability {
  return {
    value: typeof value === "boolean" ? (value ? "supported" : "unsupported") : "unknown",
    source: "provider",
    observedAt,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Malformed Anthropic SSE event", text);
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
