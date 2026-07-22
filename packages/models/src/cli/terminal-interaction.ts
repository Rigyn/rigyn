import { createInterface, type Interface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";

import type { AuthEvent, AuthInteraction, AuthPrompt } from "../auth/types.js";

const MAX_ANSWER_BYTES = 16 * 1024;
const MAX_SELECT_OPTIONS = 64;
const MAX_SELECT_ATTEMPTS = 3;

function text(value: string, maximum = 4_096): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "").slice(0, maximum);
}

function line(value: string, maximum = 4_096): string {
  return text(value, maximum).replace(/\s+/gu, " ").trim();
}

function webUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Authentication notification used an unsupported URL scheme");
  }
  return text(parsed.href, 8_192);
}

class MuteableOutput extends Writable {
  muted = false;
  readonly #target: Writable;

  constructor(target: Writable) {
    super();
    this.#target = target;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) this.#target.write(chunk, encoding);
    callback();
  }
}

export interface TerminalAuthInteractionOptions {
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  onCancel?(): void;
}

export interface ClosableAuthInteraction extends AuthInteraction {
  close(): void;
}

export class TerminalAuthInteraction implements ClosableAuthInteraction {
  readonly signal?: AbortSignal;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #proxy: MuteableOutput;
  readonly #readline: Interface;
  readonly #onCancel: (() => void) | undefined;
  #closed = false;

  constructor(options: TerminalAuthInteractionOptions) {
    if (options.signal !== undefined) this.signal = options.signal;
    this.#input = options.input;
    this.#output = options.output;
    this.#proxy = new MuteableOutput(options.output);
    this.#readline = createInterface({
      input: options.input,
      output: this.#proxy,
      terminal: Boolean(
        (options.input as Readable & { isTTY?: boolean }).isTTY
        && (options.output as Writable & { isTTY?: boolean }).isTTY,
      ),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    this.#onCancel = options.onCancel;
    if (this.#onCancel) this.#readline.on("SIGINT", this.#onCancel);
  }

  async #question(message: string, secret: boolean, signal?: AbortSignal): Promise<string> {
    if (this.#closed) throw new Error("Authentication prompt is closed");
    signal?.throwIfAborted();
    let answer: string;
    if (secret) {
      this.#output.write(message);
      this.#proxy.muted = true;
      try {
        answer = signal
          ? await this.#readline.question("", { signal })
          : await this.#readline.question("");
      } finally {
        this.#proxy.muted = false;
        this.#output.write("\n");
      }
    } else {
      answer = signal
        ? await this.#readline.question(message, { signal })
        : await this.#readline.question(message);
    }
    if (Buffer.byteLength(answer) > MAX_ANSWER_BYTES) {
      throw new Error("Authentication response exceeded the input limit");
    }
    return answer;
  }

  async prompt(prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal ?? this.signal;
    if (prompt.type !== "select") {
      const placeholder = prompt.placeholder ? ` [${line(prompt.placeholder, 160)}]` : "";
      return this.#question(
        `${line(prompt.message, 1_024)}${placeholder}: `,
        prompt.type === "secret" || prompt.type === "manual_code",
        signal,
      );
    }
    if (prompt.options.length === 0 || prompt.options.length > MAX_SELECT_OPTIONS) {
      throw new Error("Authentication selection has an invalid number of options");
    }
    this.#output.write(`${line(prompt.message, 1_024)}\n`);
    for (const [index, option] of prompt.options.entries()) {
      const description = option.description ? ` — ${line(option.description, 240)}` : "";
      this.#output.write(`  ${index + 1}. ${line(option.label, 240)}${description}\n`);
    }
    for (let attempt = 0; attempt < MAX_SELECT_ATTEMPTS; attempt += 1) {
      const answer = (await this.#question("Selection: ", false, signal)).trim();
      const numeric = Number(answer);
      const selected = Number.isInteger(numeric) && numeric > 0
        ? prompt.options[numeric - 1]
        : prompt.options.find((option) => option.id === answer);
      if (selected) return selected.id;
      if (attempt + 1 < MAX_SELECT_ATTEMPTS) this.#output.write("Choose one of the listed options.\n");
    }
    throw new Error("Authentication selection failed after three attempts");
  }

  notify(event: AuthEvent): void {
    if (event.type === "auth_url") {
      this.#output.write(`Open this address to authenticate:\n${webUrl(event.url)}\n`);
      if (event.instructions) this.#output.write(`${text(event.instructions)}\n`);
      return;
    }
    if (event.type === "device_code") {
      this.#output.write(`Open ${webUrl(event.verificationUri)} and enter code ${line(event.userCode, 256)}.\n`);
      if (event.expiresInSeconds !== undefined && Number.isFinite(event.expiresInSeconds)) {
        this.#output.write(`The code expires in ${Math.min(86_400, Math.max(0, Math.floor(event.expiresInSeconds)))} seconds.\n`);
      }
      return;
    }
    this.#output.write(`${text(event.message)}\n`);
    for (const link of event.links ?? []) {
      this.#output.write(`${link.label ? `${line(link.label, 160)}: ` : ""}${webUrl(link.url)}\n`);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#onCancel) this.#readline.off("SIGINT", this.#onCancel);
    this.#readline.close();
    this.#input.pause();
  }
}

export function createTerminalAuthInteraction(options: TerminalAuthInteractionOptions): ClosableAuthInteraction {
  return new TerminalAuthInteraction(options);
}
