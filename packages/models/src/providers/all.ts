import { BUILTIN_IMAGE_MODEL_CATALOG } from "../image-models.generated.js";
import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.js";
import { BUILTIN_MODEL_CATALOG } from "../models.generated.js";
import { createModels, type CreateModelsOptions, type MutableModels, type Provider } from "../models.js";
import type { Api, ImagesApi, ImagesModel, Model } from "../types.js";
import { createBuiltinProvider, getBuiltinProviderIds } from "./factory.js";
import { openrouterImagesProvider } from "./openrouter-images.js";

export type BuiltinProvider = (typeof BUILTIN_MODEL_CATALOG)[number]["provider"];

export function getBuiltinModel(provider: string, modelId: string): Model<Api> | undefined {
  return BUILTIN_MODEL_CATALOG.find((model) => model.provider === provider && model.id === modelId);
}
export function getBuiltinProviders(): string[] { return getBuiltinProviderIds(); }
export function getBuiltinModels(provider: string): Model<Api>[] { return BUILTIN_MODEL_CATALOG.filter((model) => model.provider === provider); }
export function builtinProviders(): Provider[] { return getBuiltinProviderIds().map(createBuiltinProvider); }
export function builtinModels(options?: CreateModelsOptions): MutableModels {
  const models = createModels(options);
  for (const provider of builtinProviders()) models.setProvider(provider);
  return models;
}
export function getBuiltinImageModel(provider: string, modelId: string): ImagesModel<ImagesApi> | undefined {
  return BUILTIN_IMAGE_MODEL_CATALOG.find((model) => model.provider === provider && model.id === modelId);
}
export function getBuiltinImageModels(provider: string): ImagesModel<ImagesApi>[] { return BUILTIN_IMAGE_MODEL_CATALOG.filter((model) => model.provider === provider); }
export function builtinImagesProviders(): ImagesProvider[] { return [openrouterImagesProvider()]; }
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
  const models = createImagesModels(options);
  for (const provider of builtinImagesProviders()) models.setProvider(provider);
  return models;
}
