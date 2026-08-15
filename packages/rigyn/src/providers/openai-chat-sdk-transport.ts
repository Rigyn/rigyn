import type OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";

import type { ProviderResponseDiagnostics } from "../core/types.js";
import { stringifyProviderJson } from "./json.js";
import {
  asRecord,
  asString,
  assertResponseOk,
  type FetchLike,
  jsonValueOrString,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
  responseDiagnostics,
} from "./transport.js";

type OpenAISdk = typeof import("openai");

export interface OpenAIChatSdkStreamInput {
  baseUrl: string;
  apiKey?: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse(diagnostics: ProviderResponseDiagnostics, requestId?: string): void;
  loadSdk?: () => Promise<OpenAISdk>;
}

/** Per-request official-client stream for OpenAI-compatible Chat Completions. */
export async function* streamOpenAIChatWithSdk(
  input: OpenAIChatSdkStreamInput,
): AsyncIterable<unknown> {
  const sdk = await (input.loadSdk?.() ?? import("openai"));
  const requestHeaders = new Headers(input.headers);
  requestHeaders.delete("authorization");
  const client: OpenAI = new sdk.default({
    apiKey: input.apiKey ?? "not-required",
    baseURL: input.baseUrl,
    fetch: boundedFetch(input.fetch, input.apiKey !== undefined, input.onResponse),
    maxRetries: 0,
    logLevel: "off",
  });
  try {
    const pending = client.chat.completions.create(
      JSON.parse(stringifyProviderJson(input.body)) as ChatCompletionCreateParamsStreaming,
      {
        headers: Object.fromEntries(requestHeaders),
        maxRetries: 0,
        signal: input.signal,
      },
    );
    const response = await pending.withResponse();
    const requestId = response.request_id ?? requestIdFromHeaders(response.response.headers);
    input.onResponse(responseDiagnostics(response.response), requestId);
    for await (const chunk of response.data) yield chunk;
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    if (error instanceof sdk.APIConnectionError && error.cause !== undefined) throw error.cause;
    if (error instanceof SyntaxError) {
      throw new ProtocolError("Malformed OpenAI Chat Completions stream event");
    }
    if (error instanceof sdk.APIError) {
      const payload = asRecord(error.error);
      const metadata = asRecord(payload?.metadata);
      const code = asString(metadata?.error_type)
        ?? (typeof error.code === "string" ? error.code : undefined)
        ?? error.type;
      throw new ProviderStreamError(error.message, code, jsonValueOrString({ error: payload ?? {} }));
    }
    throw error;
  }
}

function boundedFetch(
  fetchImplementation: FetchLike,
  authenticated: boolean,
  onResponse: OpenAIChatSdkStreamInput["onResponse"],
): FetchLike {
  return async (resource, init) => {
    const headers = new Headers(init?.headers ?? (resource instanceof Request ? resource.headers : undefined));
    if (!authenticated) headers.delete("authorization");
    const response = await fetchImplementation(resource, { ...init, headers, redirect: "error" });
    onResponse(responseDiagnostics(response), requestIdFromHeaders(response.headers));
    await assertResponseOk(response);
    return response;
  };
}
