import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DirectProcessRunner } from "../../src/process/index.js";
import {
  EditTool,
  ReadTool,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
  WriteTool,
  MAX_TOOL_BATCH_CONTENT_BYTES,
  MAX_TOOL_RESULT_CONTENT_BYTES,
  MAX_TOOL_RESULT_IMAGES,
  MAX_TOOL_RESULT_METADATA_BYTES,
  resourcesConflict,
} from "../../src/tools/index.js";
import type { HarnessTool, ToolContext } from "../../src/tools/types.js";

async function fixture(): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "harness-tools-"));
  const workspace = await WorkspaceBoundary.create(root);
  return {
    root,
    context: {
      workspace,
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run",
      threadId: "thread",
    },
  };
}

test("workspace boundary rejects traversal and mutation through a symlink", async () => {
  const { root, context } = await fixture();
  await assert.rejects(context.workspace.readable("../outside"), /escapes workspace/u);
  const outside = await mkdtemp(join(tmpdir(), "harness-outside-"));
  await symlink(outside, join(root, "link"), "dir");
  await assert.rejects(context.workspace.writable("link/owned.txt", { createParents: true }), /symbolic link/u);
});

test("write, read, and exact edit integrate through the compact schemas", async () => {
  const { root, context } = await fixture();
  const write = new WriteTool();
  const read = new ReadTool();
  const edit = new EditTool();
  await write.execute({ path: "src/a.txt", content: "one\ntwo\n" }, context);
  const shown = await read.execute({ path: "src/a.txt", offset: 2, limit: 1 }, context);
  assert.match(shown.content, /^two/u);
  await edit.execute({ path: "src/a.txt", edits: [{ oldText: "two", newText: "three" }] }, context);
  assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "one\nthree\n");
});

test("edit uses a bounded normalized fallback while preserving exact-match precedence", async () => {
  const { root, context } = await fixture();
  const edit = new EditTool();
  await writeFile(join(root, "normalized.ts"), "const cafe\u0301 = 1;  \r\nnext();\r\n");
  const normalized = await edit.execute({
    path: "normalized.ts",
    edits: [{ oldText: "const café = 1;\nnext();\n", newText: "done();\n" }],
  }, context);
  assert.equal(await readFile(join(root, "normalized.ts"), "utf8"), "done();\r\n");
  assert.deepEqual((normalized.metadata as { modes?: string[] }).modes, ["normalized"]);

  await writeFile(join(root, "exact.txt"), "x\r\nx\n");
  const exact = await edit.execute({ path: "exact.txt", edits: [{ oldText: "x\r\n", newText: "y\n" }] }, context);
  assert.equal(await readFile(join(root, "exact.txt"), "utf8"), "y\r\nx\n");
  assert.deepEqual((exact.metadata as { modes?: string[] }).modes, ["exact"]);

  await writeFile(join(root, "ambiguous.txt"), "cafe\u0301\ncafé\n");
  await assert.rejects(
    edit.execute({ path: "ambiguous.txt", edits: [{ oldText: "café  ", newText: "changed" }] }, context),
    /Found 2 occurrences/u,
  );
});

test("read attaches a validated image without placing base64 in visible output", async () => {
  const { root, context } = await fixture();
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(root, "pixel.png"), image);
  const read = new ReadTool();
  const result = await read.execute({ path: "pixel.png" }, context);
  assert.equal(result.isError, false);
  assert.match(result.content, /Read image file \[image\/png\]/u);
  assert.equal(result.content.includes(image.toString("base64")), false);
  assert.deepEqual(result.images, [{ type: "image", mediaType: "image/png", data: image.toString("base64") }]);
  assert.deepEqual(result.metadata, {
    path: "pixel.png",
    mediaType: "image/png",
    width: 1,
    height: 1,
    totalBytes: image.byteLength,
    resized: false,
  });
});

test("resource conflicts recognize parent paths and read concurrency", () => {
  assert.equal(resourcesConflict(
    [{ kind: "file", key: "/w/src", mode: "read" }],
    [{ kind: "file", key: "/w/src/a", mode: "read" }],
  ), false);
  assert.equal(resourcesConflict(
    [{ kind: "file", key: "/w/src", mode: "read" }],
    [{ kind: "file", key: "/w/src/a", mode: "write" }],
  ), true);
});

test("tool definitions have a deterministic name order for provider cache prefixes", () => {
  const registry = new ToolRegistry([new WriteTool(), new ReadTool()]);
  assert.deepEqual(registry.definitions().map((definition) => definition.name), ["read", "write"]);
});

