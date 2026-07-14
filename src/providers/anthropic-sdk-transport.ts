import type Anthropic from "@anthropic-ai/sdk";
import type { Middleware } from "@anthropic-ai/sdk";

import { assertResponseOk, type FetchLike } from "./transport.js";

interface AnthropicSdkRequest {
  apiKey: string;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
  stream: boolean;
  signal: AbortSignal;
  fetch: FetchLike;
}

export async function requestAnthropicWithSdk(options: AnthropicSdkRequest): Promise<Response> {
  const sdk = await import("@anthropic-ai/sdk");
  const createMessage = options.method === "POST" && options.path === "/messages";
  const boundedErrors: Middleware = async (request, next) => {
    const response = await next(request);
    await assertResponseOk(response);
    return response;
  };
  const requestHeaders = new Headers(options.headers);
  requestHeaders.delete("x-api-key");
  const sdkFetch: FetchLike = async (input, init) => {
    const headers = new Headers(requestHeaders);
    const sdkHeaders = new Headers(init?.headers);
    const sdkApiKey = sdkHeaders.get("x-api-key");
    if (sdkApiKey !== null) headers.set("x-api-key", sdkApiKey);
    return await options.fetch(input, { ...init, headers, redirect: "error" });
  };
  const client = new sdk.default({
    apiKey: options.apiKey,
    baseURL: createMessage ? new URL(options.baseUrl).origin : options.baseUrl,
    fetch: sdkFetch,
    logLevel: "off",
    maxRetries: 0,
    middleware: [boundedErrors],
  });
  const requestOptions = {
    headers: requestHeaders,
    maxRetries: 0,
    signal: options.signal,
  };

  try {
    const pending = createMessage
      ? client.messages.create(messageParams(options.body), requestOptions)
      : options.method === "POST"
        ? client.post<unknown>(options.path, {
            ...requestOptions,
            stream: options.stream,
            ...(options.body === undefined ? {} : { body: options.body }),
          })
        : client.get<unknown>(options.path, { ...requestOptions, stream: options.stream });
    return await pending.asResponse();
  } catch (error) {
    if (options.signal.aborted) options.signal.throwIfAborted();
    if (error instanceof sdk.APIConnectionError) {
      if (error.cause !== undefined) throw error.cause;
      throw new TypeError(error.message);
    }
    throw error;
  }
}

function messageParams(body: string | undefined): Anthropic.MessageCreateParamsStreaming {
  if (body === undefined) throw new TypeError("Anthropic message request body is required");
  const params = JSON.parse(body) as Anthropic.MessageCreateParamsStreaming;
  return { ...params, stream: true };
}
