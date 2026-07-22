import { getImagesApiProvider } from "./api-registry.js";
import { ensureBuiltInImagesApiProviders } from "./builtins.js";
import { imageErrorResult } from "./models.js";
import type {
  AssistantImages,
  ImagesApi,
  ImagesContext,
  ImagesModel,
  ProviderImagesOptions,
} from "./types.js";

/** One-shot image generation. Provider, transport, and hook failures are returned and never rejected. */
export async function generateImages<TApi extends ImagesApi>(
  model: ImagesModel<TApi>,
  context: ImagesContext,
  options?: ProviderImagesOptions,
): Promise<AssistantImages> {
  try {
    ensureBuiltInImagesApiProviders();
    const provider = getImagesApiProvider(model.api);
    if (provider === undefined) throw new Error(`No image API provider is registered for ${model.api}`);
    return await provider.generateImages(model, context, options);
  } catch (error) {
    return imageErrorResult(model, error, options?.signal);
  }
}
