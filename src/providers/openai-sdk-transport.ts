import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

import { stringifyProviderJson } from "./json.js";
import type { ResponsesEventStreamInput, ResponsesWireEvent } from "./openai-responses.js";
import type { ProviderResponseDiagnostics } from "../core/types.js";
import {
  assertResponseOk,
  HttpResponseError,
  jsonValueOrString,
  ProtocolError,
  responseDiagnostics,
  type FetchLike,
} from "./transport.js";

const DEFAULT_MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;

type ResponsesEventFallback = (input: ResponsesEventStreamInput) => AsyncIterable<ResponsesWireEvent>;
type ResponsesEventFromValue = (
  value: unknown,
  requestId?: string,
  diagnostics?: ProviderResponseDiagnostics,
) => ResponsesWireEvent;
type OpenAISdk = typeof import("openai");

export interface OpenAISdkEventStreamConfig {
  baseUrl: string;
  fetch: FetchLike;
  fallback: ResponsesEventFallback;
  eventFromValue: ResponsesEventFromValue;
  loadSdk?: () => Promise<OpenAISdk>;
  maxSseEventBytes?: number;
}

/**
 * Uses the official client only for the first-party Responses request while
 * retaining Rigyn's authorization, network transport, event contract, and
 * bounded-stream invariants.
 */
export function createOpenAISdkEventStream(
  config: OpenAISdkEventStreamConfig,
): (input: ResponsesEventStreamInput) => AsyncIterable<ResponsesWireEvent> {
  const fetchImplementation = guardedSdkFetch(config.fetch, config.maxSseEventBytes);
  let loaded: Promise<OpenAISdk> | undefined;
  const load = (): Promise<OpenAISdk> => {
    loaded ??= config.loadSdk?.() ?? import("openai");
    return loaded;
  };
  return (input) => sdkResponsesWireEvents(
    load,
    input,
    config,
    fetchImplementation,
  );
}

async function* sdkResponsesWireEvents(
  load: () => Promise<OpenAISdk>,
  input: ResponsesEventStreamInput,
  config: OpenAISdkEventStreamConfig,
  fetchImplementation: FetchLike,
): AsyncGenerator<ResponsesWireEvent> {
  const apiKey = bearerToken(input.headers.get("authorization"));
  if (apiKey === undefined) {
    yield* config.fallback(input);
    return;
  }

  let requestId: string | undefined;
  const sdk = await load();
  const client: OpenAI = new sdk.default({
    apiKey,
    baseURL: config.baseUrl,
    fetch: fetchImplementation,
    maxRetries: 0,
    logLevel: "off",
  });
  try {
    const body = JSON.parse(stringifyProviderJson(input.body)) as ResponseCreateParamsStreaming;
    const headers = Object.fromEntries(input.headers);
    delete headers.authorization;
    const response = await client.responses.create(body, {
      headers,
      maxRetries: 0,
      signal: input.signal,
    }).withResponse();
    requestId = response.request_id ?? undefined;
    const diagnostics = responseDiagnostics(response.response);
    input.onResponse?.(diagnostics, requestId);
    for await (const event of response.data) {
      yield config.eventFromValue(event, requestId, diagnostics);
    }
  } catch (error) {
    const rigynError = nestedRigynError(error);
    if (rigynError !== undefined) throw rigynError;

    if (error instanceof sdk.APIError && error.status === undefined && error.error !== undefined) {
      const streamedRequestId = requestId ?? error.requestID ?? undefined;
      yield config.eventFromValue(
        { type: "error", error: jsonValueOrString(error.error) },
        streamedRequestId,
      );
      return;
    }

    throw translateSdkError(error, sdk);
  }
}

function bearerToken(authorization: string | null): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  return match?.[1];
}

function guardedSdkFetch(fetchImplementation: FetchLike, maximum?: number): FetchLike {
  const maxEventBytes = maximum ?? DEFAULT_MAX_SSE_EVENT_BYTES;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) {
    throw new RangeError("maxSseEventBytes must be positive");
  }
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchImplementation(input, { ...init, redirect: "error" });
    if (!response.ok) {
      await assertResponseOk(response);
      throw new HttpResponseError(response.status, response.headers, response.statusText || `HTTP ${response.status}`);
    }
    if (response.body === null) return response;
    return new Response(guardSseBody(response.body, maxEventBytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as FetchLike;
}

function guardSseBody(
  body: ReadableStream<Uint8Array>,
  maxEventBytes: number,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let eventBytes = 0;
  let lineBytes = 0;
  let comment = false;
  let pendingCarriageReturn = false;

  const finishLine = (): void => {
    if (lineBytes === 0) {
      eventBytes = 0;
    } else if (!comment) {
      eventBytes += lineBytes + 1;
      if (eventBytes > maxEventBytes) {
        throw new ProtocolError(`SSE event exceeded ${maxEventBytes} bytes`);
      }
    }
    lineBytes = 0;
    comment = false;
  };

  const validateChunk = (chunk: Uint8Array): void => {
    try {
      decoder.decode(chunk, { stream: true });
    } catch {
      throw new ProtocolError("Stream contained invalid UTF-8");
    }
    for (const byte of chunk) {
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        if (byte === 0x0a) continue;
      }
      if (byte === 0x0d || byte === 0x0a) {
        finishLine();
        pendingCarriageReturn = byte === 0x0d;
        continue;
      }
      if (lineBytes === 0) comment = byte === 0x3a;
      lineBytes += 1;
      if (lineBytes > maxEventBytes || (!comment && eventBytes + lineBytes + 1 > maxEventBytes)) {
        throw new ProtocolError(`SSE event exceeded ${maxEventBytes} bytes`);
      }
    }
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      validateChunk(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      try {
        decoder.decode();
      } catch {
        throw new ProtocolError("Stream contained invalid UTF-8");
      }
      if (lineBytes > 0) finishLine();
    },
  }));
}

function nestedRigynError(error: unknown): HttpResponseError | ProtocolError | undefined {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== undefined && current !== null && !visited.has(current); depth += 1) {
    if (current instanceof HttpResponseError || current instanceof ProtocolError) return current;
    visited.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return undefined;
}

function translateSdkError(error: unknown, sdk: OpenAISdk): unknown {
  if (error instanceof sdk.APIConnectionTimeoutError) {
    return new TypeError(error.message, { cause: error });
  }
  if (error instanceof sdk.APIConnectionError) {
    return new TypeError(error.message, { cause: error });
  }
  if (error instanceof SyntaxError) {
    return new ProtocolError("Malformed OpenAI Responses stream event");
  }
  if (error instanceof sdk.APIError && error.status !== undefined && error.headers !== undefined) {
    const body = error.error === undefined
      ? undefined
      : jsonValueOrString({ error: error.error });
    return new HttpResponseError(error.status, error.headers, error.message, body);
  }
  return error;
}
