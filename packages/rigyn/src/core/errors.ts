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
  return error instanceof Error ? error.message : String(error);
}
