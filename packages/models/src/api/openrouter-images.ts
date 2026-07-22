import type {
  AssistantImages,
  ImagesContext,
  ImagesFunction,
  ImagesModel,
  ImagesOptions,
  Model,
  StreamOptions,
  Usage,
} from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { providerFetch } from "./internal/http.js";

const MAX_INPUT_ITEMS = 64;
const MAX_INPUT_IMAGES = 16;
const MAX_OUTPUT_IMAGES = 16;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 160 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

type WireRecord = Record<string, unknown>;

function record(value: unknown): WireRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as WireRecord : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteToken(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const target = new URL(/\/chat\/completions$/u.test(base) ? base : `${base}/chat/completions`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
    throw new TypeError("Image provider endpoint must use HTTPS or loopback HTTP");
  }
  if (target.username !== "" || target.password !== "" || target.hash !== "") {
    throw new TypeError("Image provider endpoint must not contain credentials or a fragment");
  }
  return target.href;
}

function imageDataUrl(mimeType: string, data: string): string {
  if (!/^image\/[a-z0-9.+-]{1,64}$/iu.test(mimeType)) throw new TypeError(`Invalid image media type: ${mimeType}`);
  if (data.length === 0 || data.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/iu.test(data)) {
    throw new TypeError("Image input must contain valid base64 data");
  }
  if (Buffer.byteLength(data, "base64") > MAX_IMAGE_BYTES) {
    throw new RangeError(`Image input exceeds ${MAX_IMAGE_BYTES} decoded bytes`);
  }
  return `data:${mimeType};base64,${data}`;
}

function payload(model: ImagesModel<"openrouter-images">, context: ImagesContext): WireRecord {
  if (!Array.isArray(context.input) || context.input.length === 0 || context.input.length > MAX_INPUT_ITEMS) {
    throw new RangeError(`Image generation input must contain 1 through ${MAX_INPUT_ITEMS} items`);
  }
  let images = 0;
  const content = context.input.map((item) => {
    if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
    if (!model.input.includes("image")) throw new TypeError(`Image model ${model.id} does not accept image input`);
    images += 1;
    if (images > MAX_INPUT_IMAGES) throw new RangeError(`Image generation accepts at most ${MAX_INPUT_IMAGES} input images`);
    return { type: "image_url", image_url: { url: imageDataUrl(item.mimeType, item.data) } };
  });
  return {
    model: model.id,
    messages: [{ role: "user", content }],
    stream: false,
    modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
  };
}

async function selectedPayload(
  model: ImagesModel<"openrouter-images">,
  context: ImagesContext,
  options: ImagesOptions | undefined,
): Promise<unknown> {
  const original = payload(model, context);
  const selected = await options?.onPayload?.(original, model) ?? original;
  const serialized = JSON.stringify(selected);
  if (serialized === undefined) throw new TypeError("Image request payload must be JSON serializable");
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Image request payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(serialized);
  if (record(parsed) === undefined) throw new TypeError("Image request payload must be a JSON object");
  return parsed;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RangeError(`Image response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) throw new TypeError("Image provider returned an empty response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new RangeError(`Image response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8")) as unknown;
}

function usage(model: ImagesModel<"openrouter-images">, value: unknown): Usage | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const details = record(raw.prompt_tokens_details);
  const prompt = finiteToken(raw.prompt_tokens);
  const output = finiteToken(raw.completion_tokens);
  const reportedCached = finiteToken(details?.cached_tokens);
  const cacheWrite = finiteToken(details?.cache_write_tokens);
  const cacheRead = Math.max(0, reportedCached - cacheWrite);
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  const costs = {
    input: model.cost.input * input / 1_000_000,
    output: model.cost.output * output / 1_000_000,
    cacheRead: model.cost.cacheRead * cacheRead / 1_000_000,
    cacheWrite: model.cost.cacheWrite * cacheWrite / 1_000_000,
    total: 0,
  };
  costs.total = costs.input + costs.output + costs.cacheRead + costs.cacheWrite;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: costs };
}

function appendImage(output: AssistantImages["output"], value: unknown): void {
  const image = record(value);
  const source = image?.image_url;
  const url = typeof source === "string" ? source : record(source)?.url;
  if (typeof url !== "string") return;
  const match = /^data:(image\/[a-z0-9.+-]{1,64});base64,([a-z0-9+/]*={0,2})$/iu.exec(url);
  if (match === null || match[2]!.length % 4 === 1 || Buffer.byteLength(match[2]!, "base64") > MAX_IMAGE_BYTES) return;
  output.push({ type: "image", mimeType: match[1]!, data: match[2]! });
}

function result(model: ImagesModel<"openrouter-images">, value: unknown, timestamp: number): AssistantImages {
  const body = record(value);
  if (body === undefined) throw new TypeError("Image provider response must be a JSON object");
  const choice = record(array(body.choices)[0]);
  const message = record(choice?.message);
  const output: AssistantImages["output"] = [];
  if (typeof message?.content === "string" && message.content !== "") {
    output.push({ type: "text", text: sanitizeSurrogates(message.content) });
  } else {
    const text = array(message?.content)
      .map(record)
      .filter((part): part is WireRecord => part?.type === "text" && typeof part.text === "string")
      .map((part) => sanitizeSurrogates(part.text as string))
      .join("");
    if (text !== "") output.push({ type: "text", text });
  }
  for (const image of array(message?.images).slice(0, MAX_OUTPUT_IMAGES)) appendImage(output, image);
  const parsedUsage = usage(model, body.usage);
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output,
    ...(typeof body.id === "string" && body.id !== "" ? { responseId: sanitizeSurrogates(body.id).slice(0, 4_096) } : {}),
    ...(parsedUsage === undefined ? {} : { usage: parsedUsage }),
    stopReason: "stop",
    timestamp,
  };
}

export const generateImages: ImagesFunction<"openrouter-images", ImagesOptions> = async (model, context, options) => {
  const timestamp = Date.now();
  try {
    options?.signal?.throwIfAborted();
    if (options?.apiKey === undefined || options.apiKey === "") throw new Error(`No API key for image provider: ${model.provider}`);
    const headers = new Headers(model.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${options.apiKey}`);
    const { onPayload: _onPayload, ...requestOptions } = options;
    const response = await providerFetch({
      model: model as unknown as Model<"openrouter-images">,
      url: endpoint(model.baseUrl),
      body: await selectedPayload(model, context, options),
      options: requestOptions as unknown as StreamOptions,
      headers,
      accept: "application/json",
    });
    return result(model, await boundedJson(response), timestamp);
  } catch (error) {
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: options?.signal?.aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp,
    };
  }
};
