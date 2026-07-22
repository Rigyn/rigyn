import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJsonWithRepair,
  parseStreamingJson,
  repairJsonStrings,
} from "../../src/providers/streaming-json.js";

test("JSON string repair preserves valid escapes and fixes raw controls and invalid escapes", () => {
  const malformed = "{\"path\":\"folder\\name\\q\",\"note\":\"first\nsecond\",\"valid\":\"\\u263a\\t\"}";
  const repaired = repairJsonStrings(malformed);
  assert.deepEqual(parseJsonWithRepair<Record<string, string>>(malformed), {
    path: ["folder", "ame\\q"].join("\n"),
    note: "first\nsecond",
    valid: "☺\t",
  });
  assert.equal(repairJsonStrings(repaired), repaired);
});

test("streaming JSON returns the largest usable partial value and never throws", () => {
  assert.deepEqual(parseStreamingJson('{"query":"open'), { query: "open" });
  assert.deepEqual(parseStreamingJson('{"items":[1,2,{"name":"par'), {
    items: [1, 2, { name: "par" }],
  });
  assert.deepEqual(parseStreamingJson('{"path":"folder\\q'), { path: "folder" });
  assert.deepEqual(parseStreamingJson(""), {});
  assert.deepEqual(parseStreamingJson("not json"), {});
});

test("strict parsing reports structural incompleteness after attempting string repair", () => {
  assert.throws(() => parseJsonWithRepair('{"value":'), SyntaxError);
});
