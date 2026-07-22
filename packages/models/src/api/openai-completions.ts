import type { Context, Model, OpenAICompletionsCompat, SimpleStreamOptions, StreamFunction, StreamOptions, ToolCall } from "../types.js";
import { shortHash } from "../utils/hash.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";
import { providerFetch, readSse } from "./internal/http.js";
import { MessageStreamBuilder, streamTask } from "./internal/message-stream.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";
import { buildCopilotDynamicHeaders } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
interface WireRecord { [key: string]: unknown; }
const object = (value: unknown): WireRecord | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as WireRecord : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function normalizedId(id: string, model: Model<"openai-completions">): string {
  if (!id.includes("|") && model.provider !== "openai") return id;
  const clean = id.replaceAll("|", "_").replace(/[^a-z0-9_-]/giu, "_");
  return clean.length <= 40 ? clean : `${clean.slice(0, 31)}_${shortHash(id).slice(0, 8)}`;
}

type ResolvedCompatibility = OpenAICompletionsCompat & Required<Pick<OpenAICompletionsCompat,
  "supportsStore" | "supportsDeveloperRole" | "supportsReasoningEffort" | "supportsUsageInStreaming" |
  "maxTokensField" | "requiresToolResultName" | "requiresAssistantAfterToolResult" |
  "requiresThinkingAsText" | "requiresReasoningContentOnAssistantMessages" | "supportsStrictMode" |
  "supportsLongCacheRetention" | "sendSessionAffinityHeaders" | "sessionAffinityFormat" | "reasoningFormat"
>>;

function compatibility(model: Model<"openai-completions">): ResolvedCompatibility {
  const provider = model.provider;
  const baseUrl = model.baseUrl.toLowerCase();
  const zai = provider === "zai" || provider === "zai-coding-cn" || baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn");
  const together = provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
  const moonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
  const openRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
  const workers = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
  const gateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
  const nvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
  const antLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
  const xai = provider === "xai" || baseUrl.includes("api.x.ai");
  const deepseek = provider === "deepseek" || baseUrl.includes("deepseek.com");
  const nonstandard = nvidia || provider === "cerebras" || baseUrl.includes("cerebras.ai") || xai || together ||
    baseUrl.includes("chutes.ai") || deepseek || zai || moonshot || provider === "opencode" || baseUrl.includes("opencode.ai") ||
    workers || gateway || antLing;
  const maxTokens = baseUrl.includes("chutes.ai") || moonshot || gateway || together || nvidia || antLing;
  const routedDeveloperRole = openRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
  const detectedFormat: NonNullable<OpenAICompletionsCompat["reasoningFormat"]> = deepseek ? "deepseek" : zai ? "zai" : together ? "together" : antLing ? "ant-ling" : openRouter ? "openrouter" : "openai";
  const detected: ResolvedCompatibility = {
    supportsStore: !nonstandard,
    supportsDeveloperRole: routedDeveloperRole || (!nonstandard && !openRouter),
    supportsReasoningEffort: !xai && !zai && !moonshot && !together && !gateway && !nvidia && !antLing,
    supportsUsageInStreaming: true,
    maxTokensField: maxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: deepseek,
    reasoningFormat: detectedFormat,
    supportsStrictMode: !moonshot && !together && !gateway && !nvidia,
    ...(openRouter && model.id.startsWith("anthropic/") ? { cacheControlFormat: "anthropic" as const } : {}),
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: openRouter ? "openrouter" : "openai",
    supportsLongCacheRetention: !together && !workers && !gateway && !nvidia && !antLing,
  };
  const explicit = model.compat;
  if (!explicit) return detected;
  return {
    ...detected,
    ...explicit,
    reasoningFormat: explicit.reasoningFormat ?? explicit.thinkingFormat ?? detected.reasoningFormat,
  };
}

function wireTool(tool: NonNullable<Context["tools"]>[number], compat: ResolvedCompatibility): WireRecord {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(compat.supportsStrictMode === false ? {} : { strict: false }),
    },
  };
}

