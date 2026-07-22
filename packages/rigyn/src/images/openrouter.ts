import { validateImageSource } from "../core/image-source.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { UsageCost } from "../core/types.js";
import { sanitizeUnicode, stringifyProviderJson } from "../providers/json.js";
import { assertSecureEndpoint, HttpResponseError, ProtocolError, type FetchLike } from "../providers/transport.js";
import { imageErrorResult } from "./models.js";
import type {
  AssistantImages,
  ImagesContext,
  ImagesFunction,
  ImagesHeaders,
  ImagesImageContent,
  ImagesModel,
  ImagesOptions,
  ImagesProviderResponse,
  ImagesTextContent,
  ImagesUsage,
  ProviderImages,
} from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 160 * 1024 * 1024;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;
const MAX_OUTPUT_IMAGES = 16;
const MAX_ERROR_BYTES = 4 * 1024;
const SENSITIVE_HEADER = /(?:authorization|api[-_]?key|token|cookie|secret)/iu;

type OpenAISdk = typeof import("openai");

export interface OpenRouterImagesDependencies {
  loadSdk?: () => Promise<OpenAISdk>;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface OpenRouterImageResponse {
  id?: unknown;
  usage?: unknown;
  choices?: unknown;
}

interface OpenRouterPayload {
  model: string;
  messages: Array<{
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
  }>;
  stream: false;
  modalities: Array<"image" | "text">;
}

interface SdkResponse<T> {
  data: T;
  response: Response;
  request_id?: string | null;
}

interface SdkCompletionClient {
  chat: {
    completions: {
      create(
        payload: unknown,
        options: {
          signal?: AbortSignal;
          timeout?: number;
          maxRetries: number;
          headers?: Record<string, string>;
        },
      ): { withResponse(): Promise<SdkResponse<OpenRouterImageResponse>> };
    };
  };
}

export function createOpenRouterImagesApi(dependencies: OpenRouterImagesDependencies = {}): ProviderImages {
  const generate = createOpenRouterImagesGenerator(dependencies);
  return {
    generateImages: (model, context, options) => generate(
      model as ImagesModel<"openrouter-images">,
      context,
      options,
    ),
  };
}

export function createOpenRouterImagesGenerator(
  dependencies: OpenRouterImagesDependencies = {},
): ImagesFunction<"openrouter-images"> {
  let loaded: Promise<OpenAISdk> | undefined;
  const load = (): Promise<OpenAISdk> => {
    loaded ??= dependencies.loadSdk?.() ?? import("openai");
    return loaded;
  };

  return async (model, context, options): Promise<AssistantImages> => {
    const timestamp = dependencies.now?.() ?? Date.now();
    const output: AssistantImages = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: "stop",
      timestamp,
    };

    try {
      options?.signal?.throwIfAborted();
      const apiKey = options?.apiKey;
      if (apiKey === undefined || apiKey === "") {
        throw new Error(`No API key for image provider: ${model.provider}`);
      }
      defaultSecretRedactor.register(apiKey);
      assertSecureEndpoint(model.baseUrl, "Image provider endpoint");
      const retry = retryPolicy(options);
      const maximumResponseBytes = boundedInteger(
        options?.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        1,
        MAX_RESPONSE_BYTES,
        "maxResponseBytes",
      );
      const timeoutMs = options?.timeoutMs === undefined
        ? undefined
        : boundedInteger(options.timeoutMs, options.timeoutMs, 1, MAX_TIMEOUT_MS, "timeoutMs");
      const fetchImplementation = boundedSdkFetch(
        options?.fetch ?? dependencies.fetch ?? globalThis.fetch,
        maximumResponseBytes,
      );
      const sdk = await load();
      options?.signal?.throwIfAborted();
      const client = new sdk.default({
        apiKey,
        baseURL: model.baseUrl,
        fetch: fetchImplementation,
        maxRetries: 0,
        logLevel: "off",
      }) as unknown as SdkCompletionClient;
      const payload = await requestPayload(model, context, options);
      const headers = requestHeaders(model.headers, options?.headers);

      const response = await withRetries(
        async () => {
          options?.signal?.throwIfAborted();
          return await client.chat.completions.create(payload, {
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
            ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
            maxRetries: 0,
            ...(headers === undefined ? {} : { headers }),
          }).withResponse();
        },
        retry,
        dependencies.sleep ?? sleep,
        options?.signal,
        async (error) => {
          const responseInfo = responseFromError(error);
          if (responseInfo !== undefined) await options?.onResponse?.(responseInfo, model);
        },
      );

      const responseInfo = responseMetadata(response.response);
      await options?.onResponse?.(responseInfo, model);
      const parsed = parseImageResponse(response.data, model);
      output.output.push(...parsed.output);
      if (parsed.responseId !== undefined) output.responseId = parsed.responseId;
      if (parsed.usage !== undefined) output.usage = parsed.usage;
      return output;
    } catch (error) {
      const failed = imageErrorResult(model, error, options?.signal);
      failed.timestamp = timestamp;
      failed.errorMessage = normalizedImageError(error, options?.signal);
      return failed;
    }
  };
}

