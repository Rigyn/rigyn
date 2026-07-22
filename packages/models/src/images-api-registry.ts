import type { AssistantImages, ImagesApi, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "./types.js";

export type ImagesApiFunction = (model: ImagesModel<ImagesApi>, context: ImagesContext, options?: ImagesOptions) => Promise<AssistantImages>;
export interface ImagesApiProvider<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> { api: TApi; generateImages: ImagesFunction<TApi, TOptions>; }
interface InternalImagesApiProvider { api: ImagesApi; generateImages: ImagesApiFunction; }
const registry = new Map<string, { provider: InternalImagesApiProvider; sourceId?: string }>();

export function registerImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(provider: ImagesApiProvider<TApi, TOptions>, sourceId?: string): void {
  registry.set(provider.api, { provider: { api: provider.api, generateImages(model, context, options) {
    if (model.api !== provider.api) throw new Error(`Mismatched image API: ${model.api}; expected ${provider.api}`);
    return provider.generateImages(model as ImagesModel<TApi>, context, options as TOptions);
  } }, ...(sourceId === undefined ? {} : { sourceId }) });
}
export function getImagesApiProvider(api: ImagesApi): InternalImagesApiProvider | undefined { return registry.get(api)?.provider; }
export function getImagesApiProviders(): readonly InternalImagesApiProvider[] { return [...registry.values()].map((entry) => entry.provider); }
export function unregisterImagesApiProviders(sourceId: string): void { for (const [api, entry] of registry) if (entry.sourceId === sourceId) registry.delete(api); }
export function resetImagesApiProviders(): void { registry.clear(); }
