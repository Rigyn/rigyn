import type { JsonValue } from "../core/json.js";
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
} from "../core/types.js";
import { catalogId, catalogLimit } from "./catalog.js";
import { requireBody } from "./lines.js";
import { normalizeImageSource, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { decodeSSE } from "./sse.js";
import {
  baseModelCompatibility,
  providerModalities,
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
  jsonValueOrString,
  normalizeError,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
  responseDiagnostics,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";

export interface GeminiConfig {
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  userProject?: TokenSource;
  baseUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
}

export interface VertexConfig {
  project: string;
  location?: string;
  accessToken?: TokenSource;
  userProject?: TokenSource;
  baseUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
}

interface GenerateContentTransport {
  id: "gemini" | "vertex";
  headers: HeadersInit | undefined;
  fetch: FetchLike;
  authorize: (headers: Headers, signal: AbortSignal) => Promise<void>;
  streamUrl: (model: string) => string;
  modelsUrl: string;
}

interface GeminiTool {
  index: number;
  id?: string;
  name: string;
  arguments: JsonValue;
}

class GenerateContentAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #transport: GenerateContentTransport;

  constructor(transport: GenerateContentTransport) {
    this.id = transport.id;
    this.#transport = transport;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;

    try {
      const headers = new Headers(this.#transport.headers);
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      await this.#transport.authorize(headers, signal);
      const response = await this.#transport.fetch(this.#transport.streamUrl(request.model), {
        method: "POST",
        headers,
        body: stringifyProviderJson(buildGenerateContentBody(request, this.id)),
        signal,
        redirect: "error",
      });
      requestId = requestIdFromHeaders(response.headers);
      diagnostics = responseDiagnostics(response);
      await assertResponseOk(response);

      let started = false;
      let responseId: string | undefined;
      let responseModel = request.model;
      let finishReason: string | undefined;
      let promptBlockReason: string | undefined;
      const parts: JsonValue[] = [];
      const tools = new Map<string, GeminiTool>();

      for await (const sse of decodeSSE(requireBody(response))) {
        if (sse.data.trim() === "[DONE]") break;
        const parsed: unknown = parseJson(sse.data);
        const chunk = asRecord(parsed);
        if (chunk === undefined) throw new ProtocolError("Gemini stream chunk was not an object", jsonValueOrString(parsed));
        const error = asRecord(chunk.error);
        if (error !== undefined) {
          throw new ProviderStreamError(
            asString(error.message) ?? "Gemini stream failed",
            asString(error.status) ?? asString(error.code),
            jsonValueOrString(chunk),
          );
        }

        responseId = asString(chunk.responseId) ?? asString(chunk.response_id) ?? responseId;
        responseModel = asString(chunk.modelVersion) ?? asString(chunk.model_version) ?? responseModel;
        if (!started) {
          started = true;
          const start: AdapterEvent = { type: "response_start", model: responseModel, diagnostics };
          if (responseId !== undefined) start.responseId = responseId;
          if (requestId !== undefined) start.requestId = requestId;
          yield start;
        }

        promptBlockReason =
          asString(asRecord(chunk.promptFeedback)?.blockReason) ??
          asString(asRecord(chunk.prompt_feedback)?.block_reason) ??
          promptBlockReason;

        for (const candidateValue of asArray(chunk.candidates)) {
          const candidate = asRecord(candidateValue);
          if (candidate === undefined) continue;
          const candidateIndex = asNumber(candidate.index) ?? 0;
          if (candidateIndex !== 0) {
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(candidate) };
            continue;
          }
          finishReason = asString(candidate.finishReason) ?? asString(candidate.finish_reason) ?? finishReason;
          const content = asRecord(candidate.content);
          let partIndex = 0;
          for (const partValue of asArray(content?.parts)) {
            const part = asRecord(partValue);
            const jsonPart = jsonValueOrString(partValue);
            parts.push(jsonPart);
            if (part === undefined) {
              yield { type: "unknown_provider_event", provider: this.id, raw: jsonPart };
              partIndex += 1;
              continue;
            }

            const text = asString(part.text);
            if (text !== undefined && text !== "") {
              partial = true;
              if (part.thought === true) {
                yield { type: "reasoning_delta", part: partIndex, text, visibility: "provider_trace" };
              } else {
                yield { type: "text_delta", part: partIndex, text };
              }
            }

            const functionCall = asRecord(part.functionCall) ?? asRecord(part.function_call);
            if (functionCall !== undefined) {
              const name = asString(functionCall.name) ?? "unknown_tool";
              const id = asString(functionCall.id);
              const key = id ?? `${candidateIndex}:${partIndex}`;
              if (!tools.has(key)) {
                const args = jsonValueOrString(functionCall.args ?? functionCall.arguments ?? {});
                const tool: GeminiTool = { index: tools.size, name, arguments: args };
                if (id !== undefined) tool.id = id;
                tools.set(key, tool);
                partial = true;
                const toolStart: AdapterEvent = { type: "tool_call_start", index: tool.index, name };
                if (id !== undefined) toolStart.id = id;
                yield toolStart;
                const rawArguments = stringifyProviderJson(args);
                yield { type: "tool_call_delta", index: tool.index, jsonFragment: rawArguments };
                const toolEnd: AdapterEvent = {
                  type: "tool_call_end",
                  index: tool.index,
                  name,
                  rawArguments,
                  arguments: args,
                };
                if (id !== undefined) toolEnd.id = id;
                yield toolEnd;
              }
            }

            if (
              text === undefined &&
              functionCall === undefined &&
              part.thoughtSignature === undefined &&
              part.thought_signature === undefined
            ) {
              yield { type: "unknown_provider_event", provider: this.id, raw: jsonPart };
            }
            partIndex += 1;
          }
        }

        const usage = geminiUsage(chunk.usageMetadata ?? chunk.usage_metadata);
        if (usage !== undefined) {
          yield { type: "usage", usage, semantics: finishReason === undefined ? "cumulative" : "final" };
        }
      }

      if (!started) throw new ProtocolError("Gemini stream ended before any response chunk");
      const rawReason = finishReason ?? promptBlockReason;
      if (rawReason === undefined) throw new ProtocolError("Gemini stream ended before a finish reason");
      terminal = true;
      const end: AdapterEvent = {
        type: "response_end",
        reason: mapGeminiFinish(rawReason, tools.size > 0, promptBlockReason !== undefined),
        state: { kind: "gemini_generate_content", parts },
        rawReason,
      };
      yield end;
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const headers = new Headers(this.#transport.headers);
    headers.set("accept", "application/json");
    await this.#transport.authorize(headers, signal);
    const entries: unknown[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(this.#transport.modelsUrl);
      url.searchParams.set("pageSize", "1000");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await this.#transport.fetch(url, { headers, signal, redirect: "error" });
      await assertResponseOk(response);
      const body = asRecord(await readJsonResponse(response));
      entries.push(...asArray(body?.models));
      const next = asString(body?.nextPageToken);
      if (next === undefined || next === "") break;
      if (seen.has(next)) throw new ProtocolError("Gemini model catalog repeated a page token");
      seen.add(next);
      pageToken = next;
    }
    const observedAt = new Date().toISOString();
    return entries.flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      if (model === undefined) return [];
      const rawName = catalogId(model.name);
      if (rawName === undefined) return [];
      const id = googleModelId(rawName);
      if (id === undefined || !supportsGenerateContent(model)) return [];
      const capabilities = geminiCapabilities(model, observedAt);
      const compatibility = baseModelCompatibility("gemini-generate-content", capabilities.tools, observedAt);
      const inputModalities = providerModalities(
        model.inputModalities ?? model.input_modalities,
        observedAt,
      );
      const outputModalities = providerModalities(
        model.outputModalities ?? model.output_modalities,
        observedAt,
      );
      const reasoningEfforts = providerReasoningEfforts(
        model.supportedReasoningEfforts ?? model.supported_reasoning_efforts,
        observedAt,
      );
      if (inputModalities !== undefined) compatibility.inputModalities = inputModalities;
      if (outputModalities !== undefined) compatibility.outputModalities = outputModalities;
      if (reasoningEfforts !== undefined) compatibility.reasoningEfforts = reasoningEfforts;
      const info: ModelInfo = {
        id,
        provider: this.id,
        capabilities,
        compatibility,
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model?.displayName) ?? asString(model?.display_name);
      const contextTokens = catalogLimit(model?.inputTokenLimit) ?? catalogLimit(model?.input_token_limit);
      const maxOutputTokens = catalogLimit(model?.outputTokenLimit) ?? catalogLimit(model?.output_token_limit);
      if (displayName !== undefined) info.displayName = displayName;
      if (contextTokens !== undefined) info.contextTokens = contextTokens;
      if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
      return [info];
    });
  }
}

