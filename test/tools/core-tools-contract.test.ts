import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandResult, CommandSpec, ProcessRunner } from "../../src/process/types.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { EditTool, ReadTool, ShellTool, WorkspaceBoundary, WriteTool } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function fixture(options: { runner?: ProcessRunner } = {}): Promise<{
  root: string;
  context: ToolContext;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "harness-core-tools-"));
  return {
    root,
    context: {
      workspace: await WorkspaceBoundary.create(root),
      runner: options.runner ?? new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run-core-tools",
      threadId: "thread-core-tools",
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function properties(tool: { definition: { inputSchema: unknown } }): string[] {
  const schema = tool.definition.inputSchema as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {}).sort();
}

test("default core tool schemas expose a compact coding action space", () => {
  assert.deepEqual(properties(new ReadTool()), ["limit", "offset", "path"]);
  assert.deepEqual(properties(new WriteTool()), ["content", "path"]);
  assert.deepEqual(properties(new EditTool()), ["edits", "path"]);
  assert.deepEqual(properties(new ShellTool("bash")), ["command", "timeout"]);
});

test("read accepts absolute paths and returns raw text with offset/limit continuation", async (t) => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-read-outside-"));
  t.after(async () => {
    await workspace.close();
    await rm(outside, { recursive: true, force: true });
  });
  const path = join(outside, "docs.txt");
  await writeFile(path, "one\ntwo\nthree\n", "utf8");

  const result = await new ReadTool().execute({ path, offset: 2, limit: 1 }, workspace.context);
  assert.equal(result.content, "two\n\n[2 more lines in file. Use offset=3 to continue.]");
  assert.doesNotMatch(result.content, /\d+ \|/u);
});

test("write creates missing parents for relative and absolute paths without extra flags", async (t) => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-write-outside-"));
  t.after(async () => {
    await workspace.close();
    await rm(outside, { recursive: true, force: true });
  });

  await new WriteTool().execute({ path: "nested/relative.txt", content: "relative\n" }, workspace.context);
  const absolute = join(outside, "nested", "absolute.txt");
  await new WriteTool().execute({ path: absolute, content: "absolute\n" }, workspace.context);

  assert.equal(await readFile(join(workspace.root, "nested", "relative.txt"), "utf8"), "relative\n");
  assert.equal(await readFile(absolute, "utf8"), "absolute\n");
});

test("edit accepts absolute paths and applies unique disjoint edits against the original", async (t) => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-edit-outside-"));
  t.after(async () => {
    await workspace.close();
    await rm(outside, { recursive: true, force: true });
  });
  const path = join(outside, "sample.txt");
  await writeFile(path, "console.log(‘hello’);\nkeep   \n", "utf8");

  await new EditTool().execute({
    path,
    edits: [
      { oldText: "console.log('hello');", newText: "console.log('world');" },
      { oldText: "keep\n", newText: "kept\n" },
    ],
  }, workspace.context);

  assert.equal(await readFile(path, "utf8"), "console.log('world');\nkept\n");
});

test("bash uses seconds for timeout, runs at the session cwd, and returns unlabelled combined output", async (t) => {
  let received: CommandSpec | undefined;
  const runner: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      received = spec;
      spec.onOutput?.("stdout", Buffer.from("first\n"));
      spec.onOutput?.("stderr", Buffer.from("second\n"));
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: 6,
        stderrBytes: 7,
        timedOut: false,
        cancelled: false,
        durationMs: 3,
      };
    },
  };
  const workspace = await fixture({ runner });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "ignored", timeout: 2 }, workspace.context);
  assert.equal(received?.cwd, workspace.root);
  assert.equal(received?.timeoutMs, 2_000);
  assert.equal(result.content, "first\nsecond\n");
  assert.doesNotMatch(result.content, /stdout:|stderr:|Command exited/u);
});

test("bash prepends the configured shell source in the existing invocation", async (t) => {
  let received: CommandSpec | undefined;
  const runner: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      received = spec;
      return { exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0, timedOut: false, cancelled: false, durationMs: 1 };
    },
  };
  const workspace = await fixture({ runner });
  t.after(async () => await workspace.close());
  await new ShellTool("bash", { commandPrefix: "source ~/.profile" }).execute({ command: "printf ready" }, workspace.context);
  assert.match(received?.argv.at(-1) ?? "", /source ~\/\.profile\nprintf ready/u);
});