export const generateOpenRouterImages = createOpenRouterImagesGenerator();

async function requestPayload(
  model: ImagesModel<"openrouter-images">,
  context: ImagesContext,
  options: ImagesOptions | undefined,
): Promise<OpenRouterPayload> {
  if (!Array.isArray(context.input) || context.input.length === 0 || context.input.length > 64) {
    throw new TypeError("Image generation input must contain 1 through 64 content items");
  }
  let imageCount = 0;
  const content: OpenRouterPayload["messages"][number]["content"] = context.input.map((item) => {
    if (item.type === "text") {
      return { type: "text", text: sanitizeUnicode(item.text) };
    }
    imageCount += 1;
    if (imageCount > 16) throw new RangeError("Image generation input supports at most 16 images");
    const image = validateImageSource({
      type: "image",
      mediaType: item.mimeType,
      data: item.data,
    });
    if (image.kind !== "base64") throw new TypeError("Image generation input must use base64 image data");
    return {
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    };
  });
  const original: OpenRouterPayload = {
    model: model.id,
    messages: [{ role: "user", content }],
    stream: false,
    modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
  };
  const replacement = await options?.onPayload?.(original, model);
  const selected = replacement === undefined ? original : replacement;
  const serialized = stringifyProviderJson(selected);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Image request payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Image request payload must be a JSON object");
  }
  return parsed as OpenRouterPayload;
}

function requestHeaders(
  modelHeaders: Readonly<Record<string, string>> | undefined,
  request: ImagesHeaders | undefined,
): Record<string, string> | undefined {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of Object.entries(request ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  // Authorization is always owned by the resolved credential passed to the SDK.
  headers.delete("authorization");
  for (const [name, value] of headers) {
    if (SENSITIVE_HEADER.test(name)) defaultSecretRedactor.register(value);
  }
  const entries = [...headers.entries()];
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function responseMetadata(response: Response): ImagesProviderResponse {
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
}

function parseImageResponse(
  response: OpenRouterImageResponse,
  model: ImagesModel<"openrouter-images">,
): { output: Array<ImagesTextContent | ImagesImageContent>; responseId?: string; usage?: ImagesUsage } {
  const result: { output: Array<ImagesTextContent | ImagesImageContent>; responseId?: string; usage?: ImagesUsage } = {
    output: [],
  };
  if (typeof response.id === "string" && response.id !== "") {
    result.responseId = boundedText(sanitizeUnicode(response.id), 4_096);
  }
  const usage = parseUsage(response.usage, model);
  if (usage !== undefined) result.usage = usage;

  const choice = Array.isArray(response.choices) ? record(response.choices[0]) : undefined;
  const message = record(choice?.message);
  const content = message?.content;
  if (typeof content === "string" && content !== "") {
    result.output.push({ type: "text", text: sanitizeUnicode(content) });
  } else if (Array.isArray(content)) {
    const text = content
      .map((part) => record(part))
      .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text")
      .map((part) => typeof part.text === "string" ? sanitizeUnicode(part.text) : "")
      .join("");
    if (text !== "") result.output.push({ type: "text", text });
  }

  const images = Array.isArray(message?.images) ? message.images : [];
  for (const candidate of images.slice(0, MAX_OUTPUT_IMAGES)) {
    const image = record(candidate);
    const value = image?.image_url;
    const url = typeof value === "string" ? value : record(value)?.url;
    if (typeof url !== "string") continue;
    const parsed = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(url);
    if (parsed === null) continue;
    try {
      const validated = validateImageSource({
        type: "image",
        mediaType: parsed[1]!,
        data: parsed[2]!,
      });
      if (validated.kind === "base64") {
        result.output.push({
          type: "image",
          mimeType: validated.mediaType,
          data: validated.data,
        });
      }
    } catch {
      // Ignore malformed or oversized provider images while preserving valid siblings.
    }
  }
  return result;
}

function parseUsage(value: unknown, model: ImagesModel<"openrouter-images">): ImagesUsage | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const details = record(raw.prompt_tokens_details);
  const prompt = token(raw.prompt_tokens);
  const output = token(raw.completion_tokens);
  const reportedCached = token(details?.cached_tokens);
  const cacheWriteTokens = token(details?.cache_write_tokens);
  const cacheReadTokens = cacheWriteTokens > 0
    ? Math.max(0, reportedCached - cacheWriteTokens)
    : reportedCached;
  const inputTokens = Math.max(0, prompt - cacheReadTokens - cacheWriteTokens);
  const totalTokens = inputTokens + output + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(totalTokens)) return undefined;
  const usage: ImagesUsage = {
    inputTokens,
    outputTokens: output,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
  const cost = usageCost(usage, model);
  if (cost !== undefined) usage.cost = cost;
  return usage;
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function usageCost(
  usage: ImagesUsage,
  model: ImagesModel<"openrouter-images">,
): UsageCost | undefined {
  const pricing = model.pricing;
  if (
    pricing === undefined ||
    Object.values(pricing).some((value) => !Number.isFinite(value) || value < 0)
  ) return undefined;
  const input = pricing.input * usage.inputTokens / 1_000_000;
  const output = pricing.output * usage.outputTokens / 1_000_000;
  const cacheRead = pricing.cacheRead * usage.cacheReadTokens / 1_000_000;
  const cacheWrite = pricing.cacheWrite * usage.cacheWriteTokens / 1_000_000;
  const total = input + output + cacheRead + cacheWrite;
  return [input, output, cacheRead, cacheWrite, total].every(Number.isFinite)
    ? { input, output, cacheRead, cacheWrite, total }
    : undefined;
}

interface RetryPolicy {
  maximum: number;
  maximumServerDelayMs: number;
}

function retryPolicy(options: ImagesOptions | undefined): RetryPolicy {
  return {
    maximum: boundedInteger(options?.maxRetries, 0, 0, MAX_RETRIES, "maxRetries"),
    maximumServerDelayMs: boundedInteger(
      options?.maxRetryDelayMs,
      DEFAULT_MAX_RETRY_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
      "maxRetryDelayMs",
    ),
  };
}

async function withRetries<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  observeError: (error: unknown) => Promise<void>,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      await observeError(error);
      signal?.throwIfAborted();
      if (attempt >= policy.maximum || !retryable(error)) throw error;
      const requested = retryDelay(error);
      if (
        requested !== undefined &&
        policy.maximumServerDelayMs !== 0 &&
        requested > policy.maximumServerDelayMs
      ) {
        throw new Error(
          `Provider requested a retry delay of ${requested}ms, exceeding the ${policy.maximumServerDelayMs}ms cap`,
          { cause: error },
        );
      }
      const delay = requested ?? Math.min(10_000, 250 * 2 ** attempt);
      await wait(delay, signal);
      attempt += 1;
    }
  }
}

