import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenRouterImageModels } from "../scripts/generate-image-models.ts";

const validImageModel = {
  id: "example/image-model",
  name: "Example Image Model",
  architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
};

test("strict image catalog parsing rejects missing and empty model lists", () => {
  for (const payload of [{}, { data: [] }, { data: "invalid" }]) {
    assert.throws(() => parseOpenRouterImageModels(payload, true), /missing or empty image model list/u);
  }
});

test("strict image catalog parsing rejects catalogs without usable image models", () => {
  assert.throws(() => parseOpenRouterImageModels({ data: [{ ...validImageModel, architecture: { output_modalities: ["text"] } }] }, true), /no usable image models/u);
});

test("image catalog parsing validates and sorts usable entries", () => {
  const models = parseOpenRouterImageModels({ data: [
    { ...validImageModel, id: "z/image" },
    { ...validImageModel, id: "a/image" },
    { ...validImageModel, id: "invalid", pricing: { prompt: "not-a-number" } },
  ] }, true);
  assert.deepEqual(models.map((model) => model.id), ["a/image", "z/image"]);
  assert.deepEqual(models[0]?.input, ["text", "image"]);
  assert.deepEqual(models[0]?.output, ["image"]);
  assert.equal(models[0]?.cost.input, 1);
});
