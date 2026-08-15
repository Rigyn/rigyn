import assert from "node:assert/strict";
import test from "node:test";

import {
  generateImages,
  getImageModel,
  getImagesApiProvider,
  registerImagesApiProvider,
  unregisterImagesApiProvider,
  type ImagesContext,
  type ImagesModel,
} from "../../src/images/index.js";

const context: ImagesContext = { input: [{ type: "text", text: "draw" }] };

function model(api: string): ImagesModel {
  return {
    id: "test-model",
    name: "Test Model",
    api,
    provider: "test-provider",
    baseUrl: "https://images.example.test/v1",
    input: ["text"],
    output: ["image"],
  };
}

test("the image API registry dispatches matching models and rejects mismatched direct calls", async () => {
  const calls: string[] = [];
  registerImagesApiProvider({
    api: "semantic-test-images",
    generateImages: async (selected) => {
      calls.push(selected.id);
      return {
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        output: [],
        stopReason: "stop",
        timestamp: 1,
      };
    },
  });
  try {
    const selected = model("semantic-test-images");
    const output = await generateImages(selected, context);
    assert.equal(output.stopReason, "stop");
    assert.deepEqual(calls, ["test-model"]);

    const registered = getImagesApiProvider("semantic-test-images")!;
    await assert.rejects(
      registered.generateImages(model("another-api"), context),
      /Image API mismatch/u,
    );
  } finally {
    unregisterImagesApiProvider("semantic-test-images");
  }
});

test("one-shot generation returns registry and provider failures", async () => {
  const unavailable = await generateImages(model("not-registered"), context);
  assert.equal(unavailable.stopReason, "error");
  assert.match(unavailable.errorMessage ?? "", /No image API provider/u);

  registerImagesApiProvider({
    api: "throwing-images",
    generateImages: async () => { throw new Error("adapter exploded"); },
  });
  try {
    const failed = await generateImages(model("throwing-images"), context);
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage ?? "", /adapter exploded/u);
  } finally {
    unregisterImagesApiProvider("throwing-images");
  }
});

test("a cleared built-in image API is restored lazily without loading its SDK", async () => {
  unregisterImagesApiProvider("openrouter-images");
  assert.equal(getImagesApiProvider("openrouter-images"), undefined);
  const selected = getImageModel("openrouter", "google/gemini-2.5-flash-image")!;
  const output = await generateImages(selected, context);
  assert.equal(output.stopReason, "error");
  assert.match(output.errorMessage ?? "", /No API key/u);
  assert.equal(typeof getImagesApiProvider("openrouter-images")?.generateImages, "function");
});
