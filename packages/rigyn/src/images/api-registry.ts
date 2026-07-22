import type {
  AssistantImages,
  ImagesApi,
  ImagesContext,
  ImagesFunction,
  ImagesModel,
  ImagesOptions,
} from "./types.js";

export interface ImagesApiProvider<
  TApi extends ImagesApi = ImagesApi,
  TOptions extends ImagesOptions = ImagesOptions,
> {
  api: TApi;
  generateImages: ImagesFunction<TApi, TOptions>;
}

type RegisteredImagesApiProvider = ImagesApiProvider<ImagesApi, ImagesOptions>;

const providers = new Map<string, RegisteredImagesApiProvider>();

export function registerImagesApiProvider<
  TApi extends ImagesApi,
  TOptions extends ImagesOptions = ImagesOptions,
>(provider: ImagesApiProvider<TApi, TOptions>): void {
  providers.set(provider.api, {
    api: provider.api,
    generateImages: async (
      model: ImagesModel<ImagesApi>,
      context: ImagesContext,
      options?: ImagesOptions,
    ): Promise<AssistantImages> => {
      if (model.api !== provider.api) {
        throw new Error(`Image API mismatch: received ${model.api}; expected ${provider.api}`);
      }
      return provider.generateImages(model as ImagesModel<TApi>, context, options as TOptions);
    },
  });
}

export function getImagesApiProvider(api: ImagesApi): RegisteredImagesApiProvider | undefined {
  return providers.get(api);
}

export function unregisterImagesApiProvider(api: ImagesApi): boolean {
  return providers.delete(api);
}

/** Primarily useful for isolated hosts and tests that own their complete registry. */
export function clearImagesApiProviders(): void {
  providers.clear();
}
