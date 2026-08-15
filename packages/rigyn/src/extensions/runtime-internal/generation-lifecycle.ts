import { defaultSecretRedactor } from "../../auth/redaction.js";
import { errorMessage } from "../../core/errors.js";

const MAX_RUNTIME_FAILURE_BYTES = 4_096;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const FAILURE_TRUNCATION_MARKER = "...";

function inputPrefix(value: string, maximumBytes: number): string {
  let end = Math.min(value.length, maximumBytes + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < value.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end -= 1;
  return value.slice(0, end);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function boundedRuntimeFailureMessage(
  value: unknown,
  maximumBytes = MAX_RUNTIME_FAILURE_BYTES,
): string {
  const source = errorMessage(value);
  const retained = inputPrefix(source, maximumBytes);
  const redacted = defaultSecretRedactor.redact(retained);
  const truncated = retained.length < source.length
    || Buffer.byteLength(redacted, "utf8") > maximumBytes;
  if (!truncated) return redacted;
  return `${utf8Prefix(
    redacted,
    maximumBytes - FAILURE_TRUNCATION_MARKER.length,
  )}${FAILURE_TRUNCATION_MARKER}`;
}

export function runtimeError(value: unknown): Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(value) === true ? value as Error : new Error(errorMessage(value), { cause: value });
}

export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function withAbort<T>(value: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await value;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function runRuntimeCleanupPhase(
  cleanups: readonly (() => void | Promise<void>)[],
  timeoutMs: number,
  label: string,
): Promise<Error[]> {
  if (cleanups.length === 0) return [];
  const deadline = Date.now() + timeoutMs;
  const failures: Error[] = [];
  let pendingCount = 0;
  for (const cleanup of cleanups) {
    let settled = false;
    let failure: unknown;
    let returned: void | Promise<void>;
    try {
      returned = cleanup();
    } catch (cause) {
      settled = true;
      failure = cause;
      returned = undefined;
    }
    const completion = Promise.resolve(returned).then(
      () => { settled = true; },
      (cause: unknown) => { settled = true; failure = cause; },
    );
    const remaining = deadline - Date.now();
    if (!settled && remaining > 0) {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          timer.unref();
        }),
      ]);
    }
    if (!settled) pendingCount += 1;
    else if (failure !== undefined) {
      const prefix = `${label} failed: `;
      failures.push(new Error(
        `${prefix}${boundedRuntimeFailureMessage(failure, MAX_RUNTIME_FAILURE_BYTES - Buffer.byteLength(prefix, "utf8"))}`,
        { cause: failure },
      ));
    }
  }
  if (pendingCount > 0) {
    failures.push(new Error(
      `${label} timed out after ${timeoutMs}ms with ${pendingCount} cleanup callback(s) still pending`,
    ));
  }
  return failures;
}

export function onceRuntimeCleanup(cleanup: () => void | Promise<void>): () => Promise<void> {
  let flight: Promise<void> | undefined;
  return async () => {
    flight ??= Promise.resolve().then(cleanup);
    await flight;
  };
}
