import type { ImagesFunction } from "../types.js";
import type { ImagesOptions } from "../types.js";
export const generateImages: ImagesFunction<"openrouter-images", ImagesOptions> = async (model, context, options) => (await import("./openrouter-images.js")).generateImages(model, context, options);
