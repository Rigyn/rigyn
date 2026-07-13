import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import type { CommandResult, CommandSpec, ProcessRunner } from "../../src/process/index.js";
import {
  ExternalToolBackend,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
  type HarnessTool,
  type ToolContext,
  type ToolExecutionBackend,
  type ToolResult,
} from "../../src/tools/index.js";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      result: { content: "remote", isError: false, status: "success", summary: "remote" },
    })),
    stderr: Buffer.alloc(0),
    stdoutBytes: 96,
    stderrBytes: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    ...overrides,
  };
}

async function context(t: TestContext): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-backend-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: { async run() { return commandResult(); } },
    signal: new AbortController().signal,
    runId: "run-backend",
    threadId: "thread-backend",
  };
}

function localTool(executions: { value: number }): HarnessTool {
  return {
    definition: {
      name: "read",
      description: "fixture",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") {
        throw new Error("path required");
      }
    },
    resources() { return [{ kind: "file", key: "local", mode: "read" }]; },
    async execute() {
      executions.value += 1;
      return { content: "local", isError: false };
    },
  };
}

test("tool coordinator routes an explicitly owned tool without local fallback", async (t) => {
  const executions = { value: 0 };
  const requests: string[] = [];
  const backend: ToolExecutionBackend = {
    id: "fixture",
    handles(name) { return name === "read"; },
    resources(request) {
      requests.push(`resources:${request.invocation.name}`);
      return [{ kind: "workspace", key: "workspace", mode: "read" }];
    },
    async execute(request) {
      requests.push(`execute:${request.invocation.name}`);
      return { content: "isolated", isError: false, status: "success", summary: "isolated" };
    },
  };
  const toolContext = { ...await context(t), backend };
  const [result] = await new ToolCoordinator(new ToolRegistry([localTool(executions)])).execute(
    [{ callId: "call", name: "read", input: { path: "README.md" }, index: 0 }],
    toolContext,
  );

  assert.equal(result?.result.content, "isolated");
  assert.equal(executions.value, 0);
  assert.deepEqual(requests, ["resources:read", "execute:read"]);
});

test("backend failures are visible and never retry through the local tool", async (t) => {
  const executions = { value: 0 };
  const backend: ToolExecutionBackend = {
    id: "unavailable",
    handles(name) { return name === "read"; },
    resources() { return [{ kind: "workspace", key: "workspace", mode: "read" }]; },
    async execute() { throw new Error("isolation could not be established"); },
  };
  const [result] = await new ToolCoordinator(new ToolRegistry([localTool(executions)])).execute(
    [{ callId: "call", name: "read", input: { path: "README.md" }, index: 0 }],
    { ...await context(t), backend },
  );

  assert.equal(result?.result.status, "error");
  assert.match(result?.result.content ?? "", /isolation could not be established/u);
  assert.equal(executions.value, 0);
});

test("malformed backend tool results become bounded visible errors", async (t) => {
  const executions = { value: 0 };
  const backend: ToolExecutionBackend = {
    id: "malformed-result",
    handles(name) { return name === "read"; },
    resources() { return [{ kind: "workspace", key: "workspace", mode: "read" }]; },
    async execute() { return {} as unknown as ToolResult; },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([localTool(executions)]),
    {},
    { text: (value) => value, value: (value) => value },
  );
  const [result] = await coordinator.execute(
    [{ callId: "call", name: "read", input: { path: "README.md" }, index: 0 }],
    { ...await context(t), backend },
  );

  assert.equal(result?.result.status, "error");
  assert.match(result?.result.content ?? "", /invalid non-string content/u);
  assert.equal(executions.value, 0);
});

