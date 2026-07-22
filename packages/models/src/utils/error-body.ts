export const MAX_PROVIDER_ERROR_BODY_CHARS = 4_000;

export interface NormalizedProviderError {
  status?: number;
  body?: string;
  message: string;
  messageCarriesBody: boolean;
}

type ProviderErrorShape = Error & {
  statusCode?: unknown;
  status?: unknown;
  body?: unknown;
  error?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  $response?: { statusCode?: unknown; body?: unknown };
};

export function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncateErrorText(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum)}... [truncated ${text.length - maximum} chars]`;
}

function status(error: ProviderErrorShape): number | undefined {
  if (typeof error.statusCode === "number") return error.statusCode;
  if (typeof error.status === "number") return error.status;
  if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
  return typeof error.$response?.statusCode === "number" ? error.$response.statusCode : undefined;
}

function nonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function body(error: ProviderErrorShape): string | undefined {
  let text: string | undefined;
  if (typeof error.body === "string") text = error.body;
  else if (nonEmptyObject(error.error)) text = safeJsonStringify(error.error);
  else if (typeof error.$response?.body === "string") text = error.$response.body;
  else if (nonEmptyObject(error.$response?.body)) text = safeJsonStringify(error.$response.body);
  const trimmed = text?.trim();
  return trimmed ? truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS) : undefined;
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
  if (!(error instanceof Error)) return { message: safeJsonStringify(error), messageCarriesBody: false };
  const shaped = error as ProviderErrorShape;
  const errorStatus = status(shaped);
  const errorBody = body(shaped);
  return {
    ...(errorStatus === undefined ? {} : { status: errorStatus }),
    ...(errorBody === undefined ? {} : { body: errorBody }),
    message: error.message,
    messageCarriesBody: errorBody === undefined || error.message.includes(errorBody),
  };
}

export function formatProviderError(error: NormalizedProviderError, prefix?: string): string {
  if (error.messageCarriesBody || error.status === undefined || error.body === undefined) {
    return prefix !== undefined && error.status !== undefined ? `${prefix} (${error.status}): ${error.message}` : error.message;
  }
  return prefix === undefined ? `${error.status}: ${error.body}` : `${prefix} (${error.status}): ${error.body}`;
}
