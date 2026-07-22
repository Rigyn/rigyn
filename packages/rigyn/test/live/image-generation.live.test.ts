import assert from "node:assert/strict";
import test from "node:test";

import { builtinImagesModels } from "../../src/images/index.js";

const ENABLED = process.env.RIGYN_LIVE === "1" || process.env.npm_lifecycle_event === "test:live";

test("OpenRouter image generation live smoke", {
  skip: ENABLED && process.env.OPENROUTER_API_KEY
    ? false
    : "Live tests and OPENROUTER_API_KEY are required",
  timeout: 180_000,
}, async () => {
  const images = builtinImagesModels();
  const model = images.getModel("openrouter", "google/gemini-2.5-flash-image");
  assert.ok(model, "maintained image model is missing");
  const result = await images.generateImages(model, {
    input: [{ type: "text", text: "A single small red circle on a plain white background. No text." }],
  }, {
    timeoutMs: 120_000,
    maxRetries: 1,
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.output.some((entry) => entry.type === "image" && entry.data.length > 0), true);
});
