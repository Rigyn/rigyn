import assert from "node:assert/strict";
import test from "node:test";

import { combinePromptImages } from "../../src/cli/prompt-input.js";
import type { ImageBlock } from "../../src/core/types.js";

const submitted: ImageBlock = { type: "image", mediaType: "image/png", data: "c3VibWl0dGVk" };
const transformed: ImageBlock = { type: "image", mediaType: "image/png", data: "dHJhbnNmb3JtZWQ=" };
const referenced: ImageBlock = { type: "image", mediaType: "image/png", data: "cmVmZXJlbmNlZA==" };
const recovered: ImageBlock = { type: "image", mediaType: "image/png", data: "cmVjb3ZlcmVk" };

test("prompt image assembly includes each referenced image exactly once", () => {
  assert.deepEqual(combinePromptImages(false, [submitted], undefined, [referenced]), [submitted, referenced]);
  assert.deepEqual(combinePromptImages(true, [submitted], [transformed], [referenced]), [transformed, referenced]);
  assert.equal(combinePromptImages(false, [], undefined, [referenced]).filter((image) => image === referenced).length, 1);
});

test("submitted and restored queue images keep their order ahead of references", () => {
  assert.deepEqual(combinePromptImages(false, [submitted, recovered], undefined, [referenced]), [
    submitted,
    recovered,
    referenced,
  ]);
});
