import { generateImages } from "../api/openrouter-images.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { BUILTIN_IMAGE_MODEL_CATALOG } from "../image-models.generated.js";
import { createImagesProvider, type ImagesProvider } from "../images-models.js";

export function openrouterImagesProvider(): ImagesProvider {
  return createImagesProvider({
    id: "openrouter",
    name: "OpenRouter",
    auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
    models: BUILTIN_IMAGE_MODEL_CATALOG,
    api: { generateImages },
  });
}
