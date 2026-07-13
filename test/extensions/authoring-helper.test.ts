import assert from "node:assert/strict";
import test from "node:test";

import { defineRuntimeTool } from "../../src/extensions/authoring.js";
import type { RuntimeToolContext } from "../../src/extensions/runtime.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";

test("defineRuntimeTool rejects unsupported schemas before registration", () => {
  assert.throws(() => defineRuntimeTool<{ value: string }>({
    name: "invalid_schema",
    description: "Invalid schema",
    inputSchema: { type: "object", $ref: "#" },
    execute: async () => ({ content: "unreachable", isError: false }),
  }), /unsupported schema keyword.*\$ref/u);
});

test("defineRuntimeTool preserves typed handlers and the host cancellation signal", async () => {
  const controller = new AbortController();
  const context = {
    workspace: await WorkspaceBoundary.create(process.cwd()),
    runner: new DirectProcessRunner(),
    signal: controller.signal,
    runId: "author-helper-run",
    threadId: "author-helper-thread",
  };
  let receivedSignal: AbortSignal | undefined;
  const registration = defineRuntimeTool<{ text: string }>({
    name: "typed_echo",
    description: "Echo typed text",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 128 } },
    },
    resources: (_input, toolContext) => [{
      kind: "workspace",
      key: toolContext.workspace.root,
      mode: "read",
    }],
    async execute(input, toolContext) {
      receivedSignal = toolContext.signal;
      toolContext.signal.throwIfAborted();
      return { content: input.text, isError: false };
    },
  });

  assert.equal((await registration.execute({ text: "typed" }, context as RuntimeToolContext)).content, "typed");
  assert.strictEqual(receivedSignal, controller.signal);
  assert.deepEqual(await registration.resources?.({ text: "typed" }, context), [{
    kind: "workspace",
    key: context.workspace.root,
    mode: "read",
  }]);

  controller.abort(new Error("author helper cancelled"));
  await assert.rejects(
    async () => await registration.execute({ text: "cancel" }, context as RuntimeToolContext),
    /author helper cancelled/u,
  );
});
