import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateImages } from "../src/api/openrouter-images.js";
import { getImageModels } from "../src/image-models.js";

test("the models package has no product-runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.rigyn, undefined);
  for (const source of ["../src/providers/factory.ts", "../src/api/openrouter-images.ts"]) {
    const contents = await readFile(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(contents, /(?:from|import\()\s*["']rigyn\//u);
  }
});

test("OpenRouter images use the standalone bounded package transport", async () => {
  const model = getImageModels("openrouter")[0];
  assert.ok(model);
  let payload: Record<string, unknown> | undefined;
  const result = await generateImages(model, {
    input: [{ type: "text", text: "draw a square" }],
  }, {
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "image-response",
        choices: [{
          message: {
            content: "caption",
            images: [{ image_url: { url: "data:image/png;base64,aGk=" } }],
          },
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });
  assert.equal(payload?.model, model.id);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.responseId, "image-response");
  assert.deepEqual(result.output, [
    { type: "text", text: "caption" },
    { type: "image", mimeType: "image/png", data: "aGk=" },
  ]);
  assert.equal(result.usage?.totalTokens, 3);
});

test("OpenRouter image validation fails closed before network access", async () => {
  const model = getImageModels("openrouter")[0];
  assert.ok(model);
  let requested = false;
  const result = await generateImages(model, {
    input: [{ type: "image", mimeType: "image/png", data: "not base64" }],
  }, {
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async () => {
      requested = true;
      return Response.json({});
    },
  });
  assert.equal(requested, false);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /base64/u);
});
