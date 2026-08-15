import type { ImagesApi, ImagesApiProvider } from "./types.js";

const providers = new Map<ImagesApi, ImagesApiProvider>();

export function registerImagesApiProvider<TApi extends ImagesApi>(provider: ImagesApiProvider<TApi>): void {
  if (provider.api.trim() === "") throw new TypeError("Image API name must not be empty");
  providers.set(provider.api, {
    api: provider.api,
    async generateImages(model, context, options) {
      if (model.api !== provider.api) {
        throw new Error(`Image API mismatch: expected ${provider.api}, received ${model.api}`);
      }
      return await provider.generateImages(model as never, context, options);
    },
  });
}

export function unregisterImagesApiProvider(api: ImagesApi): void { providers.delete(api); }
export function clearImagesApiProviders(): void { providers.clear(); }
export function getImagesApiProvider(api: ImagesApi): ImagesApiProvider | undefined { return providers.get(api); }