export class GeminiAdapter extends GenerateContentAdapter {
  constructor(config: GeminiConfig) {
    const baseUrl = trimSlash(config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta");
    assertSecureEndpoint(baseUrl, "Gemini base URL");
    super({
      id: "gemini",
      headers: config.headers,
      fetch: config.fetch ?? globalThis.fetch,
      authorize: async (headers, signal) => {
        const accessToken = await resolveToken(config.accessToken, signal);
        if (accessToken !== undefined) {
          headers.set("authorization", `Bearer ${accessToken}`);
          const userProject = await resolveToken(config.userProject, signal);
          if (userProject !== undefined) headers.set("x-goog-user-project", userProject);
          return;
        }
        const apiKey = await resolveToken(config.apiKey, signal);
        if (apiKey !== undefined) headers.set("x-goog-api-key", apiKey);
      },
      streamUrl: (model) => `${baseUrl}/models/${encodeURIComponent(stripModelPrefix(model))}:streamGenerateContent?alt=sse`,
      modelsUrl: `${baseUrl}/models`,
    });
  }
}

export class VertexAdapter extends GenerateContentAdapter {
  constructor(config: VertexConfig) {
    const location = config.location ?? "global";
    const root = trimSlash(
      config.baseUrl ??
        `https://${location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`}/v1`,
    );
    assertSecureEndpoint(root, "Vertex base URL");
    const publisherRoot = `${root}/projects/${encodeURIComponent(config.project)}/locations/${encodeURIComponent(location)}/publishers/google`;
    super({
      id: "vertex",
      headers: config.headers,
      fetch: config.fetch ?? globalThis.fetch,
      authorize: async (headers, signal) => {
        const token = await resolveToken(config.accessToken, signal);
        if (token !== undefined) {
          headers.set("authorization", `Bearer ${token}`);
          const userProject = await resolveToken(config.userProject, signal);
          if (userProject !== undefined) headers.set("x-goog-user-project", userProject);
        }
      },
      streamUrl: (model) => `${publisherRoot}/models/${encodeURIComponent(stripModelPrefix(model))}:streamGenerateContent?alt=sse`,
      modelsUrl: `${publisherRoot}/models`,
    });
  }
}

function buildGenerateContentBody(request: ProviderRequest, provider: ProviderId): Record<string, unknown> {
  request = providerWireRequest(request, request.providerState?.kind === "gemini_generate_content");
  const body: Record<string, unknown> = { contents: buildGeminiContents(request, provider) };
  const systemText = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (systemText !== "") body.systemInstruction = { parts: [{ text: systemText }] };
  if (request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ];
  }
  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.reasoningEffort !== undefined) {
    generationConfig.thinkingConfig =
      request.reasoningEffort === "none"
        ? { thinkingBudget: 0 }
        : { thinkingLevel: request.reasoningEffort.toUpperCase() };
  }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

function buildGeminiContents(request: ProviderRequest, provider: ProviderId): unknown[] {
  const state = request.providerState?.kind === "gemini_generate_content" ? request.providerState : undefined;
  const lastAssistant = findLastAssistant(request);
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const sourceIndex = request.messages.indexOf(message);
      if (state !== undefined && sourceIndex === lastAssistant) return { role: "model", parts: state.parts };
      const parts = message.content.flatMap((block): unknown[] => {
        if (block.type === "text") return [{ text: block.text }];
        if (block.type === "image") return [geminiImagePart(block, provider)];
        if (block.type === "tool_call") {
          return [{ functionCall: { id: block.callId, name: block.name, args: block.arguments } }];
        }
        if (block.type === "tool_result") {
          return [
            {
              functionResponse: {
                id: block.callId,
                name: block.name,
                response: { content: toolResultText(block), isError: block.isError },
              },
            },
            ...(block.images ?? []).map((image) => geminiImagePart(image, provider)),
          ];
        }
        if (block.type === "provider_opaque" && (block.provider === "gemini" || block.provider === "vertex")) {
          return [block.value];
        }
        return [];
      });
      return { role: message.role === "assistant" ? "model" : "user", parts };
    });
}

function geminiImagePart(block: ImageBlock, provider: ProviderId): unknown {
  const source = normalizeImageSource(block, "Gemini GenerateContent");
  requireImageUrlProtocol(
    source,
    "Gemini GenerateContent",
    provider === "vertex" ? ["https:", "gs:"] : ["https:"],
  );
  return source.kind === "base64"
    ? { inlineData: { mimeType: source.mediaType, data: source.data } }
    : { fileData: { mimeType: source.mediaType, fileUri: source.url } };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function geminiUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.promptTokenCount ?? usage.prompt_token_count,
    outputTokens: usage.candidatesTokenCount ?? usage.candidates_token_count,
    reportedTotalTokens: usage.totalTokenCount ?? usage.total_token_count,
    cacheReadTokens: usage.cachedContentTokenCount ?? usage.cached_content_token_count,
    reasoningTokens: usage.thoughtsTokenCount ?? usage.thoughts_token_count,
    additionalInputTokens: usage.toolUsePromptTokenCount ?? usage.tool_use_prompt_token_count,
    inputIncludesCache: true,
    reconcileOutputFromTotal: true,
  });
}

function mapGeminiFinish(reason: string, sawTools: boolean, promptBlocked: boolean): FinishReason {
  if (sawTools) return "tool_calls";
  if (promptBlocked) return "content_filter";
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason.includes("CONTEXT")) return "context_limit";
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"].includes(reason)) {
    return "content_filter";
  }
  if (["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"].includes(reason)) return "error";
  return "unknown";
}

function geminiCapabilities(
  _model: Record<string, unknown> | undefined,
  observedAt: string,
): ModelInfo["capabilities"] {
  return {
    tools: capability(false, false, observedAt),
    reasoning: capability(false, false, observedAt),
    images: capability(false, false, observedAt),
  };
}

function googleModelId(name: string): string | undefined {
  const marker = name.lastIndexOf("/models/");
  return catalogId(marker >= 0 ? name.slice(marker + "/models/".length) : name.replace(/^models\//u, ""));
}

function supportsGenerateContent(model: Record<string, unknown>): boolean {
  const methods = asArray(model.supportedGenerationMethods ?? model.supported_generation_methods)
    .filter((value): value is string => typeof value === "string");
  return methods.length === 0 || methods.includes("generateContent") || methods.includes("streamGenerateContent");
}

function capability(supported: boolean, known: boolean, observedAt: string): ModelCapability {
  return { value: known ? (supported ? "supported" : "unsupported") : "unknown", source: "provider", observedAt };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Malformed Gemini SSE event", text);
  }
}

function stripModelPrefix(model: string): string {
  return model.replace(/^models\//, "");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
