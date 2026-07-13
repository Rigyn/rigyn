import { access, open } from "node:fs/promises";

export type CloudAuthFailureKind = "network" | "timeout" | "response_limit" | "file";

export class CloudAuthIoError extends Error {
  readonly kind: CloudAuthFailureKind;

  constructor(kind: CloudAuthFailureKind, message: string) {
    super(message);
    this.name = "CloudAuthIoError";
    this.kind = kind;
  }
}

export interface BoundedRequestOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
  label: string;
  signal?: AbortSignal;
}

export interface BoundedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text: string;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function requestSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function readResponseBody(
  response: Response,
  maxResponseBytes: number,
  label: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CloudAuthIoError("response_limit", `${label} response exceeded configured limit`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function requestBounded(
  input: string | URL,
  init: RequestInit,
  options: BoundedRequestOptions,
): Promise<BoundedResponse> {
  positiveInteger(options.timeoutMs, "timeoutMs");
  positiveInteger(options.maxResponseBytes, "maxResponseBytes");
  options.signal?.throwIfAborted();

  const timeoutSignal = requestSignal(options.timeoutMs, options.signal);
  let response: Response;
  try {
    response = await options.fetch(input, {
      ...init,
      signal: timeoutSignal,
      redirect: init.redirect ?? "error",
    });
  } catch {
    if (options.signal?.aborted === true) {
      throw new CloudAuthIoError("network", `${options.label} request was cancelled`);
    }
    if (timeoutSignal.aborted) {
      throw new CloudAuthIoError("timeout", `${options.label} request timed out`);
    }
    throw new CloudAuthIoError("network", `${options.label} request failed`);
  }

  let text: string;
  try {
    text = await readResponseBody(response, options.maxResponseBytes, options.label);
  } catch (error) {
    if (error instanceof CloudAuthIoError) throw error;
    if (options.signal?.aborted === true) {
      throw new CloudAuthIoError("network", `${options.label} response was cancelled`);
    }
    if (timeoutSignal.aborted) {
      throw new CloudAuthIoError("timeout", `${options.label} response timed out`);
    }
    throw new CloudAuthIoError("network", `${options.label} response failed`);
  }
  return { ok: response.ok, status: response.status, headers: response.headers, text };
}

export function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} response was not JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response was malformed`);
  }
  return value as Record<string, unknown>;
}

export async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<string> {
  positiveInteger(maxBytes, "maxBytes");
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new CloudAuthIoError("file", `Unable to open ${label}`);
  }

  try {
    const information = await handle.stat();
    if (!information.isFile()) throw new CloudAuthIoError("file", `${label} is not a regular file`);
    if (information.size > maxBytes) {
      throw new CloudAuthIoError("file", `${label} exceeded configured limit`);
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(8 * 1024, maxBytes + 1 - bytes));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new CloudAuthIoError("file", `${label} exceeded configured limit`);
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof CloudAuthIoError) throw error;
    throw new CloudAuthIoError("file", `Unable to read ${label}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readOptionalBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string | undefined> {
  try {
    await access(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new CloudAuthIoError("file", `Unable to access ${label}`);
  }
  return readBoundedFile(path, maxBytes, label);
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function configuredHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`${label} must be an HTTPS URL without embedded credentials`);
  }
  return url;
}
