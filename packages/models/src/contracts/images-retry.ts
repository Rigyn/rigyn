export interface RetryPolicy {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

export interface RetryCallbacks {
  onRetryScheduled?(
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    errorMessage: string,
  ): void | Promise<void>;
  onRetryAttemptStart?(attempt: number): void | Promise<void>;
  onRetryFinished?(success: boolean, attempt: number): void | Promise<void>;
}

export interface ImageModel {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  sizes?: readonly string[];
  qualities?: readonly string[];
  formats?: readonly string[];
}

export interface ImageRequest {
  prompt: string;
  count?: number;
  size?: string;
  quality?: string;
  format?: string;
  background?: "transparent" | "opaque" | "auto";
  signal?: AbortSignal;
}

export interface GeneratedImage {
  data?: string;
  url?: string;
  mimeType?: string;
  revisedPrompt?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface ImageProvider {
  id: string;
  name: string;
  models: readonly ImageModel[];
  generate(model: ImageModel, request: ImageRequest): Promise<ImageResult>;
}
