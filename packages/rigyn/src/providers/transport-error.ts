function isNativeError(value: unknown): value is Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(value) === true;
}

function ownErrorValue(error: Error, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

export function safeTransportCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : undefined;
}

/** Returns only a bounded machine code from a native Error cause chain. */
export function transportErrorCode(error: unknown): string | undefined {
  const seen = new Set<Error>();
  let selected = error;
  for (let depth = 0; depth < 5 && isNativeError(selected) && !seen.has(selected); depth += 1) {
    seen.add(selected);
    const code = safeTransportCode(ownErrorValue(selected, "code"))
      ?? safeTransportCode(ownErrorValue(selected, "transportCode"));
    if (code !== undefined) return code;
    selected = ownErrorValue(selected, "cause");
  }
  return undefined;
}
