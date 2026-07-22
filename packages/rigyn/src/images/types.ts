import type { AuthCredential } from "../auth/types.js";
import type { NormalizedUsage } from "../core/types.js";
import type { ProviderAuthResult } from "../providers/models.js";
import type { FetchLike } from "../providers/transport.js";

export type ImagesApi = "openrouter-images" | (string & {});
export type ImagesProviderId = "openrouter" | (string & {});

export interface ImagesTextContent {
  type: "text";
  text: string;
}

/** Image-generation inputs and outputs use validated, in-memory base64 data. */
export interface ImagesImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ImagesInputContent = ImagesTextContent | ImagesImageContent;
export type ImagesOutputContent = ImagesTextContent | ImagesImageContent;

export interface ImagesContext {
  input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface ImagesUsage extends NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AssistantImages {
  api: ImagesApi;
  provider: ImagesProviderId;
  model: string;
  output: ImagesOutputContent[];
  responseId?: string;
  usage?: ImagesUsage;
  stopReason: ImagesStopReason;
  errorMessage?: string;
  timestamp: number;
}

/** Per-million-token rates. Omit pricing when a provider does not publish reliable rates. */
export interface ImagesModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ImagesModel<TApi extends ImagesApi = ImagesApi> {
  id: string;
  name: string;
  api: TApi;
  provider: ImagesProviderId;
  baseUrl: string;
  input: Array<"text" | "image">;
  output: Array<"text" | "image">;
  pricing?: ImagesModelPricing;
  headers?: Record<string, string>;
}

export type ImagesHeaders = Record<string, string | null>;
export type ImagesEnvironment = Record<string, string>;

export interface ImagesProviderResponse {
  status: number;
  headers: Record<string, string>;
}

export interface ImagesOptions {
  signal?: AbortSignal;
  apiKey?: string;
  env?: ImagesEnvironment;
  onPayload?: (
    payload: unknown,
    model: ImagesModel<ImagesApi>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (
    response: ImagesProviderResponse,
    model: ImagesModel<ImagesApi>,
  ) => void | Promise<void>;
  headers?: ImagesHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  /** Maximum decoded response body accepted by the SDK transport. */
  maxResponseBytes?: number;
  metadata?: Record<string, unknown>;
  /** Host-provided transport; primarily useful for proxy-aware runtimes and deterministic tests. */
  fetch?: FetchLike;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

export type ImagesFunction<
  TApi extends ImagesApi = ImagesApi,
  TOptions extends ImagesOptions = ImagesOptions,
> = (
  model: ImagesModel<TApi>,
  context: ImagesContext,
  options?: TOptions,
) => Promise<AssistantImages>;

export interface ProviderImages {
  generateImages(
    model: ImagesModel<ImagesApi>,
    context: ImagesContext,
    options?: ImagesOptions,
  ): Promise<AssistantImages>;
}

export interface ImagesAuthResult extends ProviderAuthResult {
  /** Compatibility metadata for broker-backed image providers. */
  provider?: string;
  credentialKind?: AuthCredential["kind"];
  /** Compatibility alias for auth.apiKey. */
  apiKey?: string;
}
