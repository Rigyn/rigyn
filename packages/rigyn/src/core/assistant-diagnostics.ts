import { providerResponseDiagnostic, type AssistantMessageDiagnostic } from "@rigyn/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { isJsonValue } from "./json.js";
import { validateProviderResponseDiagnostics } from "./provider-diagnostics.js";
import type { ProviderResponseDiagnostics } from "./types.js";

const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
const MAX_TYPE_BYTES = 256;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_ERROR_TEXT_BYTES = 4 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  const redacted = defaultSecretRedactor.redact(value).replaceAll("\0", "�");
  if (Buffer.byteLength(redacted, "utf8") > maximumBytes) {
    throw new TypeError(`${label} exceeds its byte limit`);
  }
  return redacted;
}

function diagnosticError(value: unknown): NonNullable<AssistantMessageDiagnostic["error"]> {
  const selected = record(value, "Assistant diagnostic error");
  exactKeys(selected, new Set(["name", "message", "code", "status"]), "Assistant diagnostic error");
  const status = selected.status;
  if (status !== undefined && (typeof status !== "number" || !Number.isFinite(status))) {
    throw new TypeError("Assistant diagnostic error status must be finite");
  }
  return {
    ...(selected.name === undefined ? {} : { name: text(selected.name, "Assistant diagnostic error name", MAX_TYPE_BYTES) }),
    message: text(selected.message, "Assistant diagnostic error message", MAX_ERROR_TEXT_BYTES),
    ...(selected.code === undefined ? {} : { code: text(selected.code, "Assistant diagnostic error code", MAX_TYPE_BYTES) }),
    ...(status === undefined ? {} : { status }),
  };
}

function diagnosticDetails(value: unknown): Record<string, unknown> {
  const redacted = defaultSecretRedactor.redactValue(value);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted) || !isJsonValue(redacted)) {
    throw new TypeError("Assistant diagnostic details must be a JSON-safe object");
  }
  return structuredClone(redacted) as Record<string, unknown>;
}

/**
 * Validates, detaches, bounds, and redacts assistant diagnostics before they
 * enter durable history or cross an extension boundary.
 */
export function canonicalAssistantDiagnostics(value: unknown): AssistantMessageDiagnostic[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("Assistant diagnostics must be an array");
  if (value.length > MAX_DIAGNOSTICS) throw new TypeError("Assistant diagnostics exceed their item limit");

  const diagnostics: AssistantMessageDiagnostic[] = [];
  let totalBytes = 0;
  for (const [index, item] of value.entries()) {
    const selected = record(item, `Assistant diagnostic ${index}`);
    exactKeys(selected, new Set(["type", "message", "error", "details", "timestamp"]), `Assistant diagnostic ${index}`);
    if (typeof selected.timestamp !== "number" || !Number.isFinite(selected.timestamp) || selected.timestamp < 0) {
      throw new TypeError(`Assistant diagnostic ${index} timestamp must be a non-negative finite number`);
    }
    const diagnostic: AssistantMessageDiagnostic = {
      type: text(selected.type, `Assistant diagnostic ${index} type`, MAX_TYPE_BYTES),
      message: text(selected.message, `Assistant diagnostic ${index} message`, MAX_MESSAGE_BYTES),
      ...(selected.error === undefined ? {} : { error: diagnosticError(selected.error) }),
      ...(selected.details === undefined ? {} : { details: diagnosticDetails(selected.details) }),
      timestamp: selected.timestamp,
    };
    const bytes = Buffer.byteLength(JSON.stringify(diagnostic), "utf8");
    if (bytes > MAX_DIAGNOSTIC_BYTES) throw new TypeError(`Assistant diagnostic ${index} exceeds its byte limit`);
    totalBytes += bytes;
    if (totalBytes > MAX_DIAGNOSTICS_BYTES) throw new TypeError("Assistant diagnostics exceed their total byte limit");
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** Creates the canonical public diagnostic for an allowlisted provider response. */
export function assistantDiagnosticsFromProviderResponse(
  response: ProviderResponseDiagnostics | undefined,
): AssistantMessageDiagnostic[] | undefined {
  return response === undefined
    ? undefined
    : canonicalAssistantDiagnostics([
        providerResponseDiagnostic(validateProviderResponseDiagnostics(response)),
      ]);
}