test("coordinator returns one ordered result for unknown, invalid, and valid calls", async () => {
  const { context } = await fixture();
  const registry = new ToolRegistry([new ReadTool(), new WriteTool()]);
  const coordinator = new ToolCoordinator(registry);
  const results = await coordinator.execute([
    { callId: "1", name: "missing", input: {}, index: 0 },
    { callId: "2", name: "read", input: {}, index: 1 },
    { callId: "3", name: "write", input: { path: "a", content: "x" }, index: 2 },
    { callId: "4", name: "write", input: { path: "b", content: "y" }, index: 3 },
  ], context);
  assert.deepEqual(results.map((entry) => entry.invocation.index), [0, 1, 2, 3]);
  assert.match(results[0]?.result.content ?? "", /Unknown or inactive tool/u);
  assert.equal(results[0]?.result.status, "error");
  assert.match(results[0]?.result.summary ?? "", /Unknown or inactive tool/u);
  assert.deepEqual(results[0]?.result.nextActions, ["Retry with one of the active tools: read, write."]);
  assert.match(results[1]?.result.content ?? "", /Invalid tool request/u);
  assert.match(results[1]?.result.nextActions?.[0] ?? "", /match the read schema/u);
  assert.equal(results[2]?.result.isError, false);
  assert.equal(results[3]?.result.isError, false);
});

test("coordinator fails every duplicate call ID before preparing or executing either call", async () => {
  const { context } = await fixture();
  let executions = 0;
  const tool: HarnessTool = {
    definition: { name: "mutate", description: "test", inputSchema: { type: "object" } },
    validate() {},
    resources() { return [{ kind: "workspace", key: "workspace", mode: "write" }]; },
    async execute() {
      executions += 1;
      return { content: "mutated", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const results = await coordinator.execute([
    { callId: "same", name: "mutate", input: {}, index: 0 },
    { callId: "same", name: "mutate", input: {}, index: 1 },
  ], context);
  assert.equal(executions, 0);
  assert.equal(results.length, 2);
  assert.ok(results.every((entry) => entry.result.isError && /Duplicate tool call ID/u.test(entry.result.content)));
});

test("coordinator centrally bounds single, aggregate, and metadata tool output", async () => {
  const { context } = await fixture();
  const content = `head-${"x".repeat(2 * 1024 * 1024)}-tail`;
  const tool: HarnessTool = {
    definition: { name: "large", description: "test", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() {
      return { content, isError: false, metadata: { payload: "m".repeat(128 * 1024) } };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const invocations = Array.from({ length: 4 }, (_, index) => ({
    callId: `large-${index}`,
    name: "large",
    input: {},
    index,
  }));
  const results = await coordinator.execute(invocations, context);
  assert.equal(results.length, 4);
  assert.ok(results.every((entry) => Buffer.byteLength(entry.result.content) <= MAX_TOOL_RESULT_CONTENT_BYTES));
  assert.ok(results.reduce((total, entry) => total + Buffer.byteLength(entry.result.content), 0) <= MAX_TOOL_BATCH_CONTENT_BYTES);
  assert.ok(results.every((entry) => Buffer.byteLength(JSON.stringify(entry.result.metadata)) <= MAX_TOOL_RESULT_METADATA_BYTES));
  assert.match(results[0]?.result.content ?? "", /bytes omitted/u);
  assert.match(results[0]?.result.content ?? "", /head-/u);
  assert.match(results[0]?.result.content ?? "", /-tail/u);
  assert.deepEqual(results[0]?.result.metadata, { truncated: true, originalBytes: 131086 });
});

test("coordinator admits only bounded, format-matching tool-result images", async () => {
  const { context } = await fixture();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
  const imageTool: HarnessTool = {
    definition: { name: "image", description: "test", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(input) {
      const invalid = input !== null && typeof input === "object" && !Array.isArray(input) && input.invalid === true;
      return {
        content: "image result",
        isError: false,
        images: invalid
          ? [{ type: "image", mediaType: "image/jpeg", data: png }]
          : [{ type: "image", mediaType: "image/png", data: png }],
      };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([imageTool]));
  const [valid, invalid] = await coordinator.execute([
    { callId: "valid", name: "image", input: {}, index: 0 },
    { callId: "invalid", name: "image", input: { invalid: true }, index: 1 },
  ], context);
  assert.deepEqual(valid?.result.images, [{ type: "image", mediaType: "image/png", data: png }]);
  assert.equal(valid?.result.isError, false);
  assert.equal(invalid?.result.images, undefined);
  assert.equal(invalid?.result.isError, true);
  assert.match(invalid?.result.content ?? "", /invalid image/u);
  assert.equal(MAX_TOOL_RESULT_IMAGES, 4);
});
