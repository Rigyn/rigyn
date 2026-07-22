import type {
  ChatCompletionStreamRequest,
  CompletionChunk,
  ContentChunk,
} from "@mistralai/mistralai/models/components";

import type { JsonValue } from "../core/json.js";
import type { OpenAIChatSdkStreamInput } from "./openai-chat-sdk-transport.js";
import {
  asArray,
  asRecord,
  asString,
  assertResponseOk,
  HttpResponseError,
  InvalidProviderRequestError,
  requestIdFromHeaders,
  responseDiagnostics,
} from "./transport.js";

type MistralSdk = typeof import("@mistralai/mistralai");

export interface MistralSdkStreamInput extends Omit<OpenAIChatSdkStreamInput, "loadSdk"> {
  loadSdk?: () => Promise<MistralSdk>;
}

/** Per-request Mistral SDK stream normalized for the canonical chat event reducer. */
export async function* streamMistralChatWithSdk(
  input: MistralSdkStreamInput,
): AsyncIterable<unknown> {
  if (input.apiKey === undefined) {
    throw new InvalidProviderRequestError("No API key for provider: mistral");
  }
  const sdk = await (input.loadSdk?.() ?? import("@mistralai/mistralai"));
  const httpClient = new sdk.HTTPClient({
    fetcher: async (resource, init) => {
      const response = await input.fetch(resource, { ...init, redirect: "error" });
      input.onResponse(responseDiagnostics(response), requestIdFromHeaders(response.headers));
      await assertResponseOk(response);
      return response;
    },
  });
  const client = new sdk.Mistral({
    apiKey: input.apiKey,
    httpClient,
    serverURL: mistralServerUrl(input.baseUrl),
  });
  const headers = Object.fromEntries(input.headers);
  delete headers.authorization;

  try {
    const events = await client.chat.stream(toMistralRequest(input.body), {
      headers,
      retries: { strategy: "none" },
      signal: input.signal,
    });
    for await (const event of events) {
      yield fromMistralChunk(event.data);
    }
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    const transportError = nestedTransportError(error);
    if (transportError !== undefined) throw transportError;
    const name = error instanceof Error ? error.name : "";
    if (name === "ConnectionError" || name === "RequestTimeoutError") {
      throw new TypeError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    throw error;
  }
}

function mistralServerUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/u, "").replace(/\/+$/u, "");
}

function toMistralRequest(body: Record<string, unknown>): ChatCompletionStreamRequest {
  const messages = asArray(body.messages).map((value) => toMistralMessage(value));
  const request: Record<string, unknown> = {
    model: asString(body.model) ?? "",
    messages,
    stream: true,
  };
  copy(body, request, "temperature", "temperature");
  copy(body, request, "max_tokens", "maxTokens");
  copy(body, request, "metadata", "metadata");
  copy(body, request, "n", "n");
  copy(body, request, "tools", "tools");
  copy(body, request, "tool_choice", "toolChoice");
  copy(body, request, "parallel_tool_calls", "parallelToolCalls");
  copy(body, request, "reasoning_effort", "reasoningEffort");
  copy(body, request, "prompt_mode", "promptMode");
  copy(body, request, "prompt_cache_key", "promptCacheKey");
  return request as unknown as ChatCompletionStreamRequest;
}

function toMistralMessage(value: unknown): Record<string, unknown> {
  const message = asRecord(value) ?? {};
  const output: Record<string, unknown> = { ...message };
  delete output.tool_calls;
  delete output.tool_call_id;
  delete output.reasoning;
  delete output.reasoning_content;
  if (message.tool_calls !== undefined) {
    output.toolCalls = asArray(message.tool_calls).map((entry) => {
      const call = asRecord(entry) ?? {};
      return {
        id: call.id,
        type: call.type,
        index: call.index,
        function: call.function,
      };
    });
  }
  if (message.tool_call_id !== undefined) output.toolCallId = message.tool_call_id;

  const content = Array.isArray(message.content)
    ? message.content.map(toMistralContent)
    : message.content;
  const thinking = asString(message.reasoning) ?? asString(message.reasoning_content);
  if (thinking !== undefined && thinking !== "") {
    const parts = Array.isArray(content)
      ? content
      : content === undefined || content === null || content === ""
        ? []
        : [{ type: "text", text: content }];
    output.content = [{ type: "thinking", thinking: [{ type: "text", text: thinking }] }, ...parts];
  } else {
    output.content = content;
  }
  return output;
}

function toMistralContent(value: unknown): unknown {
  const part = asRecord(value);
  if (part?.type !== "image_url") return value;
  const image = asRecord(part.image_url);
  return { type: "image_url", imageUrl: asString(image?.url) ?? part.image_url };
}

function copy(source: Record<string, unknown>, target: Record<string, unknown>, from: string, to: string): void {
  if (source[from] !== undefined) target[to] = source[from];
}

function fromMistralChunk(chunk: CompletionChunk): Record<string, unknown> {
  return {
    id: chunk.id,
    model: chunk.model,
    choices: chunk.choices.map((choice) => {
      const normalized = normalizeContent(choice.delta.content);
      return {
        index: choice.index,
        finish_reason: choice.finishReason,
        delta: {
          ...(choice.delta.role === undefined ? {} : { role: choice.delta.role }),
          ...(normalized.text === "" ? {} : { content: normalized.text }),
          ...(normalized.reasoning === "" ? {} : { reasoning: normalized.reasoning }),
          ...(choice.delta.toolCalls === undefined || choice.delta.toolCalls === null
            ? {}
            : {
                tool_calls: choice.delta.toolCalls.map((call) => ({
                  id: call.id,
                  type: call.type,
                  index: call.index,
                  function: {
                    name: call.function.name,
                    arguments: typeof call.function.arguments === "string"
                      ? call.function.arguments
                      : JSON.stringify(call.function.arguments),
                  },
                })),
              }),
        },
      };
    }),
    ...(chunk.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: chunk.usage.promptTokens,
            completion_tokens: chunk.usage.completionTokens,
            total_tokens: chunk.usage.totalTokens,
            ...cachedPromptUsage(chunk.usage),
          },
        }),
  };
}

function normalizeContent(content: string | ContentChunk[] | null | undefined): { text: string; reasoning: string } {
  if (typeof content === "string") return { text: content, reasoning: "" };
  let text = "";
  let reasoning = "";
  for (const item of content ?? []) {
    if (item.type === "text") text += item.text;
    if (item.type === "thinking") {
      for (const part of item.thinking) {
        if ("text" in part && typeof part.text === "string") reasoning += part.text;
      }
    }
  }
  return { text, reasoning };
}

function cachedPromptUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const cached = asRecord(usage.promptTokensDetails)?.cachedTokens
    ?? asRecord(usage.prompt_tokens_details)?.cached_tokens
    ?? usage.numCachedTokens
    ?? usage.num_cached_tokens;
  return cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached as JsonValue } };
}

function nestedTransportError(error: unknown): HttpResponseError | undefined {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== null && current !== undefined && !visited.has(current); depth += 1) {
    if (current instanceof HttpResponseError) return current;
    visited.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return undefined;
}
