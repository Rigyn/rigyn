export class HarnessError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, options?: { cause?: unknown; exitCode?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.code = code;
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function errorMessage(error: unknown): string {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(error) === true) {
    const message = Object.getOwnPropertyDescriptor(error, "message");
    return message !== undefined && "value" in message && typeof message.value === "string"
      ? message.value
      : "[Thrown Error]";
  }
  if (typeof error === "string") return error;
  if (error === null) return "null";
  if (typeof error === "function") return "[Thrown function]";
  if (typeof error === "object") return "[Thrown object]";
  return String(error);
}
