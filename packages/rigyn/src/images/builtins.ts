import { getImagesApiProvider, registerImagesApiProvider } from "./api-registry.js";
import { getImageModels } from "./catalog.js";
import {
  createImagesModels,
  createImagesProvider,
  type CreateImagesModelsOptions,
  type ImagesProvider,
  type MutableImagesModels,
} from "./models.js";
import { generateOpenRouterImages } from "./openrouter.js";

export function registerBuiltInImagesApiProviders(): void {
  registerImagesApiProvider({
    api: "openrouter-images",
    generateImages: generateOpenRouterImages,
  });
}

export function ensureBuiltInImagesApiProviders(): void {
  if (getImagesApiProvider("openrouter-images") === undefined) registerBuiltInImagesApiProviders();
}

export function openrouterImagesProvider(): ImagesProvider {
  return createImagesProvider({
    id: "openrouter",
    name: "OpenRouter",
    auth: {
      apiKey: {
        name: "OpenRouter API key",
        async resolve({ ctx, credential }) {
          const apiKey = credential?.key ?? await ctx.env("OPENROUTER_API_KEY");
          return apiKey === undefined
            ? undefined
            : { auth: { apiKey }, source: credential === undefined ? "OPENROUTER_API_KEY" : "stored credential" };
        },
      },
    },
    models: getImageModels("openrouter"),
    api: { generateImages: generateOpenRouterImages },
  });
}

export function builtinImagesProviders(): ImagesProvider[] {
  return [openrouterImagesProvider()];
}

export function builtinImagesModels(options?: CreateImagesModelsOptions): MutableImagesModels {
  const models = createImagesModels(options);
  for (const provider of builtinImagesProviders()) models.setProvider(provider);
  return models;
}

ensureBuiltInImagesApiProviders();
