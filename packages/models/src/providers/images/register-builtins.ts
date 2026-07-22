import { generateImages } from "../../api/openrouter-images.lazy.js";
import { registerImagesApiProvider } from "../../images-api-registry.js";

export function registerBuiltInImagesApiProviders(): void {
  registerImagesApiProvider({ api: "openrouter-images", generateImages });
}

registerBuiltInImagesApiProviders();
