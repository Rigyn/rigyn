import type { ToolProgress } from "../core/events.js";

export const SHELL_PROGRESS_FLUSH_MS = 40;
export const SHELL_PROGRESS_FLUSH_BYTES = 8 * 1024;
export const SHELL_PROGRESS_HEARTBEAT_MS = 10_000;

/**
 * Coalesces process output without applying backpressure to stdout/stderr pipes.
 * The callback uses the same bounded output-only channel for built-in and
 * extension tools; the ToolCoordinator supplies correlation and hard limits.
 */
export class CoalescedOutputProgress {
  readonly #report: (progress: ToolProgress) => void;
  readonly #decoders = {
    stdout: new TextDecoder("utf-8"),
    stderr: new TextDecoder("utf-8"),
  };
  readonly #pending = { stdout: "", stderr: "" };
  #pendingBytes = 0;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #timer: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  readonly #startedAt = Date.now();
  #lastStream: "stdout" | "stderr" = "stdout";
  #closed = false;

  constructor(
    report: (progress: ToolProgress) => void,
    options: { heartbeatMs?: number } = {},
  ) {
    this.#report = report;
    const heartbeatMs = options.heartbeatMs ?? SHELL_PROGRESS_HEARTBEAT_MS;
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 2_147_483_647) {
      throw new RangeError("Shell progress heartbeat must be a positive integer");
    }
    this.#heartbeat = setInterval(() => this.#notify(this.#lastStream, ""), heartbeatMs);
    this.#heartbeat.unref();
  }

  push(stream: "stdout" | "stderr", chunk: Uint8Array): void {
    if (this.#closed) return;
    this.#lastStream = stream;
    if (stream === "stdout") this.#stdoutBytes += chunk.byteLength;
    else this.#stderrBytes += chunk.byteLength;
    const delta = this.#decoders[stream].decode(chunk, { stream: true });
    if (delta !== "") {
      this.#pending[stream] += delta;
      this.#pendingBytes += Buffer.byteLength(delta, "utf8");
    }
    if (this.#pendingBytes >= SHELL_PROGRESS_FLUSH_BYTES) this.flush();
    else if (this.#pendingBytes > 0 && this.#timer === undefined) {
      this.#timer = setTimeout(() => this.flush(), SHELL_PROGRESS_FLUSH_MS);
      this.#timer.unref();
    }
  }

  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const stdout = this.#pending.stdout;
    const stderr = this.#pending.stderr;
    this.#pending.stdout = "";
    this.#pending.stderr = "";
    this.#pendingBytes = 0;
    if (stdout !== "") this.#notify("stdout", stdout);
    if (stderr !== "") this.#notify("stderr", stderr);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const stdout = this.#decoders.stdout.decode();
    const stderr = this.#decoders.stderr.decode();
    if (stdout !== "") this.#pending.stdout += stdout;
    if (stderr !== "") this.#pending.stderr += stderr;
    this.flush();
  }

  #notify(stream: "stdout" | "stderr", delta: string): void {
    try {
      this.#report({
        type: "output",
        stream,
      delta,
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      elapsedMs: Math.max(0, Date.now() - this.#startedAt),
    });
    } catch {
      // Progress is best effort. Final output and artifact capture remain authoritative.
    }
  }
}
