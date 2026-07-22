import type {
  GenerateContentConfig,
  GenerateContentParameters,
  GoogleGenAIOptions,
} from "@google/genai";

import type { ProviderResponseDiagnostics } from "../core/types.js";
import { stringifyProviderJson } from "./json.js";
import { decodeSSE } from "./sse.js";
import { withScopedGlobalFetch } from "./scoped-global-fetch.js";
import {
  asRecord,
  assertResponseOk,
  type FetchLike,
  HttpResponseError,
  InvalidProviderRequestError,
  ProtocolError,
  requestIdFromHeaders,
  responseDiagnostics,
} from "./transport.js";

type GoogleSdk = typeof import("@google/genai");

export interface GoogleSdkStreamInput {
  kind: "google" | "vertex";
  model: string;
  baseUrl: string;
  project?: string;
  location?: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse(diagnostics: ProviderResponseDiagnostics, requestId?: string): void;
  loadSdk?: () => Promise<GoogleSdk>;
}

/** Official Google client stream with a concurrency-safe injected host transport. */
export async function* streamGoogleWithSdk(input: GoogleSdkStreamInput): AsyncIterable<unknown> {
  const sdk = await withScopedGlobalFetch(input.fetch, () => input.loadSdk?.() ?? import("@google/genai"));
  const networkFetch = googleFetch(input);
  const client = await withScopedGlobalFetch(networkFetch, async () => new sdk.GoogleGenAI(clientOptions(input)));
  const stream = await withScopedGlobalFetch(networkFetch, () =>
    client.models.generateContentStream(toGenerateContentParameters(input))
  );
  try {
    for await (const chunk of stream) yield chunk;
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    const transportError = nestedTransportError(error);
    if (transportError !== undefined) throw transportError;
    const message = error instanceof Error ? error.message : String(error);
    if (/Incomplete JSON segment|exception parsing stream chunk|response body is empty/iu.test(message)) {
      throw new ProtocolError("Malformed Google GenerateContent stream event");
    }
    throw error;
  }
}

function clientOptions(input: GoogleSdkStreamInput): GoogleGenAIOptions {
  const apiKey = input.headers.get("x-goog-api-key") ?? undefined;
  const accessToken = bearerToken(input.headers.get("authorization"));
  const httpOptions = {
    baseUrl: input.baseUrl,
    apiVersion: "",
    headers: requestHeaders(input.headers),
  };
  if (input.kind === "google") {
    if (apiKey === undefined) throw new InvalidProviderRequestError("No API key for provider: google");
    return { apiKey, httpOptions };
  }
  if (apiKey !== undefined) return { vertexai: true, apiKey, httpOptions };
  if (accessToken === undefined) {
    throw new InvalidProviderRequestError("No API key or access token for provider: google-vertex");
  }
  if (input.project === undefined || input.location === undefined) {
    throw new InvalidProviderRequestError("Vertex AI requires a project and location");
  }
  return { vertexai: true, apiKey: "not-required", httpOptions };
}

function requestHeaders(headers: Headers): Record<string, string> {
  const result = Object.fromEntries(headers);
  delete result.authorization;
  delete result["x-goog-api-key"];
  return result;
}

function googleFetch(input: GoogleSdkStreamInput): FetchLike {
  return async (resource, init) => {
    const headers = new Headers(init?.headers ?? (resource instanceof Request ? resource.headers : undefined));
    if (!input.headers.has("x-goog-api-key")) headers.delete("x-goog-api-key");
    for (const [name, value] of input.headers) headers.set(name, value);
    const response = await input.fetch(resource, {
      ...init,
      headers,
      signal: input.signal,
      redirect: "error",
    });
    input.onResponse(responseDiagnostics(response), requestIdFromHeaders(response.headers));
    await assertResponseOk(response);
    return filterDoneSentinel(response);
  };
}

function filterDoneSentinel(response: Response): Response {
  if (response.body === null || !/^text\/event-stream(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    return response;
  }
  const source = response.body;
  const events = decodeSSE(source)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const next = await events.next();
          if (next.done) {
            controller.close();
            return;
          }
          const event = next.value;
          if (event.data.trim() === "[DONE]") continue;
          controller.enqueue(encoder.encode(`${event.raw.join("\n")}\n\n`));
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await events.return?.();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function toGenerateContentParameters(input: GoogleSdkStreamInput): GenerateContentParameters {
  const body = JSON.parse(stringifyProviderJson(input.body)) as Record<string, unknown>;
  const generation = asRecord(body.generationConfig) ?? {};
  const config = {
    ...(body.systemInstruction === undefined
      ? {}
      : { systemInstruction: body.systemInstruction as GenerateContentConfig["systemInstruction"] }),
    ...(body.tools === undefined ? {} : { tools: body.tools as GenerateContentConfig["tools"] }),
    ...(generation.maxOutputTokens === undefined ? {} : { maxOutputTokens: generation.maxOutputTokens as number }),
    ...(generation.thinkingConfig === undefined
      ? {}
      : { thinkingConfig: generation.thinkingConfig as GenerateContentConfig["thinkingConfig"] }),
    abortSignal: input.signal,
  } as GenerateContentConfig;
  return {
    model: input.kind === "vertex" ? `models/${stripModelPrefix(input.model)}` : stripModelPrefix(input.model),
    contents: body.contents as GenerateContentParameters["contents"],
    config,
  };
}

function bearerToken(authorization: string | null): string | undefined {
  return /^Bearer\s+(.+)$/iu.exec(authorization ?? "")?.[1];
}

function stripModelPrefix(model: string): string {
  return model.replace(/^models\//u, "");
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
