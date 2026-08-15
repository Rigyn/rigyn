import {
  closeSync,
  constants as fileConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { getDebugLogPath } from "../config/paths.js";
import type { SurfaceRenderDiagnostic } from "./surface-renderer.js";
import { byteTruncate, sanitizeTerminalText } from "./unicode.js";

const MAX_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TUI_DIAGNOSTIC_BYTES = 4 * 1_024;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;

function retainedDiagnosticPrefix(value: string): string {
  // Preserve the redactor's full per-secret capacity beyond the visible
  // boundary so a registered secret crossing that boundary is never split.
  let end = Math.min(value.length, MAX_TUI_DIAGNOSTIC_BYTES + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < value.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end -= 1;
  return value.slice(0, end);
}

/** @internal Redact and terminal-normalize bounded input, then enforce the final UTF-8 output cap. */
export function boundedTuiDiagnosticText(value: string): string {
  const retained = retainedDiagnosticPrefix(value);
  return byteTruncate(
    sanitizeTerminalText(defaultSecretRedactor.redact(retained)),
    MAX_TUI_DIAGNOSTIC_BYTES,
  );
}

/** @internal Convert hostile thrown values without property access and bound the resulting diagnostic. */
export function boundedTuiFailureText(value: unknown): string {
  return boundedTuiDiagnosticText(errorMessage(value));
}

function containsSymbolicLink(value: string): boolean {
  const root = parse(value).root;
  let current = root;
  for (const segment of value.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

function writeDiagnostic(path: string, message: string): void {
  if (path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return;
  const selected = resolve(path);
  if (Buffer.byteLength(selected, "utf8") > MAX_PATH_BYTES) return;
  const directory = dirname(selected);
  let descriptor: number | undefined;
  try {
    if (containsSymbolicLink(directory)) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (containsSymbolicLink(directory)) return;
    try {
      if (lstatSync(selected).isSymbolicLink()) return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const noFollow = "O_NOFOLLOW" in fileConstants ? fileConstants.O_NOFOLLOW : 0;
    const baseFlags = fileConstants.O_WRONLY | fileConstants.O_CREAT | noFollow;
    descriptor = openSync(
      selected,
      baseFlags | fileConstants.O_APPEND,
      0o600,
    );
    const entry = Buffer.from(`${message}\n`, "utf8");
    if (fstatSync(descriptor).size + entry.length > MAX_FILE_BYTES) {
      closeSync(descriptor);
      descriptor = undefined;
      descriptor = openSync(selected, baseFlags | fileConstants.O_TRUNC, 0o600);
    }
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    writeSync(descriptor, entry);
  } catch {
    // Diagnostics are optional and must not affect the terminal.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* ignore diagnostic cleanup failures */ }
    }
  }
}

export function createTuiDiagnosticSink(
  environment: NodeJS.ProcessEnv,
): ((event: SurfaceRenderDiagnostic) => void) | undefined {
  if (environment.RIGYN_DEBUG_REDRAW !== "1") return undefined;
  const path = getDebugLogPath(environment);
  return (event) => {
    writeDiagnostic(
      path,
      `[${new Date().toISOString()}] surface-render strategy=${event.strategy} previous=${event.previousRows} next=${event.nextRows} changed=${event.changedRows} viewport=${event.columns}x${event.terminalRows}`,
    );
  };
}
