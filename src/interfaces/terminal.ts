import { createInterface, type Interface } from "node:readline";
import type { EventEnvelope } from "../core/events.js";
import { escapeTerminal } from "../tools/output.js";
import { writeMachineOutput } from "./output-guard.js";

interface PendingQuestion {
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

export interface TerminalChoice<T> {
  label: string;
  detail?: string;
  value: T;
}

export interface TerminalPrompter {
  question(prompt: string, signal?: AbortSignal): Promise<string>;
  choose<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T>;
  readSecret?(prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface InteractiveTerminal extends TerminalPrompter {
  setSteering(handler: ((line: string) => void) | undefined): void;
  close(): void;
}

export class TerminalController implements InteractiveTerminal {
  #interface: Interface | undefined;
  readonly #input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): void };
  readonly #output: NodeJS.WritableStream;
  #pending: PendingQuestion | undefined;
  #steering: ((line: string) => void) | undefined;
  #secretAbort: AbortController | undefined;
  #closed = false;

  constructor(
    input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): void } = process.stdin,
    output: NodeJS.WritableStream = process.stderr,
  ) {
    this.#input = input;
    this.#output = output;
    this.#interface = this.#createInterface();
  }

  #createInterface(): Interface {
    const readline = createInterface({ input: this.#input, output: this.#output, terminal: this.#input.isTTY === true });
    readline.on("line", (line) => {
      const pending = this.#pending;
      if (pending !== undefined) {
        this.#pending = undefined;
        pending.cleanup();
        pending.resolve(line);
      } else {
        this.#steering?.(line);
      }
    });
    readline.on("close", () => {
      if (this.#interface !== readline) return;
      this.#interface = undefined;
      this.#closed = true;
      this.#pending?.cleanup();
      this.#pending?.reject(new Error("Terminal input closed"));
      this.#pending = undefined;
    });
    return readline;
  }

  question(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("Terminal input is closed"));
    if (this.#pending !== undefined || this.#secretAbort !== undefined) {
      return Promise.reject(new Error("Another terminal question is active"));
    }
    this.#output.write(prompt);
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.#pending?.resolve !== resolve) return;
        this.#pending = undefined;
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Terminal question cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) };
    });
  }

  setSteering(handler: ((line: string) => void) | undefined): void {
    this.#steering = handler;
  }

  async readSecret(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.#closed) throw new Error("Terminal input is closed");
    if (this.#pending !== undefined || this.#secretAbort !== undefined) {
      throw new Error("Another terminal question is active");
    }
    const readline = this.#interface;
    this.#interface = undefined;
    readline?.close();
    const cancellation = new AbortController();
    this.#secretAbort = cancellation;
    const combinedSignal = signal === undefined
      ? cancellation.signal
      : AbortSignal.any([signal, cancellation.signal]);
    try {
      return await readSecretFrom(this.#input, this.#output, prompt, combinedSignal);
    } finally {
      if (this.#secretAbort === cancellation) this.#secretAbort = undefined;
      if (!this.#closed) this.#interface = this.#createInterface();
    }
  }

  async choose<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T> {
    if (choices.length === 0) throw new Error("No choices are available");
    let query = "";
    while (true) {
      signal?.throwIfAborted();
      const normalized = query.toLowerCase();
      const filtered = normalized === ""
        ? choices
        : choices.filter((choice) => `${choice.label} ${choice.detail ?? ""}`.toLowerCase().includes(normalized));
      this.#output.write(`\n${escapeTerminal(prompt)}\n`);
      if (filtered.length === 0) this.#output.write("  No matches.\n");
      for (const [index, choice] of filtered.slice(0, 20).entries()) {
        const detail = choice.detail === undefined ? "" : ` — ${escapeTerminal(choice.detail)}`;
        this.#output.write(`  ${index + 1}. ${escapeTerminal(choice.label)}${detail}\n`);
      }
      if (filtered.length > 20) this.#output.write(`  … ${filtered.length - 20} more; type a narrower search.\n`);
      const answer = (await this.question("Select a number, type to search, or /cancel: ", signal)).trim();
      if (answer === "/cancel") throw new Error("Selection cancelled");
      if (answer === "" && filtered.length === 1) return filtered[0]!.value;
      if (/^\d+$/u.test(answer)) {
        const selected = filtered[Number(answer) - 1];
        if (selected !== undefined && Number(answer) <= 20) return selected.value;
        this.#output.write("Selection is outside the displayed range.\n");
        continue;
      }
      const exact = filtered.find((choice) => choice.label === answer);
      if (exact !== undefined) return exact.value;
      query = answer;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#secretAbort?.abort(new Error("Terminal input closed"));
    const readline = this.#interface;
    this.#interface = undefined;
    readline?.close();
    this.#pending?.cleanup();
    this.#pending?.reject(new Error("Terminal input closed"));
    this.#pending = undefined;
  }
}

export type OutputMode = "interactive" | "json" | "quiet";

export class EventRenderer {
  readonly #mode: OutputMode;
  #wroteText = false;

  constructor(mode: OutputMode) {
    this.#mode = mode;
  }

  render(envelope: EventEnvelope): void {
    if (this.#mode === "json") {
      writeMachineOutput(`${JSON.stringify(envelope)}\n`);
      return;
    }
    if (this.#mode === "quiet") return;
    const event = envelope.event;
    if (event.type === "text_delta") {
      process.stdout.write(escapeTerminal(event.text));
      this.#wroteText = true;
    } else if (event.type === "tool_started") {
      process.stderr.write(`\n→ ${event.name}\n`);
    } else if (event.type === "tool_completed") {
      process.stderr.write(`${event.isError ? "✗" : "✓"} ${event.name}\n`);
    } else if (event.type === "tool_in_doubt") {
      process.stderr.write(`! ${event.name}: outcome unknown after interruption\n`);
    } else if (event.type === "retry_scheduled") {
      process.stderr.write(`Retrying ${event.category} in ${event.delayMs} ms (attempt ${event.attempt})\n`);
    } else if (event.type === "compaction_started") {
      process.stderr.write("Compacting older session context…\n");
    } else if (event.type === "extension_message" && event.transcript !== false) {
      process.stderr.write(`[${event.extensionId}/${event.kind}] ${escapeTerminal(event.transcript.text)}\n`);
    } else if (event.type === "warning") {
      process.stderr.write(`Warning: ${escapeTerminal(event.message)}\n`);
    } else if (["run_completed", "run_failed", "run_cancelled"].includes(event.type) && this.#wroteText) {
      process.stdout.write("\n");
      this.#wroteText = false;
    }
  }
}

export async function readSecretFrom(
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): void },
  output: NodeJS.WritableStream,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const maxSecretBytes = 64 * 1024;
  if (!input.isTTY) {
    signal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = (): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        cleanup();
        input.pause();
        reject(error);
      };
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxSecretBytes + 2) {
          fail(new Error("Secret input exceeds 65536 bytes"));
          return;
        }
        chunks.push(Buffer.from(buffer));
      };
      const onEnd = (): void => {
        cleanup();
        const buffer = Buffer.concat(chunks);
        const decoded = buffer.toString("utf8");
        if (!Buffer.from(decoded, "utf8").equals(buffer)) {
          reject(new Error("Secret input is not valid UTF-8"));
          return;
        }
        const value = decoded.replace(/\r?\n$/u, "");
        if (Buffer.byteLength(value, "utf8") > maxSecretBytes) {
          reject(new Error("Secret input exceeds 65536 bytes"));
          return;
        }
        resolve(value);
      };
      const onError = (error: Error): void => fail(error);
      const onAbort = (): void => fail(
        signal?.reason instanceof Error ? signal.reason : new Error("Secret input cancelled"),
      );
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      input.resume();
    });
  }
  if (input.setRawMode === undefined) throw new Error("Terminal does not support hidden input");
  signal?.throwIfAborted();
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    const value: number[] = [];
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode?.(false);
      output.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Secret input cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          const buffer = Buffer.from(value);
          const decoded = buffer.toString("utf8");
          if (!Buffer.from(decoded, "utf8").equals(buffer)) {
            reject(new Error("Secret input is not valid UTF-8"));
            return;
          }
          resolve(decoded);
          return;
        }
        if (byte === 127 || byte === 8) {
          if (value.length === 0) continue;
          let start = value.length - 1;
          while (start > 0 && ((value[start] ?? 0) & 0xc0) === 0x80) start -= 1;
          value.length = start;
        }
        else {
          if (value.length >= maxSecretBytes) {
            cleanup();
            reject(new Error("Secret input exceeds 65536 bytes"));
            return;
          }
          value.push(byte);
        }
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("Terminal input closed"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Secret input cancelled"));
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readSecret(prompt: string, signal?: AbortSignal): Promise<string> {
  return readSecretFrom(process.stdin, process.stderr, prompt, signal);
}
