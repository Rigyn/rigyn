import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "./errors.js";
import {
  MAX_DIRECTORY_SCAN_ENTRIES,
  preparePrivateObservabilityDirectory,
} from "./local-observability.js";
import type { ObservabilityMode } from "./observability.js";

export type LocalFailureOrigin = "uncaughtException" | "unhandledRejection" | "topLevel";

export interface LocalCrashReporter {
  report(error: unknown, origin: LocalFailureOrigin): void;
  close(): void;
}

interface LocalFailureDetails {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: LocalFailureDetails;
}

const MAX_FAILURE_TEXT_BYTES = 64 * 1024;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const MAX_CRASH_REPORTS = 32;
const CRASH_NAME = /^rigyn-crash-\d{8}T\d{6}-\d+-[a-f0-9]{12}\.json$/u;

function pruneCrashReports(directory: string, preserve: string): void {
  const reports: Array<{ path: string; modifiedAt: number; name: string }> = [];
  const handle = opendirSync(directory);
  try {
    for (let scanned = 0; scanned < MAX_DIRECTORY_SCAN_ENTRIES; scanned += 1) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (!entry.isFile() || !CRASH_NAME.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const information = lstatSync(path);
        if (information.isFile() && !information.isSymbolicLink()) {
          reports.push({ path, modifiedAt: information.mtimeMs, name: entry.name });
        }
      } catch {}
    }
  } finally {
    handle.closeSync();
  }
  reports.sort((left, right) => {
    if (left.path === preserve) return -1;
    if (right.path === preserve) return 1;
    return right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name);
  });
  for (const report of reports.slice(MAX_CRASH_REPORTS)) {
    try { unlinkSync(report.path); } catch {}
  }
}

function retainedInputPrefix(value: string): string {
  // A UTF-16 code unit occupies at least one UTF-8 byte. Keeping the default
  // redactor's full per-secret byte capacity prevents a registered secret that
  // begins before the output cutoff from being split before redaction.
  let end = Math.min(value.length, MAX_FAILURE_TEXT_BYTES + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < value.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end -= 1;
  return value.slice(0, end);
}

function utf8Prefix(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_FAILURE_TEXT_BYTES) return value;
  let end = MAX_FAILURE_TEXT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** @internal Bound fatal-path input before NUL removal and secret redaction. */
export function boundedRedactedFailureText(value: string): string {
  const retained = retainedInputPrefix(value);
  return utf8Prefix(defaultSecretRedactor.redact(retained).replaceAll("\0", ""));
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function failureDetails(error: unknown, depth = 0): LocalFailureDetails {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(error) !== true) {
    return { name: typeof error, message: boundedRedactedFailureText(errorMessage(error)) };
  }
  const selected = error as Error;
  const name = ownData(selected, "name");
  const message = ownData(selected, "message");
  const stack = ownData(selected, "stack");
  const codeValue = ownData(selected, "code");
  const cause = ownData(selected, "cause");
  const code = typeof codeValue === "string" || typeof codeValue === "number"
    ? boundedRedactedFailureText(String(codeValue))
    : undefined;
  return {
    name: typeof name === "string" && name !== "" ? boundedRedactedFailureText(name) : "Error",
    message: typeof message === "string" ? boundedRedactedFailureText(message) : "[Thrown Error]",
    ...(typeof stack === "string" ? { stack: boundedRedactedFailureText(stack) } : {}),
    ...(code === undefined ? {} : { code }),
    ...(depth >= 3 || cause === undefined ? {} : { cause: failureDetails(cause, depth + 1) }),
  };
}

/** Install a private, redacted last-resort crash reporter without changing Node's exit behavior. */
export async function installLocalCrashReporter(
  directory: string,
  mode: ObservabilityMode,
): Promise<LocalCrashReporter> {
  let selected: string | undefined;
  try { selected = await preparePrivateObservabilityDirectory(directory); }
  catch { return { report() {}, close() {} }; }
  const processInstance = randomBytes(8).toString("hex");
  let recorded = false;
  let recording = false;
  const record = (error: unknown, origin: LocalFailureOrigin): void => {
    if (recorded || recording || selected === undefined) return;
    recording = true;
    let descriptor: number | undefined;
    try {
      const timestamp = new Date();
      const name = `rigyn-crash-${timestamp.toISOString().replaceAll("-", "").replaceAll(":", "").slice(0, 15)}-${process.pid}-${randomBytes(6).toString("hex")}.json`;
      const serialized = `${JSON.stringify({
        schemaVersion: 1,
        kind: "rigyn-crash",
        timestamp: timestamp.toISOString(),
        processInstance,
        mode,
        origin,
        error: failureDetails(error),
      })}\n`;
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const path = join(selected, name);
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, serialized, { encoding: "utf8" });
      fsyncSync(descriptor);
      try { pruneCrashReports(selected, path); } catch {}
      recorded = true;
    } catch {
      // Crash reporting is best-effort and must never mask the original failure.
    } finally {
      recording = false;
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
    }
  };
  const onCrash = (error: unknown, origin: "uncaughtException" | "unhandledRejection"): void => {
    record(error, origin);
  };
  process.on("uncaughtExceptionMonitor", onCrash);
  return {
    report: record,
    close(): void { process.off("uncaughtExceptionMonitor", onCrash); },
  };
}