test("external backend sends bounded protocol JSON with no inherited environment", async (t) => {
  const seen: CommandSpec[] = [];
  const runner: ProcessRunner = {
    async run(spec) {
      seen.push(spec);
      const stdout = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        result: { content: "external", isError: false, metadata: { source: "fixture" } },
      }));
      return commandResult({ stdout, stdoutBytes: stdout.byteLength });
    },
  };
  const toolContext = await context(t);
  const backend = new ExternalToolBackend({
    id: "external-fixture",
    argv: [process.execPath, "/fixture/backend.mjs"],
    cwd: toolContext.workspace.root,
    workspace: "/workspace",
    tools: { read: "read" },
    runner,
  });
  const invocation = { callId: "call", name: "read", input: { path: "one.txt" }, index: 0 };
  const result = await backend.execute({ invocation, workspace: toolContext.workspace.root }, toolContext);

  assert.equal(result.content, "external");
  assert.equal(seen[0]?.inheritEnv, false);
  assert.equal(seen[0]?.env, undefined);
  assert.deepEqual(JSON.parse(seen[0]?.stdin ?? ""), {
    schemaVersion: 1,
    tool: "read",
    input: { path: "one.txt" },
    workspace: "/workspace",
  });
});

test("external backend rejects malformed, truncated, and failing responses", async (t) => {
  const toolContext = await context(t);
  const outcomes = [
    commandResult({ stdout: Buffer.from("not json"), stdoutBytes: 8 }),
    commandResult({ stdout: Buffer.from("{}"), stdoutBytes: 2 }),
    commandResult({ stdout: Buffer.from("{}"), stdoutBytes: 3 }),
    commandResult({ exitCode: 7, stderr: Buffer.from("boundary unavailable"), stderrBytes: 20 }),
  ];
  const runner: ProcessRunner = { async run() { return outcomes.shift()!; } };
  const backend = new ExternalToolBackend({
    id: "external-errors",
    argv: [process.execPath],
    cwd: toolContext.workspace.root,
    workspace: "/workspace",
    tools: { read: "read" },
    runner,
  });
  const request = {
    invocation: { callId: "call", name: "read", input: { path: "one.txt" }, index: 0 },
    workspace: toolContext.workspace.root,
  };

  await assert.rejects(backend.execute(request, toolContext), /malformed JSON/u);
  await assert.rejects(backend.execute(request, toolContext), /invalid protocol response/u);
  await assert.rejects(backend.execute(request, toolContext), /response exceeded/u);
  await assert.rejects(backend.execute(request, toolContext), /boundary unavailable/u);
});

test("external backend validates authority configuration", async () => {
  assert.throws(() => new ExternalToolBackend({
    id: "bad",
    argv: ["node"],
    cwd: "/tmp",
    workspace: "/workspace",
    tools: { read: "read" },
  }), /executable must be absolute/u);
  assert.throws(() => new ExternalToolBackend({
    id: "bad",
    argv: [process.execPath],
    cwd: "/tmp",
    workspace: "/workspace",
    tools: {},
  }), /at least one tool/u);
  await assert.rejects(ExternalToolBackend.create({
    id: "missing",
    argv: [resolve("missing-backend-command")],
    cwd: "/tmp",
    workspace: "/workspace",
    tools: { read: "read" },
  }), /ENOENT|no such file/iu);
});

test("reference worker executes a core tool through the external protocol", async (t) => {
  const toolContext = await context(t);
  await writeFile(join(toolContext.workspace.root, "note.txt"), "reference backend\n", "utf8");
  const backend = new ExternalToolBackend({
    id: "reference-worker",
    argv: [
      process.execPath,
      "--import",
      "tsx",
      resolve("src/bin/tool-backend-worker.ts"),
    ],
    cwd: process.cwd(),
    workspace: toolContext.workspace.root,
    tools: { read: "read" },
    timeoutMs: 10_000,
  });
  const result = await backend.execute({
    invocation: { callId: "read-note", name: "read", input: { path: "note.txt" }, index: 0 },
    workspace: toolContext.workspace.root,
  }, toolContext);

  assert.equal(result.isError, false);
  assert.match(result.content, /reference backend/u);
});
