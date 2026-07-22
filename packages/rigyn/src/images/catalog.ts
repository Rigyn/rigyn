import { OPENROUTER_IMAGE_MODELS } from "./models.generated.js";
import type { ImagesApi, ImagesModel, ImagesProviderId } from "./types.js";

const catalog = new Map<ImagesProviderId, ReadonlyMap<string, ImagesModel<ImagesApi>>>([
  ["openrouter", new Map(OPENROUTER_IMAGE_MODELS.map((model) => [model.id, model]))],
]);

export function getImageProviders(): ImagesProviderId[] {
  return [...catalog.keys()];
}

export function getImageModels(provider: ImagesProviderId): ImagesModel<ImagesApi>[] {
  return [...(catalog.get(provider)?.values() ?? [])];
}

export function getImageModel(provider: ImagesProviderId, modelId: string): ImagesModel<ImagesApi> | undefined {
  return catalog.get(provider)?.get(modelId);
}
