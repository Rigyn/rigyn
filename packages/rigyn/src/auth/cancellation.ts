function brandedError(value: unknown): Error | undefined {
  const isError = (Error as ErrorConstructor & {
    isError?: (candidate: unknown) => candidate is Error;
  }).isError;
  return isError?.(value) === true ? value : undefined;
}

export function authAbortError(signal: AbortSignal, fallback: string): Error {
  return brandedError(signal.reason) ?? new DOMException(fallback, "AbortError");
}

export function authFailureError(value: unknown, fallback: string): Error {
  return brandedError(value) ?? new Error(fallback);
}