test("bash defaults omitted timeouts to ten minutes", async (t) => {
  let received: CommandSpec | undefined;
  const runner: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      received = spec;
      return {
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: 0,
        stderrBytes: 0,
        timedOut: true,
        cancelled: false,
        durationMs: 600_000,
      };
    },
  };
  const workspace = await fixture({ runner });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "ignored" }, workspace.context);
  assert.equal(received?.timeoutMs, 600_000);
  assert.equal(result.content, "Command timed out after 600 seconds");
  assert.equal(result.isError, true);
});

test("read truncates at 2,000 complete lines and provides an exact offset", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const lines = Array.from({ length: 2_500 }, (_, index) => `line-${index + 1}`);
  await writeFile(join(workspace.root, "large.txt"), lines.join("\n"), "utf8");

  const first = await new ReadTool().execute({ path: "large.txt" }, workspace.context);
  assert.match(first.content, /^line-1\n/u);
  assert.match(first.content, /\nline-2000\n\n\[Showing lines 1-2000 of 2500\. Use offset=2001 to continue\.\]$/u);
  assert.doesNotMatch(first.content, /line-2001/u);

  const rest = await new ReadTool().execute({ path: "large.txt", offset: 2001 }, workspace.context);
  assert.match(rest.content, /^line-2001\n/u);
  assert.match(rest.content, /line-2500$/u);
});

test("read never returns a partial ordinary line and gives a bash fallback for one oversized line", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const line = "é".repeat(30_000);
  await writeFile(join(workspace.root, "wide.txt"), `${line}\nafter\n`, "utf8");

  const first = await new ReadTool().execute({ path: "wide.txt" }, workspace.context);
  assert.match(first.content, /^\[Line 1 is .+ exceeds 50\.0KB limit\. Use bash:/u);
  assert.doesNotMatch(first.content, /�/u);
  const rest = await new ReadTool().execute({ path: "wide.txt", offset: 2 }, workspace.context);
  assert.equal(rest.content, "after\n");
});

test("bash keeps the final 2,000 lines and persists complete truncated output", async (t) => {
  const output = Buffer.from(Array.from({ length: 3_000 }, (_, index) => String(index + 1)).join("\n") + "\n");
  const selected: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      for (let offset = 0; offset < output.byteLength; offset += 137) {
        spec.onOutput?.("stdout", output.subarray(offset, Math.min(output.byteLength, offset + 137)));
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: output.byteLength,
        stderrBytes: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
      };
    },
  };
  const workspace = await fixture({ runner: selected });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "seq 3000" }, workspace.context);
  assert.match(result.content, /^1001\n1002\n/u);
  assert.match(result.content, /2999\n3000\n\n\[Showing lines 1001-3000 of 3000\. Full output: /u);
  assert.doesNotMatch(result.content, /^1\n/u);
  const fullOutputPath = (result.metadata as { fullOutputPath?: string }).fullOutputPath;
  assert.ok(fullOutputPath);
  assert.equal(await readFile(fullOutputPath, "utf8"), output.toString("utf8"));
  await rm(fullOutputPath, { force: true });
});

test("edit and write serialize aliases of the same physical file", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const path = join(workspace.root, "shared.txt");
  await writeFile(path, "alpha\nbeta\n", "utf8");
  const edit = new EditTool();

  await Promise.all([
    edit.execute({ path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }, workspace.context),
    edit.execute({ path, edits: [{ oldText: "beta", newText: "BETA" }] }, workspace.context),
  ]);
  assert.equal(await readFile(path, "utf8"), "ALPHA\nBETA\n");
});

test("direct bash inherits ordinary environment variables", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const previous = process.env.HARNESS_TEST_ENV;
  process.env.HARNESS_TEST_ENV = "visible-to-command";
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_TEST_ENV;
    else process.env.HARNESS_TEST_ENV = previous;
  });

  const result = await new ShellTool("bash").execute({ command: "printf %s \"$HARNESS_TEST_ENV\"" }, workspace.context);
  assert.equal(result.content, "visible-to-command");
});
