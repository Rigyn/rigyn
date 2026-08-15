import type {
  GeneratedImage,
  ImageModel,
  ImageProvider,
  ImageRequest,
  ImageResult,
} from "./contracts.js";
import { fetchJson } from "./http-engine.js";

const providers = new Map<string, ImageProvider>();

export function registerImageProvider(provider: ImageProvider): void {
  if (!provider.id.trim()) throw new TypeError("Image provider id must not be empty");
  providers.set(provider.id, provider);
}

export function unregisterImageProvider(providerId: string): boolean {
  return providers.delete(providerId);
}

export function getImageProvider(providerId: string): ImageProvider | undefined {
  return providers.get(providerId);
}

export function getImageProviders(): readonly ImageProvider[] {
  return [...providers.values()];
}

export function getImageModels(providerId?: string): readonly ImageModel[] {
  if (providerId) return providers.get(providerId)?.models ?? [];
  return [...providers.values()].flatMap((provider) => provider.models);
}

export async function generateImage(model: ImageModel, request: ImageRequest): Promise<ImageResult> {
  const provider = providers.get(model.provider);
  if (!provider) throw new Error(`Unknown image provider: ${model.provider}`);
  return provider.generate(model, request);
}

export const openrouterImageModels: readonly ImageModel[] = Object.freeze([
  {
    id: "google/gemini-2.5-flash-image",
    name: "Gemini 2.5 Flash Image",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
]);

export interface OpenRouterImageProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: readonly ImageModel[];
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export function openrouterImagesProvider(options: OpenRouterImageProviderOptions = {}): ImageProvider {
  const models = (options.models ?? openrouterImageModels).map((model) => ({
    ...model,
    provider: "openrouter",
    baseUrl: options.baseUrl ?? model.baseUrl,
  }));
  return {
    id: "openrouter",
    name: "OpenRouter",
    models,
    async generate(model, request) {
      const key = options.apiKey ?? globalThis.process?.env.OPENROUTER_API_KEY;
      if (!key) throw new Error("OpenRouter image generation requires an API key");
      if (!request.prompt.trim()) throw new TypeError("Image prompt must not be empty");
      const count = request.count ?? 1;
      if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw new RangeError("Image count must be between 1 and 10");
      const body = {
        model: model.id,
        messages: [{ role: "user", content: request.prompt }],
        modalities: ["image", "text"],
        ...(request.size ? { image_config: { aspect_ratio: aspectRatio(request.size) } } : {}),
      };
      const value = await fetchJson<unknown>({
        url: `${model.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
        body,
        ...(options.headers === undefined ? {} : { defaultHeaders: options.headers }),
        authorization: { value: key },
        options: {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
      });
      const images = parseOpenRouterImages(value).slice(0, count);
      if (images.length === 0) throw new Error("OpenRouter response did not contain an image");
      return { images, model: model.id, provider: "openrouter" };
    },
  };
}

function aspectRatio(size: string): string {
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (!match) return size;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new TypeError("Invalid image size");
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(left: number, right: number): number {
  while (right) [left, right] = [right, left % right];
  return left;
}

function parseOpenRouterImages(value: unknown): GeneratedImage[] {
  if (typeof value !== "object" || value === null) return [];
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  const output: GeneratedImage[] = [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const message = (choice as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) continue;
    const images = (message as { images?: unknown }).images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (typeof image !== "object" || image === null) continue;
      const url = (image as { image_url?: unknown }).image_url;
      const stringUrl = typeof url === "string" ? url : typeof url === "object" && url !== null ? (url as { url?: unknown }).url : undefined;
      if (typeof stringUrl !== "string") continue;
      const data = /^data:([^;]+);base64,(.*)$/su.exec(stringUrl);
      output.push(data ? { mimeType: data[1]!, data: data[2]! } : { url: stringUrl });
    }
  }
  return output;
}

export function registerBuiltinImageProviders(options: OpenRouterImageProviderOptions = {}): void {
  registerImageProvider(openrouterImagesProvider(options));
}