function deferredToolNames(context: Context, compat: ResolvedCompatibility): Set<string> {
  if (compat.deferredToolsMode !== "kimi") return new Set();
  const available = new Set((context.tools ?? []).map((tool) => tool.name));
  const deferred = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "toolResult") continue;
    for (const name of message.addedToolNames ?? []) if (available.has(name)) deferred.add(name);
  }
  return deferred;
}

function encryptedReasoningDetail(value: unknown): WireRecord | undefined {
  const detail = object(value);
  return detail?.type === "reasoning.encrypted" && typeof detail.id === "string" && detail.id.length > 0 && typeof detail.data === "string" && detail.data.length > 0 ? detail : undefined;
}

function replayedReasoningDetail(signature: string | undefined): WireRecord | undefined {
  if (!signature) return undefined;
  try { return encryptedReasoningDetail(JSON.parse(signature)); } catch { return undefined; }
}

export function convertMessages(model: Model<"openai-completions">, context: Context, compat: OpenAICompletionsCompat = compatibility(model)): WireRecord[] {
  const resolved = compatibility({ ...model, compat: { ...model.compat, ...compat } });
  const messages: WireRecord[] = [];
  let pendingToolImages: WireRecord[] = [];
  const deferred = deferredToolNames(context, resolved);
  const tools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  const introduced = new Set<string>();
  let pendingIntroductions: NonNullable<Context["tools"]> = [];
  const flushToolImages = () => {
    if (pendingToolImages.length) messages.push({ role: "user", content: pendingToolImages });
    pendingToolImages = [];
  };
  const flushIntroductions = () => {
    if (pendingIntroductions.length) messages.push({ role: "system", tools: pendingIntroductions.map((tool) => wireTool(tool, resolved)) });
    pendingIntroductions = [];
  };
  if (context.systemPrompt) messages.push({ role: model.reasoning && resolved.supportsDeveloperRole ? "developer" : "system", content: sanitizeSurrogates(context.systemPrompt) });
  let previous = "";
  for (const message of transformMessages(context.messages, model, (value) => normalizedId(value, model))) {
    if (message.role !== "toolResult") { flushToolImages(); flushIntroductions(); }
    if (resolved.requiresAssistantAfterToolResult && previous === "toolResult" && message.role === "user") messages.push({ role: "assistant", content: "I have processed the tool results." });
    if (message.role === "user") {
      if (typeof message.content === "string") messages.push({ role: "user", content: sanitizeSurrogates(message.content) });
      else if (message.content.length) messages.push({ role: "user", content: message.content.map((block) => block.type === "text" ? { type: "text", text: sanitizeSurrogates(block.text) } : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }) });
    } else if (message.role === "assistant") {
      const text = message.content.filter((block) => block.type === "text").map((block) => sanitizeSurrogates(block.text)).join("");
      const thinking = message.content.filter((block) => block.type === "thinking");
      const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
      const output: WireRecord = { role: "assistant", content: resolved.requiresThinkingAsText && thinking.length ? [...thinking.map((block) => ({ type: "text", text: sanitizeSurrogates(block.thinking) })), ...(text ? [{ type: "text", text }] : [])] : text || null };
      if (!resolved.requiresThinkingAsText && thinking.length) {
        const signature = thinking.find((block) => block.thinkingSignature)?.thinkingSignature ?? "reasoning_content";
        output[signature] = thinking.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n");
      } else if (resolved.requiresReasoningContentOnAssistantMessages && model.reasoning) output.reasoning_content = "";
      if (calls.length) {
        output.tool_calls = calls.map((call) => ({ id: normalizedId(call.id, model), type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
        const details = calls.map((call) => replayedReasoningDetail(call.thoughtSignature)).filter((detail): detail is WireRecord => detail !== undefined);
        if (details.length) output.reasoning_details = details;
      }
      if (output.content !== null || calls.length) messages.push(output);
    } else {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      messages.push({ role: "tool", tool_call_id: normalizedId(message.toolCallId, model), content: sanitizeSurrogates(text), ...(resolved.requiresToolResultName ? { name: message.toolName } : {}) });
      const images = message.content.filter((block) => block.type === "image");
      if (images.length) pendingToolImages.push({ type: "text", text: `Images returned by ${message.toolName}:` }, ...images.map((block) => ({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } })));
      for (const name of message.addedToolNames ?? []) {
        const tool = tools.get(name);
        if (!tool || !deferred.has(name) || introduced.has(name)) continue;
        introduced.add(name); pendingIntroductions.push(tool);
      }
    }
    previous = message.role;
  }
  flushToolImages(); flushIntroductions();
  return messages;
}

function endpoint(baseUrl: string): string { const base = baseUrl.replace(/\/+$/u, ""); return /\/chat\/completions$/u.test(base) ? base : `${base}/chat/completions`; }
function headers(model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions): HeadersInit {
  const output = new Headers(model.headers);
  if (model.provider === "github-copilot") {
    for (const [name, value] of Object.entries(buildCopilotDynamicHeaders({ messages: context.messages }))) output.set(name, value);
  }
  if (options?.apiKey && !output.has("authorization")) output.set("authorization", `Bearer ${options.apiKey}`);
  const compat = compatibility(model);
  if (options?.sessionId && options.cacheRetention !== "none" && compat.sendSessionAffinityHeaders) {
    const format = compat.sessionAffinityFormat ?? (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai");
    if (format === "openrouter") output.set("x-session-id", options.sessionId);
    else {
      if (format === "openai") output.set("session_id", options.sessionId);
      output.set("x-client-request-id", options.sessionId);
      output.set("x-session-affinity", options.sessionId);
    }
  }
  return output;
}

type CacheMarker = { type: "ephemeral"; ttl?: "1h" };

function cacheMarker(compat: ResolvedCompatibility, retention: "none" | "short" | "long"): CacheMarker | undefined {
  if (compat.cacheControlFormat !== "anthropic" || retention === "none") return undefined;
  return retention === "long" && compat.supportsLongCacheRetention ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function markTextContent(message: WireRecord, marker: CacheMarker, first: boolean): boolean {
  const content = message.content;
  if (typeof content === "string") {
    message.content = [{ type: "text", text: content, cache_control: marker }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  const indexes = content.map((part, index) => ({ part: object(part), index })).filter(({ part }) => part?.type === "text");
  const target = first ? indexes[0] : indexes.at(-1);
  if (!target?.part) return false;
  content[target.index] = { ...target.part, cache_control: marker };
  return true;
}

function applyCacheMarkers(messages: WireRecord[], tools: WireRecord[] | undefined, marker: CacheMarker | undefined): void {
  if (!marker) return;
  const instruction = messages.find((message) => message.role === "system" || message.role === "developer");
  if (instruction) markTextContent(instruction, marker, true);
  if (tools?.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: marker };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if ((message.role === "user" || message.role === "assistant") && markTextContent(message, marker, false)) break;
  }
}

function applyReasoning(result: WireRecord, model: Model<"openai-completions">, compat: ResolvedCompatibility, options?: OpenAICompletionsOptions): void {
  if (!model.reasoning) return;
  const requested = options?.reasoningEffort;
  const enabled = requested !== undefined;
  const mapped = requested === undefined ? undefined : model.thinkingLevelMap?.[requested] ?? requested;
  const off = model.thinkingLevelMap?.off;
  const format = compat.reasoningFormat ?? compat.thinkingFormat ?? "openai";
  if (format === "zai") {
    result.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
    if (enabled && compat.supportsReasoningEffort && typeof mapped === "string") result.reasoning_effort = mapped;
    return;
  }
  if (format === "qwen") { result.enable_thinking = enabled; return; }
  if (format === "qwen-chat-template") {
    result.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
    return;
  }
  if (format === "chat-template") {
    const values: WireRecord = {};
    for (const [name, configured] of Object.entries(compat.chatTemplateKwargs ?? {})) {
      if (configured === null || typeof configured !== "object") { values[name] = configured; continue; }
      if (!enabled && configured.omitWhenOff) continue;
      if (configured.$var === "thinking.enabled") values[name] = enabled;
      else {
        const value = enabled ? mapped : typeof off === "string" ? off : undefined;
        if (value !== undefined) values[name] = value;
      }
    }
    if (Object.keys(values).length) result.chat_template_kwargs = values;
    return;
  }
  if (format === "deepseek") {
    if (enabled) result.thinking = { type: "enabled" };
    else if (off !== null) result.thinking = { type: "disabled" };
    if (enabled && compat.supportsReasoningEffort && typeof mapped === "string") result.reasoning_effort = mapped;
    return;
  }
  if (format === "openrouter") {
    const effort = enabled ? mapped : off === null ? undefined : typeof off === "string" ? off : "none";
    if (typeof effort === "string") result.reasoning = { effort };
    return;
  }
  if (format === "together") {
    result.reasoning = { enabled };
    if (enabled && compat.supportsReasoningEffort && typeof mapped === "string") result.reasoning_effort = mapped;
    return;
  }
  if (format === "string-thinking") {
    const thinking = enabled ? mapped : off === null ? undefined : typeof off === "string" ? off : "none";
    if (typeof thinking === "string") result.thinking = thinking;
    return;
  }
  if (format === "ant-ling") {
    if (enabled && typeof model.thinkingLevelMap?.[requested] === "string") result.reasoning = { effort: model.thinkingLevelMap[requested] };
    return;
  }
  if (enabled && compat.supportsReasoningEffort && typeof mapped === "string") result.reasoning_effort = mapped;
  else if (!enabled && typeof off === "string") result.reasoning_effort = off;
}

function body(model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions): WireRecord {
  const compat = compatibility(model);
  const result: WireRecord = { model: model.id, messages: convertMessages(model, context, compat), stream: true };
  if (compat.supportsUsageInStreaming) result.stream_options = { include_usage: true };
  if (compat.supportsStore) result.store = false;
  const maximum = Math.max(1, Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens)); result[compat.maxTokensField] = maximum;
  if (options?.temperature !== undefined) result.temperature = options.temperature;
  const deferred = deferredToolNames(context, compat);
  if (context.tools?.length) result.tools = context.tools.filter((tool) => !deferred.has(tool.name)).map((tool) => wireTool(tool, compat));
  else if (context.messages.some((message) => message.role === "toolResult")) result.tools = [];
  if (compat.zaiToolStream && Array.isArray(result.tools) && result.tools.length > 0) result.tool_stream = true;
  if (options?.toolChoice !== undefined) result.tool_choice = options.toolChoice;
  applyReasoning(result, model, compat, options);
  if (compat.openRouterRouting && Object.keys(compat.openRouterRouting).length) result.provider = compat.openRouterRouting;
  if (compat.vercelGatewayRouting && Object.keys(compat.vercelGatewayRouting).length) result.providerOptions = { gateway: compat.vercelGatewayRouting };
  const cacheRetention = options?.cacheRetention ?? (options?.env?.RIGYN_CACHE_RETENTION === "long" ? "long" : "short");
  if (options?.sessionId && ((/api\.openai\.com/iu.test(model.baseUrl) && cacheRetention !== "none") || (cacheRetention === "long" && compat.supportsLongCacheRetention))) result.prompt_cache_key = clampOpenAIPromptCacheKey(options.sessionId);
  if (cacheRetention === "long" && compat.supportsLongCacheRetention) result.prompt_cache_retention = "24h";
  applyCacheMarkers(result.messages as WireRecord[], result.tools as WireRecord[] | undefined, cacheMarker(compat, cacheRetention));
  return result;
}

function usage(builder: MessageStreamBuilder<"openai-completions">, value: unknown): void {
  const record = object(value); if (!record) return;
  const prompt = number(record.prompt_tokens) ?? 0; const completion = number(record.completion_tokens) ?? 0;
  const promptDetails = object(record.prompt_tokens_details); const completionDetails = object(record.completion_tokens_details);
  const cacheRead = number(promptDetails?.cached_tokens) ?? number(record.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = number(promptDetails?.cache_write_tokens) ?? number(record.cache_write_tokens) ?? 0;
  const reasoning = number(completionDetails?.reasoning_tokens) ?? 0;
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  builder.usage({ input, output: completion, cacheRead, cacheWrite, reasoning, totalTokens: input + completion + cacheRead + cacheWrite });
}

async function execute(builder: MessageStreamBuilder<"openai-completions">, model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions): Promise<void> {
  const requestOptions: OpenAICompletionsOptions = { ...options, maxRetries: options?.maxRetries ?? 0 };
  const response = await providerFetch({ model, url: endpoint(model.baseUrl), body: body(model, context, options), options: requestOptions, headers: headers(model, context, options) });
  builder.start();
  let textIndex: number | undefined; let thinkingIndex: number | undefined; let thinkingSignature: string | undefined;
  const tools = new Map<number, { state: { index: number; json: string }; id: string }>();
  const reasoningDetails = new Map<string, string>();
  let terminal: "stop" | "length" | "toolUse" | undefined; let terminalError: string | undefined;
  for await (const event of readSse(response)) {
    if (event.data === "[DONE]") break;
    let packet: WireRecord; try { packet = JSON.parse(event.data) as WireRecord; } catch { continue; }
    const responseId = string(packet.id); const responseModel = string(packet.model);
    builder.response({ ...(responseId === undefined ? {} : { responseId }), ...(responseModel === undefined || responseModel === model.id ? {} : { responseModel }) });
    const choice = object(array(packet.choices)[0]); if (!choice) continue; const delta = object(choice.delta) ?? {};
    usage(builder, packet.usage ?? choice.usage);
    const text = string(delta.content); if (text !== undefined) { textIndex ??= builder.textStart(); builder.textDelta(textIndex, text); }
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
      const thought = string(delta[field]);
      if (!thought) continue;
      thinkingIndex ??= builder.thinkingStart(); builder.thinkingDelta(thinkingIndex, thought);
      thinkingSignature = model.provider === "opencode-go" && field === "reasoning" ? "reasoning_content" : field;
      break;
    }
    for (const rawDetail of array(delta.reasoning_details)) {
      const detail = encryptedReasoningDetail(rawDetail);
      if (detail) reasoningDetails.set(detail.id as string, JSON.stringify(detail));
    }
    for (const rawTool of array(delta.tool_calls)) {
      const tool = object(rawTool) ?? {}; const index = number(tool.index) ?? tools.size; const fn = object(tool.function) ?? {};
      let entry = tools.get(index);
      if (!entry) {
        const id = string(tool.id) ?? `call_${shortHash(`${Date.now()}:${index}`)}`;
        entry = { state: builder.toolStart(normalizedId(id, model), string(fn.name) ?? "tool"), id };
        tools.set(index, entry);
      }
      const fragment = string(fn.arguments); if (fragment !== undefined) builder.toolDelta(entry.state, fragment);
    }
    const finish = string(choice.finish_reason);
    if (finish === undefined) continue;
    if (finish === "stop" || finish === "end") terminal = "stop";
    else if (finish === "length") terminal = "length";
    else if (finish === "tool_calls" || finish === "function_call") terminal = "toolUse";
    else terminalError = `Provider finish_reason: ${finish}`;
  }
  if (textIndex !== undefined) builder.textEnd(textIndex);
  if (thinkingIndex !== undefined) builder.thinkingEnd(thinkingIndex, thinkingSignature);
  for (const tool of tools.values()) builder.toolEnd(tool.state, reasoningDetails.get(tool.id));
  if (terminalError) throw new Error(terminalError);
  if (terminal === undefined) throw new Error("Stream ended without finish_reason");
  builder.done(terminal);
}

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (model, context, options) => streamTask(model, (builder) => execute(builder, model, context, options), options?.signal);
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (model, context, options) => {
  const reasoning = resolveSimpleReasoning(model, options?.reasoning);
  return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }) });
};
