import { getImagesApiProvider } from "./images-api-registry.js";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ProviderImagesOptions } from "./types.js";

export async function generateImages<TApi extends ImagesApi>(model: ImagesModel<TApi>, context: ImagesContext, options?: ProviderImagesOptions): Promise<AssistantImages> {
  const provider = getImagesApiProvider(model.api);
  if (provider === undefined) return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: `No image API implementation is registered for ${model.api}`, timestamp: Date.now() };
  try { return await provider.generateImages(model, context, options); }
  catch (error) { return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() }; }
}
