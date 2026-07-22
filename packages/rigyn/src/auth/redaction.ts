const BUILTIN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(access_token|refresh_token|id_token)=([^&\s]+)/gi, "$1=[REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
];

const SENSITIVE_KEY = /^(?:(?:access|refresh|id)[_-]?token|token|secret|password|passwd|api[_-]?key|authorization)$/iu;

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
    if (secret === undefined || secret.length < 4 || this.#secrets.has(secret)) return;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (bytes > this.#maxSecretBytes) throw new Error("Secret exceeded redactor item capacity");
    if (this.#secrets.size >= this.#maxSecrets || this.#totalBytes + bytes > this.#maxTotalBytes) {
      throw new Error("Secret redactor capacity exceeded");
    }
    this.#secrets.add(secret);
    this.#totalBytes += bytes;
  }

  registerAll(secrets: Iterable<string | undefined>): void {
    for (const secret of secrets) this.register(secret);
  }

  redact(text: string): string {
    let result = text;
    const secrets = [...this.#secrets].sort((left, right) => right.length - left.length);
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    for (const [pattern, replacement] of BUILTIN_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  redactValue(value: unknown): unknown {
    const active = new WeakSet<object>();
    let remaining = 10_000;
    const visit = (item: unknown, depth: number): unknown => {
      if (typeof item === "string") return this.redact(item);
      if (item === null || typeof item !== "object") return item;
      if (active.has(item)) return "[Circular]";
      if (depth >= 64 || remaining <= 0) return "[Truncated]";
      active.add(item);
      remaining -= 1;
      try {
        if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));

        const redacted: Record<string, unknown> = {};
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
          if (descriptor.enumerable !== true) continue;
          const next = SENSITIVE_KEY.test(key)
            ? "[REDACTED]"
            : "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[Accessor]";
          Object.defineProperty(redacted, key, {
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
