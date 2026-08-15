import type { UsageCost } from "../core/types.js";
import type { FetchLike } from "../providers/transport.js";

export type ImagesApi = string;
export type ImagesProviderId = string;
export type ImagesModality = "text" | "image";
export type ImagesStopReason = "stop" | "error" | "aborted";

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
  input: ImagesModality[];
  output: ImagesModality[];
  headers?: Readonly<Record<string, string>>;
  pricing?: ImagesModelPricing;
}

export interface ImagesTextContent { type: "text"; text: string }
export interface ImagesImageContent { type: "image"; mimeType: string; data: string }
export type ImagesInputContent = ImagesTextContent | ImagesImageContent;
export type ImagesOutputContent = ImagesTextContent | ImagesImageContent;

export interface ImagesContext { input: ImagesInputContent[] }

export interface ImagesUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: UsageCost;
}

export interface AssistantImages {
  api: ImagesApi;
  provider: ImagesProviderId;
  model: string;
  output: ImagesOutputContent[];
  stopReason: ImagesStopReason;
  timestamp: number;
  responseId?: string;
  usage?: ImagesUsage;
  errorMessage?: string;
}

export type ImagesHeaders = Record<string, string | null>;
export interface ImagesProviderResponse { status: number; headers: Record<string, string> }

export interface ImagesOptions {
  apiKey?: string;
  headers?: ImagesHeaders;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
  onPayload?: (payload: unknown, model: ImagesModel) => unknown | Promise<unknown>;
  onResponse?: (response: ImagesProviderResponse, model: ImagesModel) => void | Promise<void>;
}

export type ProviderImagesOptions = ImagesOptions;
export type ImagesFunction<TApi extends ImagesApi = ImagesApi> = (
  model: ImagesModel<TApi>,
  context: ImagesContext,
  options?: ImagesOptions,
) => Promise<AssistantImages>;

export interface ProviderImages<TApi extends ImagesApi = ImagesApi> {
  generateImages(
    model: ImagesModel<TApi>,
    context: ImagesContext,
    options?: ImagesOptions,
  ): Promise<AssistantImages>;
}

export interface ImagesApiProvider<TApi extends ImagesApi = ImagesApi> extends ProviderImages<TApi> { api: TApi }
