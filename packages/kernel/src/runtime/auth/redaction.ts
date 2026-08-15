import { isProxy } from "node:util/types";

const BUILTIN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b((?:https?|wss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  [/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(access_token|refresh_token|id_token)=([^&\s]+)/gi, "$1=[REDACTED]"],
  [/([?&](?:code|client_secret|password|secret|token)=)[^&#\s]+/gi, "$1[REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
];

const SENSITIVE_KEY = /^(?:(?:access|refresh|id)[_-]?token|token|secret|password|passwd|api[_-]?key|authorization)$/iu;
const MAX_STRUCTURED_VALUES = 10_000;
const MAX_STRUCTURED_DEPTH = 64;
const TRUNCATED_VALUE = "[Truncated]";

interface StructuredEntry {
  key: string | number;
  descriptor: PropertyDescriptor;
}

function structuredEntries(value: object, maximumEntries: number): {
  array: boolean;
  entries: StructuredEntry[];
} | undefined {
  try {
    if (isProxy(value)) return undefined;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if ((array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)) return undefined;

    if (array) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximumEntries) {
        return undefined;
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== (length as number) + 1) return undefined;
      const entries = new Array<StructuredEntry>(length as number);
      let elements = 0;
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string") return undefined;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= (length as number) || String(index) !== key) {
          return undefined;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable !== true) return undefined;
        entries[index] = { key: index, descriptor };
        elements += 1;
      }
      return elements === length ? { array: true, entries } : undefined;
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumEntries) return undefined;
    const entries: StructuredEntry[] = [];
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) return undefined;
      entries.push({ key, descriptor });
    }
    return { array: false, entries };
  } catch {
    return undefined;
  }
}

export const MIN_REDACTABLE_SECRET_CHARACTERS = 4;

export function assertRedactableSecret(secret: string, label = "Secret"): void {
  if (secret.length < MIN_REDACTABLE_SECRET_CHARACTERS) {
    throw new TypeError(`${label} must contain at least ${MIN_REDACTABLE_SECRET_CHARACTERS} characters`);
  }
}

export interface SecretRedactorOptions {
  maxSecrets?: number;
  maxSecretBytes?: number;
  maxTotalBytes?: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

export class SecretRedactor {
  readonly #secrets = new Set<string>();
  readonly #maxSecrets: number;
  readonly #maxSecretBytes: number;
  readonly #maxTotalBytes: number;
  #orderedSecrets: readonly string[] | undefined;
  #totalBytes = 0;

  constructor(options: SecretRedactorOptions = {}) {
    this.#maxSecrets = positiveInteger(options.maxSecrets ?? 4096, "maxSecrets");
    this.#maxSecretBytes = positiveInteger(options.maxSecretBytes ?? 64 * 1024, "maxSecretBytes");
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes ?? 4 * 1024 * 1024, "maxTotalBytes");
    if (this.#maxSecretBytes > this.#maxTotalBytes) {
      throw new TypeError("maxSecretBytes must not exceed maxTotalBytes");
    }
  }

  register(secret: string | undefined): void {
    if (secret === undefined || secret.length < MIN_REDACTABLE_SECRET_CHARACTERS || this.#secrets.has(secret)) return;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (bytes > this.#maxSecretBytes) throw new Error("Secret exceeded redactor item capacity");
    if (this.#secrets.size >= this.#maxSecrets || this.#totalBytes + bytes > this.#maxTotalBytes) {
      throw new Error("Secret redactor capacity exceeded");
    }
    this.#secrets.add(secret);
    this.#orderedSecrets = undefined;
    this.#totalBytes += bytes;
  }

  registerAll(secrets: Iterable<string | undefined>): void {
    for (const secret of secrets) this.register(secret);
  }

  redact(text: string): string {
    let result = text;
    const secrets = this.#orderedSecrets ??= [...this.#secrets].sort((left, right) => right.length - left.length);
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    for (const [pattern, replacement] of BUILTIN_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  containsSecretValue(value: unknown): boolean {
    const pending = [value];
    const visited = new WeakSet<object>();
    let remaining = MAX_STRUCTURED_VALUES;
    while (pending.length > 0) {
      if (remaining <= 0) return true;
      remaining -= 1;
      const item = pending.pop();
      if (typeof item === "string") {
        if (this.redact(item) !== item) return true;
        continue;
      }
      if (typeof item === "function") return true;
      if (item === null || typeof item !== "object" || visited.has(item)) continue;
      visited.add(item);
      const selected = structuredEntries(item, remaining);
      if (selected === undefined) return true;
      for (const { key, descriptor } of selected.entries) {
        if (typeof key === "string" && this.redact(key) !== key) return true;
        if (!("value" in descriptor)) return true;
        pending.push(descriptor.value);
      }
    }
    return false;
  }

  redactValue(value: unknown): unknown {
    return this.#redactStructuredValue(value, false);
  }

  /** @internal Redacts values and omits secret-bearing keys inside arbitrary payload maps. */
  redactPayloadValue(value: unknown): unknown {
    return this.#redactStructuredValue(value, true);
  }

  #redactStructuredValue(value: unknown, omitSecretKeys: boolean): unknown {
    const active = new WeakSet<object>();
    let remaining = MAX_STRUCTURED_VALUES;
    const visit = (item: unknown, depth: number): unknown => {
      if (remaining <= 0) return TRUNCATED_VALUE;
      remaining -= 1;
      if (typeof item === "string") return this.redact(item);
      if (typeof item === "function") return TRUNCATED_VALUE;
      if (item === null || typeof item !== "object") return item;
      if (active.has(item)) return "[Circular]";
      if (depth >= MAX_STRUCTURED_DEPTH) return TRUNCATED_VALUE;
      const selected = structuredEntries(item, remaining);
      if (selected === undefined) return TRUNCATED_VALUE;
      active.add(item);
      try {
        if (selected.array) {
          const redacted = new Array<unknown>(selected.entries.length);
          for (const { key, descriptor } of selected.entries) {
            redacted[key as number] = "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[Accessor]";
          }
          return redacted;
        }

        const redacted: Record<string, unknown> = {};
        for (const { key, descriptor } of selected.entries) {
          const selectedKey = key as string;
          if (omitSecretKeys && this.redact(selectedKey) !== selectedKey) continue;
          const next = SENSITIVE_KEY.test(selectedKey)
            ? "[REDACTED]"
            : "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[Accessor]";
          Object.defineProperty(redacted, selectedKey, {
            value: next,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return redacted;
      } finally {
        active.delete(item);
      }
    };
    return visit(value, 0);
  }
}

export const defaultSecretRedactor = new SecretRedactor();
