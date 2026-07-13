import { interactiveCommand } from "../interactive/commands.js";

export type ActiveSubmission =
  | { kind: "cancel" }
  | { kind: "defer"; text: string }
  | { kind: "follow_up"; text: string }
  | { kind: "steer"; text: string };

/** Classifies input submitted while a model response is still active. */
export function classifyActiveSubmission(input: string): ActiveSubmission {
  const command = input.trim();
  if (command.startsWith("/")) {
    const separator = command.search(/\s/u);
    const name = command.slice(1, separator < 0 ? undefined : separator);
    const definition = interactiveCommand(name);
    if (definition?.activePolicy === "cancel" && separator < 0) return { kind: "cancel" };
    if (definition?.activePolicy === "follow_up") {
      return { kind: "follow_up", text: separator < 0 ? "" : command.slice(separator).trimStart() };
    }
    return { kind: "defer", text: input };
  }
  if (command.startsWith("!")) return { kind: "defer", text: input };
  return { kind: "steer", text: input };
}

export const DEFAULT_MAX_DEFERRED_SUBMISSIONS = 32;
export const DEFAULT_MAX_DEFERRED_SUBMISSION_BYTES = 64 * 1024 * 1024;

export interface DeferredInteractiveSubmission<TImage> {
  text: string;
  images: TImage[];
}

export type DeferredEnqueueResult =
  | { accepted: true; size: number; bytes: number }
  | { accepted: false; reason: "items" | "bytes" };

/** Bounded FIFO for commands that must return through the ordinary idle dispatcher. */
export class BoundedDeferredSubmissionQueue<TImage> {
  readonly #measureImage: (image: TImage) => number;
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #items: Array<DeferredInteractiveSubmission<TImage> & { bytes: number; order: number }> = [];
  #bytes = 0;
  #nextOrder = 0;

  constructor(
    measureImage: (image: TImage) => number,
    options: { maxItems?: number; maxBytes?: number } = {},
  ) {
    this.#measureImage = measureImage;
    this.#maxItems = boundedLimit(options.maxItems ?? DEFAULT_MAX_DEFERRED_SUBMISSIONS, "maxItems");
    this.#maxBytes = boundedLimit(options.maxBytes ?? DEFAULT_MAX_DEFERRED_SUBMISSION_BYTES, "maxBytes");
  }

  get size(): number { return this.#items.length; }
  get bytes(): number { return this.#bytes; }

  enqueue(text: string, images: readonly TImage[], order = this.#nextOrder): DeferredEnqueueResult {
    if (!Number.isSafeInteger(order) || order < 0) throw new Error("Deferred submission order must be a non-negative safe integer");
    this.#nextOrder = Math.max(this.#nextOrder, order + 1);
    if (this.#items.length >= this.#maxItems) return { accepted: false, reason: "items" };
    let bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.#maxBytes) return { accepted: false, reason: "bytes" };
    for (const image of images) {
      const measured = this.#measureImage(image);
      if (!Number.isSafeInteger(measured) || measured < 0) throw new Error("Deferred image size must be a non-negative safe integer");
      bytes += measured;
      if (!Number.isSafeInteger(bytes) || bytes > this.#maxBytes) return { accepted: false, reason: "bytes" };
    }
    if (this.#bytes + bytes > this.#maxBytes) return { accepted: false, reason: "bytes" };
    const entry = { text, images: [...images], bytes, order };
    const insertion = this.#items.findIndex((item) => item.order > order);
    if (insertion < 0) this.#items.push(entry);
    else this.#items.splice(insertion, 0, entry);
    this.#bytes += bytes;
    return { accepted: true, size: this.#items.length, bytes: this.#bytes };
  }

  shift(): DeferredInteractiveSubmission<TImage> | undefined {
    const selected = this.#items.shift();
    if (selected === undefined) return undefined;
    this.#bytes -= selected.bytes;
    return { text: selected.text, images: selected.images };
  }
}

function boundedLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}
