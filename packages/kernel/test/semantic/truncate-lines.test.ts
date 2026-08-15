import assert from "node:assert/strict";
import test from "node:test";
import { truncateHead, truncateTail } from "../../src/index.js";

test("truncation metadata treats empty content as zero lines", () => {
  const expected = {
    content: "",
    truncated: false,
    truncatedBy: null,
    totalLines: 0,
    totalBytes: 0,
    outputLines: 0,
    outputBytes: 0,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 1,
    maxBytes: 100,
  };
  assert.deepEqual(truncateHead("", { maxLines: 1, maxBytes: 100 }), expected);
  assert.deepEqual(truncateTail("", { maxLines: 1, maxBytes: 100 }), expected);
});

test("truncation metadata does not count a trailing newline as an extra line", () => {
  const content = "one\ntwo\nthree\n";
  for (const truncate of [truncateHead, truncateTail]) {
    const result = truncate(content, { maxLines: 3, maxBytes: 100 });
    assert.equal(result.content, content);
    assert.equal(result.truncated, false);
    assert.equal(result.totalLines, 3);
    assert.equal(result.outputLines, 3);
  }
});
