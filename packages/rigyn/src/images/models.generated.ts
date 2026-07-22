// Generated image-model metadata. Refresh from the provider catalog before releases.
import type { ImagesModel, ImagesModelPricing } from "./types.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const ZERO: ImagesModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface ModelSpec {
  id: string;
  name: string;
  input?: Array<"text" | "image">;
  output?: Array<"text" | "image">;
  pricing?: ImagesModelPricing;
}

function model(spec: ModelSpec): ImagesModel<"openrouter-images"> {
  return {
    id: spec.id,
    name: spec.name,
    api: "openrouter-images",
    provider: "openrouter",
    baseUrl: BASE_URL,
    input: spec.input ?? ["text", "image"],
    output: spec.output ?? ["image"],
    ...(spec.pricing === undefined ? {} : { pricing: { ...spec.pricing } }),
  };
}

export const OPENROUTER_IMAGE_MODELS: readonly ImagesModel<"openrouter-images">[] = [
  model({ id: "black-forest-labs/flux.2-flex", name: "Black Forest Labs: FLUX.2 Flex", pricing: ZERO }),
  model({ id: "black-forest-labs/flux.2-klein-4b", name: "Black Forest Labs: FLUX.2 Klein 4B", pricing: ZERO }),
  model({ id: "black-forest-labs/flux.2-max", name: "Black Forest Labs: FLUX.2 Max", pricing: ZERO }),
  model({ id: "black-forest-labs/flux.2-pro", name: "Black Forest Labs: FLUX.2 Pro", pricing: ZERO }),
  model({
    id: "bytedance-seed/seedream-4.5",
    name: "ByteDance Seed: Seedream 4.5",
    input: ["image", "text"],
    pricing: ZERO,
  }),
  model({
    id: "google/gemini-2.5-flash-image",
    name: "Google: Nano Banana (Gemini 2.5 Flash Image)",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 1 / 12 },
  }),
  model({
    id: "google/gemini-3-pro-image",
    name: "Google: Nano Banana Pro (Gemini 3 Pro Image)",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
  }),
  model({
    id: "google/gemini-3-pro-image-preview",
    name: "Google: Nano Banana Pro (Gemini 3 Pro Image Preview)",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
  }),
  model({
    id: "google/gemini-3.1-flash-image",
    name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "google/gemini-3.1-flash-image-preview",
    name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "google/gemini-3.1-flash-lite-image",
    name: "Google: Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "microsoft/mai-image-2.5",
    name: "Microsoft: MAI-Image-2.5",
    pricing: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
  }),
  model({
    id: "openai/gpt-5-image",
    name: "OpenAI: GPT-5 Image",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 10, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  }),
  model({
    id: "openai/gpt-5-image-mini",
    name: "OpenAI: GPT-5 Image Mini",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 2.5, output: 2, cacheRead: 0.25, cacheWrite: 0 },
  }),
  model({
    id: "openai/gpt-5.4-image-2",
    name: "OpenAI: GPT-5.4 Image 2",
    input: ["image", "text"],
    output: ["image", "text"],
    pricing: { input: 8, output: 15, cacheRead: 2, cacheWrite: 0 },
  }),
  model({
    id: "openai/gpt-image-1",
    name: "OpenAI: GPT Image 1",
    pricing: { input: 10, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  }),
  model({
    id: "openai/gpt-image-1-mini",
    name: "OpenAI: GPT Image 1 Mini",
    pricing: { input: 2.5, output: 2.5, cacheRead: 0.25, cacheWrite: 0 },
  }),
  model({
    id: "openai/gpt-image-2",
    name: "OpenAI: GPT Image 2",
    pricing: { input: 8, output: 8, cacheRead: 2, cacheWrite: 0 },
  }),
  model({
    id: "openrouter/auto",
    name: "Auto Router",
    output: ["text", "image"],
  }),
  model({ id: "recraft/recraft-v3", name: "Recraft: Recraft V3", pricing: ZERO }),
  model({ id: "recraft/recraft-v4", name: "Recraft: Recraft V4", pricing: ZERO }),
  model({ id: "recraft/recraft-v4-pro", name: "Recraft: Recraft V4 Pro", pricing: ZERO }),
  model({ id: "recraft/recraft-v4-pro-vector", name: "Recraft: Recraft V4 Pro Vector", pricing: ZERO }),
  model({ id: "recraft/recraft-v4-vector", name: "Recraft: Recraft V4 Vector", pricing: ZERO }),
  model({ id: "recraft/recraft-v4.1", name: "Recraft: Recraft V4.1", pricing: ZERO }),
  model({ id: "recraft/recraft-v4.1-pro", name: "Recraft: Recraft V4.1 Pro", pricing: ZERO }),
  model({ id: "recraft/recraft-v4.1-pro-vector", name: "Recraft: Recraft V4.1 Pro Vector", pricing: ZERO }),
  model({ id: "recraft/recraft-v4.1-utility", name: "Recraft: Recraft V4.1 Utility", pricing: ZERO }),
  model({ id: "recraft/recraft-v4.1-utility-pro", name: "Recraft: Recraft V4.1 Utility Pro", pricing: ZERO }),
  model({ id: "recraft/recraft-v4.1-vector", name: "Recraft: Recraft V4.1 Vector", pricing: ZERO }),
  model({ id: "sourceful/riverflow-v2-fast", name: "Sourceful: Riverflow V2 Fast", pricing: ZERO }),
  model({ id: "sourceful/riverflow-v2-pro", name: "Sourceful: Riverflow V2 Pro", pricing: ZERO }),
  model({ id: "sourceful/riverflow-v2.5-fast", name: "Sourceful: Riverflow V2.5 Fast", pricing: ZERO }),
  model({ id: "sourceful/riverflow-v2.5-pro", name: "Sourceful: Riverflow V2.5 Pro", pricing: ZERO }),
  model({ id: "x-ai/grok-imagine-image-quality", name: "xAI: Grok Imagine Image Quality", pricing: ZERO }),
];
