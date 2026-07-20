import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("resource discovery uses one host snapshot and preserves truncation metadata", async () => {
  let tool;
  let calls = 0;
  activate({
    registerTool(value) { tool = value; },
    async getDiscoveryView(signal) {
      signal.throwIfAborted();
      calls += 1;
      return {
        resources: [
          { kind: "command", source: "builtin", name: "resume", description: "Resume a session" },
          { kind: "prompt", name: "review", extensionId: "fixture", description: "Review a change" },
          { kind: "skill", name: "testing", description: "Run focused checks", scope: "workspace", trusted: true, disableModelInvocation: false },
        ],
        truncated: true,
        omitted: { commands: 2, prompts: 0, skills: 1 },
      };
    },
  });
  const result = await tool.execute({ kind: "prompt", query: "change" }, {
    signal: new AbortController().signal,
  });
  const value = JSON.parse(result.content);
  assert.equal(calls, 1);
  assert.deepEqual(value.resources.map((entry) => `${entry.kind}:${entry.name}`), ["prompt:review"]);
  assert.equal(value.truncated, true);
  assert.deepEqual(value.omitted, { commands: 2, prompts: 0, skills: 1 });
});
