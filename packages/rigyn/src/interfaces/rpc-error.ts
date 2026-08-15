import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";

const MAX_RPC_ERROR_BYTES = 4_096;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const TRUNCATION_MARKER = "...";

function inputPrefix(value: string): string {
  // A UTF-16 code unit occupies at least one UTF-8 byte. Keeping the default
  // redactor's full per-secret byte capacity prevents a registered secret that
  // begins before the output cutoff from being split before redaction.
  let end = Math.min(value.length, MAX_RPC_ERROR_BYTES + MAX_REGISTERED_SECRET_BYTES);
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

/** @internal Bound untrusted failure input before applying secret-redaction patterns. */
export function boundedRpcErrorMessage(error: unknown): string {
  const source = errorMessage(error);
  const selected = inputPrefix(source);
  const redacted = defaultSecretRedactor.redact(selected);
  const truncated = selected.length < source.length || Buffer.byteLength(redacted, "utf8") > MAX_RPC_ERROR_BYTES;
  if (!truncated) return redacted;
  return `${utf8Prefix(redacted, MAX_RPC_ERROR_BYTES - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
