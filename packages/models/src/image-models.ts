import { IMAGE_MODELS } from "./image-models.generated.js";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.js";

type ProviderModels<TProvider extends KnownImagesProvider> = (typeof IMAGE_MODELS)[TProvider];
type ImageApi<TProvider extends KnownImagesProvider, TId extends keyof ProviderModels<TProvider>> =
  ProviderModels<TProvider>[TId] extends { api: infer TApi extends ImagesApi } ? TApi : never;

export function getImageModel<TProvider extends KnownImagesProvider, TId extends keyof ProviderModels<TProvider>>(
  provider: TProvider,
  modelId: TId,
): ImagesModel<ImageApi<TProvider, TId>> {
  return IMAGE_MODELS[provider][modelId] as ImagesModel<ImageApi<TProvider, TId>>;
}

export function getImageProviders(): KnownImagesProvider[] {
  return Object.keys(IMAGE_MODELS) as KnownImagesProvider[];
}

export function getImageModels<TProvider extends KnownImagesProvider>(provider: TProvider): ImagesModel<ImagesApi>[] {
  return Object.values(IMAGE_MODELS[provider]) as ImagesModel<ImagesApi>[];
}
