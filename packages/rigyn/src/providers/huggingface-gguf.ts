import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FetchLike } from "./transport.js";

const RESPONSE_LIMIT_BYTES = 4 * 1_024 * 1_024;
const RESULT_LIMIT = 20;
const GGUF_QUANTIZATION = /(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$/iu;
const SHARD_SUFFIX = /-\d{5}-of-\d{5}$/u;

export interface GgufSearchResult {
  id: string;
  downloads: number;
}

export interface GgufQuantization {
  name: string;
  sizeBytes?: number;
}

export interface GgufModelDetails {
  id: string;
  gated: false | "auto" | "manual";
  quantizations: GgufQuantization[];
}

export interface HuggingFaceGgufClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Model catalog URL must use HTTPS or loopback HTTP");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Model catalog URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Model catalog response exceeded 4 MiB");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return bytes === 0 ? undefined : JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
}

function responseMessage(value: unknown, fallback: string): string {
  const error = object(value)?.error;
  return typeof error === "string" && error !== "" ? error : fallback;
}

function retryDelaySeconds(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/u.test(retryAfter)) return Number(retryAfter);
  const match = headers.get("ratelimit")?.match(/(?:^|;)t=(\d+)(?:;|$)/u);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function optionalTokenFile(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || path.includes("\0") || !isAbsolute(path)) return undefined;
  try {
    const token = (await readFile(path, "utf8")).trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

export async function discoverHuggingFaceToken(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  home = homedir(),
): Promise<string | undefined> {
  const direct = env.HF_TOKEN?.trim();
  if (direct !== undefined && direct !== "") return direct;
  const candidates = [
    env.HF_TOKEN_PATH,
    env.HF_HOME === undefined ? undefined : join(env.HF_HOME, "token"),
    env.XDG_CACHE_HOME === undefined ? undefined : join(env.XDG_CACHE_HOME, "huggingface", "token"),
    join(home, ".cache", "huggingface", "token"),
  ];
  for (const candidate of new Set(candidates)) {
    const token = await optionalTokenFile(candidate);
    if (token !== undefined) return token;
  }
  return undefined;
}

export class HuggingFaceGgufClient {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: HuggingFaceGgufClientOptions = {}) {
    this.#token = options.token?.trim() || undefined;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://huggingface.co");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 250 || this.#timeoutMs > 120_000) {
      throw new RangeError("Model catalog timeout must be 250-120000ms");
    }
  }

  async #request(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const selectedSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const headers = new Headers({ accept: "application/json" });
    if (this.#token !== undefined) headers.set("authorization", `Bearer ${this.#token}`);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      headers,
      signal: selectedSignal,
      redirect: "error",
    });
    const payload = await readBoundedJson(response);
    if (response.status === 429) {
      const delay = retryDelaySeconds(response.headers);
      throw new Error(delay === undefined
        ? "Model catalog rate limit reached"
        : `Model catalog rate limit reached; retry in ${delay}s`);
    }
    if (!response.ok) throw new Error(responseMessage(payload, `Model catalog returned HTTP ${response.status}`));
    return payload;
  }

  async search(query: string, signal?: AbortSignal): Promise<GgufSearchResult[]> {
    const normalized = query.trim();
    if (normalized === "" || normalized.includes("\0") || Buffer.byteLength(normalized) > 1_024) {
      throw new Error("Model search query was invalid");
    }
    const parameters = new URLSearchParams({
      search: normalized,
      filter: "gguf",
      sort: "downloads",
      direction: "-1",
      limit: String(RESULT_LIMIT),
    });
    const payload = await this.#request(`/api/models?${parameters.toString()}`, signal);
    if (!Array.isArray(payload) || payload.length > RESULT_LIMIT) throw new Error("Model catalog returned invalid search results");
    return payload.flatMap((value) => {
      const entry = object(value);
      if (typeof entry?.id !== "string" || entry.id === "" || Buffer.byteLength(entry.id) > 4_096) return [];
      const downloads = typeof entry.downloads === "number" && Number.isSafeInteger(entry.downloads) && entry.downloads >= 0
        ? entry.downloads
        : 0;
      return [{ id: entry.id, downloads }];
    });
  }

  async details(id: string, signal?: AbortSignal): Promise<GgufModelDetails> {
    const normalized = id.trim();
    if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized) || Buffer.byteLength(normalized) > 4_096) {
      throw new Error("Model repository ID must use owner/name format");
    }
    const encoded = normalized.split("/").map((part) => encodeURIComponent(part)).join("/");
    const model = object(await this.#request(`/api/models/${encoded}?blobs=true`, signal));
    if (model === undefined) throw new Error("Model catalog returned invalid model details");
    const sizes = new Map<string, { bytes: number; complete: boolean }>();
    if (Array.isArray(model.siblings)) {
      for (const candidate of model.siblings.slice(0, 100_000)) {
        const file = object(candidate);
        if (typeof file?.rfilename !== "string" || !file.rfilename.toLowerCase().endsWith(".gguf")) continue;
        const name = file.rfilename.split("/").at(-1) ?? "";
        if (name.toLowerCase().startsWith("mmproj")) continue;
        const stem = name.slice(0, -5).replace(SHARD_SUFFIX, "");
        const quantization = stem.match(GGUF_QUANTIZATION)?.[1]?.toUpperCase();
        if (quantization === undefined) continue;
        const current = sizes.get(quantization) ?? { bytes: 0, complete: true };
        if (typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0) current.bytes += file.size;
        else current.complete = false;
        sizes.set(quantization, current);
      }
    }
    const quantizations = [...sizes].map(([name, size]) => ({
      name,
      ...(size.complete ? { sizeBytes: size.bytes } : {}),
    })).sort((left, right) => {
      if (left.name === "Q4_K_M") return -1;
      if (right.name === "Q4_K_M") return 1;
      return (left.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (right.sizeBytes ?? Number.MAX_SAFE_INTEGER)
        || left.name.localeCompare(right.name);
    });
    return {
      id: typeof model.id === "string" && model.id !== "" ? model.id : normalized,
      gated: model.gated === "auto" || model.gated === "manual" ? model.gated : false,
      quantizations,
    };
  }
}