function retryable(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status);
  const name = error instanceof Error ? error.name : "";
  return error instanceof TypeError || /connection|timeout|network/iu.test(name);
}

function retryDelay(error: unknown): number | undefined {
  const headers = errorHeaders(error);
  const milliseconds = numericHeader(headers, "retry-after-ms");
  if (milliseconds !== undefined) return milliseconds;
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function numericHeader(headers: Headers | undefined, name: string): number | undefined {
  const raw = headers?.get(name);
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function responseFromError(error: unknown): ImagesProviderResponse | undefined {
  const status = errorStatus(error);
  const headers = errorHeaders(error);
  return status === undefined
    ? undefined
    : { status, headers: headers === undefined ? {} : Object.fromEntries(headers.entries()) };
}

function errorStatus(error: unknown): number | undefined {
  for (const current of errorChain(error)) {
    if (current instanceof HttpResponseError) return current.status;
    const status = record(current)?.status;
    if (typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

function errorHeaders(error: unknown): Headers | undefined {
  for (const current of errorChain(error)) {
    if (current instanceof HttpResponseError) return current.headers;
    const headers = record(current)?.headers;
    if (headers instanceof Headers) return headers;
    if (headers !== undefined) {
      try {
        return new Headers(headers as HeadersInit);
      } catch {
        // Keep walking the cause chain.
      }
    }
  }
  return undefined;
}

function* errorChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current);
    yield current;
    current = record(current)?.cause;
  }
}

function normalizedImageError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true || isAbortError(error)) return "Request cancelled";
  const status = errorStatus(error);
  const messages: string[] = [];
  for (const current of errorChain(error)) {
    const entry = record(current);
    if (current instanceof Error && current.message !== "") messages.push(current.message);
    collectErrorText(entry?.error, messages, 0);
    collectErrorText(entry?.body, messages, 0);
  }
  const unique = [...new Set(messages.map((message) => message.trim()).filter((message) => message !== ""))];
  const description = unique.slice(0, 3).join(": ") || String(error);
  return boundedError(status === undefined ? description : `HTTP ${status}: ${description}`);
}

function collectErrorText(value: unknown, output: string[], depth: number): void {
  if (value === undefined || value === null || depth > 5 || output.length >= 8) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectErrorText(entry, output, depth + 1);
    return;
  }
  const entry = record(value);
  if (entry === undefined) return;
  for (const name of ["message", "detail", "reason", "error", "body"]) {
    collectErrorText(entry[name], output, depth + 1);
  }
}

function boundedError(value: string): string {
  const text = defaultSecretRedactor.redact(sanitizeUnicode(value))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_ERROR_BYTES) return text;
  return `${bytes.subarray(0, MAX_ERROR_BYTES).toString("utf8")}…`;
}

function boundedText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maximumBytes
    ? value
    : bytes.subarray(0, maximumBytes).toString("utf8");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function boundedSdkFetch(fetchImplementation: FetchLike, maximum: number): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchImplementation(input, { ...init, redirect: "error" });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProtocolError(`Image response exceeded ${maximum} bytes`);
    }
    if (response.body === null) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum) throw new ProtocolError(`Image response exceeded ${maximum} bytes`);
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as FetchLike;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("Request cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Request cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
