import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type ExecutionEnv,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  type ShellCaptureProgress,
  type ShellExecOptions,
  executeShellWithCapture,
  formatSkillsForSystemPrompt,
  loadPromptTemplates,
  loadSourcedPromptTemplates,
  loadSkills,
  loadSourcedSkills,
  type PromptTemplate,
  type Skill,
  truncateTail,
} from "../../src/node.js";

async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

function nodeStdoutCommand(bytes: string, newline = false): string {
  const source = [
    'const fs=require("node:fs")',
    `const output=Buffer.alloc(${bytes},120)`,
    "let offset=0",
    "while(offset<output.length)offset+=fs.writeSync(1,output,offset,Math.min(16384,output.length-offset))",
    ...(newline ? ['fs.writeSync(1,"\\n")'] : []),
  ].join(";");
  return nodeCommand(source);
}

test("Node execution environment covers symlinks, failures, timeouts, and callback errors", async (t) => {
  const root = await temp(t, "rigyn-agent-env-edge-");
  const env = new NodeExecutionEnv({ cwd: root });
  assert.equal((await env.writeFile("target.txt", "one\ntwo\nthree")).ok, true);
  await symlink(join(root, "target.txt"), join(root, "link.txt"));
  const link = await env.fileInfo("link.txt");
  assert.equal(link.ok && link.value.kind, "symlink");
  const lines = await env.readTextLines("target.txt", { maxLines: 2 });
  assert.deepEqual(lines.ok && lines.value, ["one", "two"]);

  const nonzero = await env.exec(nodeCommand("process.exit(7)"));
  assert.equal(nonzero.ok && nonzero.value.exitCode, 7);
  const timedOut = await env.exec(nodeCommand("setTimeout(()=>{},2000)"), { timeout: 0.01 });
  assert.equal(!timedOut.ok && timedOut.error.code, "timeout");
  const callback = await env.exec(nodeCommand('process.stdout.write("output")'), { onStdout: () => { throw new Error("callback failed"); } });
  assert.equal(!callback.ok && callback.error.code, "callback_error");
  assert.equal(!callback.ok && callback.error.message, "callback failed");

  const pathShell = new NodeExecutionEnv({ cwd: root, shellPath: process.platform === "win32" ? "cmd.exe" : "sh" });
  const pathLookup = await pathShell.exec(nodeCommand('process.stdout.write("path shell")'));
  assert.equal(pathLookup.ok && pathLookup.value.stdout, "path shell");

  const missingShell = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-shell") });
  const unavailable = await missingShell.exec("ignored");
  assert.equal(!unavailable.ok && unavailable.error.code, "shell_unavailable");

  const nonExecutable = join(root, "not-executable");
  await writeFile(nonExecutable, "#!/bin/sh\n");
  await chmod(nonExecutable, 0o644);
  const spawnFailure = await new NodeExecutionEnv({ cwd: root, shellPath: nonExecutable }).exec("ignored");
  assert.equal(!spawnFailure.ok && spawnFailure.error.code, "spawn_error");
});

test("Node execution bounds buffered output while streaming callers receive every chunk", async (t) => {
  const root = await temp(t, "rigyn-agent-env-output-");
  const env = new NodeExecutionEnv({ cwd: root });
  let observedBytes = 0;
  const streamed = await env.exec(
    nodeStdoutCommand("256 * 1024"),
    { onStdout: (chunk) => { observedBytes += Buffer.byteLength(chunk, "utf8"); } },
  );
  assert.equal(streamed.ok, true);
  assert.equal(observedBytes, 256 * 1024);
  assert.equal(streamed.ok && Buffer.byteLength(streamed.value.stdout, "utf8") <= 64 * 1024, true);

  const buffered = await env.exec(
    nodeStdoutCommand("9 * 1024 * 1024"),
  );
  assert.equal(buffered.ok, false);
  assert.match(buffered.ok ? "" : buffered.error.message, /8388608-byte buffered limit/u);
});

test("Node bounded binary reads reject an oversized sparse file before allocation", async (t) => {
  const root = await temp(t, "rigyn-agent-env-bounded-read-");
  const path = join(root, "sparse.bin");
  await writeFile(path, "");
  await truncate(path, 16 * 1024 * 1024 + 1);

  const result = await new NodeExecutionEnv({ cwd: root }).readBinaryFile(
    path,
    undefined,
    16 * 1024 * 1024,
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error.message, /16777216-byte read limit/u);
});

test("Node file writes contain hostile async iterable failures", async (t) => {
  const root = await temp(t, "rigyn-agent-hostile-write-");
  const env = new NodeExecutionEnv({ cwd: root });
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
  });
  const content = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> { throw hostile; },
  };

  const result = await env.writeFile("hostile.txt", content as unknown as string);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "unknown");
  assert.equal(result.ok ? undefined : result.error.message, "[Thrown object]");
  assert.equal(traps, 0);
});

test("atomic replacement preserves the destination when already cancelled", async (t) => {
  const root = await temp(t, "rigyn-agent-atomic-write-");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.writeFile("target.txt", "original");
  const controller = new AbortController();
  controller.abort();

  const result = await (env as NodeExecutionEnv & {
    replaceFile(path: string, content: string, signal?: AbortSignal): ReturnType<ExecutionEnv["writeFile"]>;
  }).replaceFile("target.txt", "replacement", controller.signal);

  assert.equal(result.ok, false);
  assert.equal(await readFile(join(root, "target.txt"), "utf8"), "original");
});

test("file mutation tools commit atomically and settle success at the commit point", async (t) => {
  const root = await temp(t, "rigyn-agent-tool-atomic-");
  const base = new NodeExecutionEnv({ cwd: root });
  await base.writeFile("target.txt", "before\n");
  const controller = new AbortController();
  let replacements = 0;
  const env = new Proxy(base, {
    get(target, property, receiver) {
      if (property !== "replaceFile") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<ExecutionEnv["replaceFile"]>) => {
        replacements += 1;
        const result = await target.replaceFile(...args);
        controller.abort();
        return result;
      };
    },
  }) as ExecutionEnv;

  const result = await createWriteTool().execute(
    "write",
    { path: "target.txt", content: "after\n" },
    controller.signal,
    undefined,
    { env },
  );

  assert.equal(replacements, 1);
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Wrote 6 bytes to target.txt");
  assert.equal(await readFile(join(root, "target.txt"), "utf8"), "after\n");
});

test("edit tool rejects a source above its bounded read limit", async (t) => {
  const root = await temp(t, "rigyn-agent-edit-bound-");
  const path = join(root, "large.txt");
  await writeFile(path, "");
  await truncate(path, 16 * 1024 * 1024 + 1);

  await assert.rejects(
    createEditTool().execute(
      "edit",
      { path, edits: [{ oldText: "a", newText: "b" }] },
      undefined,
      undefined,
      { env: new NodeExecutionEnv({ cwd: root }) },
    ),
    /16777216-byte read limit/u,
  );
});

test("edit tool requires at least one replacement", async (t) => {
  const root = await temp(t, "rigyn-agent-edit-empty-");
  const path = join(root, "target.txt");
  await writeFile(path, "unchanged\n");

  await assert.rejects(
    createEditTool().execute(
      "edit",
      { path, edits: [] },
      undefined,
      undefined,
      { env: new NodeExecutionEnv({ cwd: root }) },
    ),
    /Provide at least one replacement edit/u,
  );
  assert.equal(await readFile(path, "utf8"), "unchanged\n");
});

test("shell capture preserves a bounded tail and spills complete output", async (t) => {
  const root = await temp(t, "rigyn-agent-shell-capture-");
  const env = new NodeExecutionEnv({ cwd: root });
  const captured = await executeShellWithCapture(env, nodeCommand('process.stdout.write("line\\n".repeat(15000))'));
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.value.truncated, true);
  assert.ok(captured.value.fullOutputPath);
  const full = await readFile(captured.value.fullOutputPath!, "utf8");
  assert.ok(full.length > captured.value.output.length);
  assert.ok(full.split("\n").length > 10_000);
  await rm(dirname(captured.value.fullOutputPath!), { recursive: true, force: true });
});

test("shell capture serializes delayed spool creation and preserves every chunk once", async (t) => {
  const root = await temp(t, "rigyn-agent-shell-spool-race-");
  const base = new NodeExecutionEnv({ cwd: root });
  const chunks = Array.from({ length: 96 }, (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(1020)}\n`);
  let createCalls = 0;
  const env = new Proxy(base, {
    get(target, property) {
      if (property === "exec") {
        return async (_command: string, options: Parameters<ExecutionEnv["exec"]>[1] = {}) => {
          for (const chunk of chunks) options.onStdout?.(chunk);
          return { ok: true as const, value: { stdout: "", stderr: "", exitCode: 0 } };
        };
      }
      if (property === "createTempFile") {
        return async (options: Parameters<ExecutionEnv["createTempFile"]>[0]) => {
          createCalls += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return target.createTempFile(options);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExecutionEnv;

  const captured = await executeShellWithCapture(env, "fixture");

  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(createCalls, 1);
  assert.ok(captured.value.fullOutputPath);
  assert.equal(await readFile(captured.value.fullOutputPath!, "utf8"), chunks.join(""));
  await rm(dirname(captured.value.fullOutputPath!), { recursive: true, force: true });
});

test("shell failures can retain captured progress and complete spooled output", async (t) => {
  const root = await temp(t, "rigyn-agent-shell-failure-output-");
  const base = new NodeExecutionEnv({ cwd: root });
  const chunks = ["first\n", `${"x".repeat(60 * 1024)}\n`, "last"];
  const env = new Proxy(base, {
    get(target, property) {
      if (property === "exec") {
        return async (_command: string, options: Parameters<ExecutionEnv["exec"]>[1] = {}) => {
          for (const chunk of chunks) options.onStdout?.(chunk);
          return {
            ok: false as const,
            error: new ExecutionError("timeout", "fixture timeout"),
          };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExecutionEnv;
  const snapshots: ShellCaptureProgress[] = [];
  const captured = await executeShellWithCapture(env, "fixture", {
    returnExecutionErrors: true,
    onChunk: (_chunk, progress) => snapshots.push(progress()),
  });

  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.value.executionError?.code, "timeout");
  assert.equal(captured.value.cancelled, false);
  assert.equal(captured.value.truncated, true);
  assert.equal(captured.value.truncation.totalBytes, Buffer.byteLength(chunks.join(""), "utf8"));
  assert.equal(captured.value.truncation.totalLines, 3);
  assert.equal(captured.value.lastLineBytes, 4);
  assert.equal(captured.value.output.endsWith("last"), true);
  assert.equal(snapshots.at(-1)?.truncation.totalLines, 3);
  assert.ok(captured.value.fullOutputPath);
  assert.equal(await readFile(captured.value.fullOutputPath!, "utf8"), chunks.join(""));

  let bashFailure: Error | undefined;
  try {
    await createBashTool().execute(
      "failed-output",
      { command: "fixture", timeout: 1 },
      undefined,
      undefined,
      { env },
    );
  } catch (error) {
    bashFailure = error instanceof Error ? error : new Error(String(error));
  }
  assert.match(bashFailure?.message ?? "", /last/u);
  assert.match(bashFailure?.message ?? "", /Shell command exceeded its time limit of 1 seconds/u);
  const bashOutputPath = /Complete output: ([^\]]+)\]/u.exec(bashFailure?.message ?? "")?.[1];
  assert.ok(bashOutputPath);

  await Promise.all([
    rm(dirname(captured.value.fullOutputPath!), { recursive: true, force: true }),
    rm(dirname(bashOutputPath!), { recursive: true, force: true }),
  ]);
});

test("shell capture does not leak capture-only options to the execution backend", async (t) => {
  const root = await temp(t, "rigyn-agent-shell-option-boundary-");
  const base = new NodeExecutionEnv({ cwd: root });
  let observed: ShellExecOptions | undefined;
  const env = new Proxy(base, {
    get(target, property) {
      if (property === "exec") {
        return async (_command: string, options: ShellExecOptions = {}) => {
          observed = options;
          options.onStdout?.("done");
          return { ok: true as const, value: { stdout: "", stderr: "", exitCode: 0 } };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExecutionEnv;

  const captured = await executeShellWithCapture(env, "fixture", {
    onChunk() {},
    returnExecutionErrors: true,
  });

  assert.equal(captured.ok, true);
  assert.deepEqual(Object.keys(observed ?? {}).sort(), ["onStderr", "onStdout"]);
});

test("cancelled shell capture drains spooled output without reusing the command signal", async (t) => {
  const root = await temp(t, "rigyn-agent-shell-cancelled-output-");
  const base = new NodeExecutionEnv({ cwd: root });
  const cancellation = new AbortController();
  const chunks = [`${"x".repeat(60 * 1024)}\n`, "cancelled tail"];
  const env = new Proxy(base, {
    get(target, property) {
      if (property === "exec") {
        return async (_command: string, options: Parameters<ExecutionEnv["exec"]>[1] = {}) => {
          for (const chunk of chunks) options.onStdout?.(chunk);
          cancellation.abort(new Error("cancelled"));
          return {
            ok: false as const,
            error: new ExecutionError("aborted", "cancelled"),
          };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExecutionEnv;

  const captured = await executeShellWithCapture(env, "fixture", {
    abortSignal: cancellation.signal,
  });

  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.value.cancelled, true);
  assert.equal(captured.value.truncated, true);
  assert.equal(captured.value.output.endsWith("cancelled tail"), true);
  assert.ok(captured.value.fullOutputPath);
  assert.equal(await readFile(captured.value.fullOutputPath!, "utf8"), chunks.join(""));
  await rm(dirname(captured.value.fullOutputPath!), { recursive: true, force: true });
});

test("bash tool progress and final output stay bounded during a large stream", async (t) => {
  const root = await temp(t, "rigyn-agent-bash-tool-output-");
  const env = new NodeExecutionEnv({ cwd: root });
  const updateBytes: number[] = [];
  const updatePaths: Array<string | undefined> = [];
  const result = await createBashTool().execute(
    "large-output",
    { command: nodeStdoutCommand("2 * 1024 * 1024", true) },
    undefined,
    (update) => {
      const text = update.content[0]?.type === "text" ? update.content[0].text : "";
      updateBytes.push(Buffer.byteLength(text, "utf8"));
      updatePaths.push(update.details?.fullOutputPath);
    },
    { env },
  );

  assert.equal(updateBytes.every((bytes) => bytes <= 50 * 1024), true);
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.equal(Buffer.byteLength(output, "utf8") <= 51 * 1024, true);
  assert.ok(result.details?.fullOutputPath);
  assert.equal(result.details?.truncation?.totalBytes, 2 * 1024 * 1024 + 1);
  assert.equal(result.details?.truncation?.totalLines, 1);
  assert.match(output, /complete line size is 2\.0MB/u);
  assert.equal(updatePaths.at(-1), result.details?.fullOutputPath);
  await rm(dirname(result.details!.fullOutputPath!), { recursive: true, force: true });
});

test("read tool rejects oversized sources before requesting their bytes", async (t) => {
  const root = await temp(t, "rigyn-agent-read-bound-");
  const base = new NodeExecutionEnv({ cwd: root });
  assert.equal((await base.writeFile("large.bin", "fixture")).ok, true);
  let binaryReads = 0;
  const env = new Proxy(base, {
    get(target, property) {
      if (property === "fileInfo") {
        return async (path: string) => ({
          ok: true as const,
          value: {
            name: "large.bin",
            path,
            kind: "file" as const,
            size: 16 * 1024 * 1024 + 1,
            mtimeMs: 0,
          },
        });
      }
      if (property === "readBinaryFile") {
        return async () => {
          binaryReads += 1;
          return { ok: true as const, value: new Uint8Array() };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExecutionEnv;

  await assert.rejects(
    createReadTool().execute("oversized", { path: "large.bin" }, undefined, undefined, { env }),
    /File is too large to read safely.*16\.0MB/u,
  );
  assert.equal(binaryReads, 0);
});

test("read tool scans dense text without retaining an unbounded line array", async (t) => {
  const root = await temp(t, "rigyn-agent-read-dense-");
  const env = new NodeExecutionEnv({ cwd: root });
  await writeFile(join(root, "dense.txt"), "x\n".repeat(250_000));

  const result = await createReadTool().execute(
    "dense",
    { path: "dense.txt" },
    undefined,
    undefined,
    { env },
  );
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";

  assert.equal(Buffer.byteLength(output, "utf8") <= 52 * 1024, true);
  assert.equal(result.details?.truncation?.truncatedBy, "lines");
  assert.equal(result.details?.truncation?.totalLines, 250_000);
  assert.equal(result.details?.truncation?.outputLines, 2_000);
});

test("read tool does not treat a trailing newline as an extra line", async (t) => {
  const root = await temp(t, "rigyn-agent-read-trailing-newline-");
  const env = new NodeExecutionEnv({ cwd: root });
  const content = `${Array.from({ length: 2_000 }, () => "x").join("\n")}\n`;
  await writeFile(join(root, "lines.txt"), content);

  const result = await createReadTool().execute(
    "trailing-newline",
    { path: "lines.txt" },
    undefined,
    undefined,
    { env },
  );

  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", content.slice(0, -1));
  assert.equal(result.details, undefined);
});

test("skill discovery honors nested ignore files, symlinks, diagnostics, and source tags", async (t) => {
  const root = await temp(t, "rigyn-agent-skills-");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.createDir("skills/keep", { recursive: true });
  await env.createDir("skills/skip", { recursive: true });
  await env.createDir("skills/broken", { recursive: true });
  await env.writeFile("skills/.gitignore", "skip/\n");
  await env.writeFile("skills/keep/SKILL.md", "---\nname: keep\ndescription: Keep skill\n---\nKeep content");
  await env.writeFile("skills/skip/SKILL.md", "---\nname: skip\ndescription: Skip skill\n---\nSkip content");
  await env.writeFile("skills/broken/SKILL.md", "---\nname: broken\n---\nNo description");
  await symlink(join(root, "skills"), join(root, "skills/cycle"));
  await symlink(join(root, "skills/keep"), join(root, "skills/linked"));

  const loaded = await loadSourcedSkills(env, [{ path: "skills", source: "project" as const }]);
  assert.deepEqual(loaded.skills.map((item) => item.skill.name), ["keep"]);
  assert.ok(loaded.skills.every((item) => item.source === "project"));
  assert.equal(loaded.diagnostics.length, 1);
  assert.ok(loaded.diagnostics.every((item) => item.code === "invalid_metadata" && item.source === "project"));
  assert.ok(loaded.diagnostics.some((item) => /description is required/u.test(item.message)));
  assert.equal(loaded.skills.some((item) => item.skill.name === "skip"), false);

  const system = formatSkillsForSystemPrompt([
    ...loaded.skills.map((item) => item.skill),
    { name: "hidden", description: "hidden", content: "", filePath: "<hidden>", disableModelInvocation: true },
  ]);
  assert.match(system, /Keep skill/);
  assert.doesNotMatch(system, /hidden/);
});

test("skill discovery rejects an oversized manifest", async (t) => {
  const root = await temp(t, "rigyn-agent-skill-bound-");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.createDir("skills/large", { recursive: true });
  await env.writeFile(
    "skills/large/SKILL.md",
    `---\nname: large\ndescription: Large skill\n---\n${"x".repeat(1024 * 1024)}`,
  );

  const loaded = await loadSkills(env, "skills");
  assert.deepEqual(loaded.skills, []);
  assert.equal(loaded.diagnostics.length, 1);
  assert.equal(loaded.diagnostics[0]?.code, "read_failed");
  assert.match(loaded.diagnostics[0]?.message ?? "", /1048576-byte read limit/u);
});

test("skill discovery stops at its directory-depth boundary", async () => {
  const missing = (path: string) => ({
    ok: false as const,
    error: new FileError("not_found", "missing", path),
  });
  const env = {
    cwd: "/workspace",
    async canonicalPath(path: string) {
      return { ok: true as const, value: path };
    },
    async fileInfo(path: string) {
      return path === "skills"
        ? {
            ok: true as const,
            value: { name: "skills", path, kind: "directory" as const, size: 0, mtimeMs: 0 },
          }
        : missing(path);
    },
    async listDir(path: string) {
      const depth = path.split("/").length - 1;
      const name = `d${depth}`;
      return {
        ok: true as const,
        value: [{
          name,
          path: `${path}/${name}`,
          kind: "directory" as const,
          size: 0,
          mtimeMs: 0,
        }],
      };
    },
  } as unknown as ExecutionEnv;

  const loaded = await loadSkills(env, "skills");

  assert.deepEqual(loaded.skills, []);
  assert.equal(loaded.diagnostics.length, 1);
  assert.equal(loaded.diagnostics[0]?.code, "list_failed");
  assert.match(loaded.diagnostics[0]?.message ?? "", /64-directory depth limit/u);
});

test("skill discovery stops before processing an oversized directory listing", async () => {
  const entries = Array.from({ length: 10_001 }, (_, index) => ({
    name: `entry-${index}.md`,
    path: `skills/entry-${index}.md`,
    kind: "file" as const,
    size: 0,
    mtimeMs: 0,
  }));
  const env = {
    cwd: "/workspace",
    async canonicalPath(path: string) {
      return { ok: true as const, value: path };
    },
    async fileInfo(path: string) {
      assert.equal(path, "skills");
      return {
        ok: true as const,
        value: { name: "skills", path, kind: "directory" as const, size: 0, mtimeMs: 0 },
      };
    },
    async listDir(path: string) {
      assert.equal(path, "skills");
      return { ok: true as const, value: entries };
    },
  } as unknown as ExecutionEnv;

  const loaded = await loadSkills(env, "skills");

  assert.deepEqual(loaded.skills, []);
  assert.equal(loaded.diagnostics.length, 1);
  assert.equal(loaded.diagnostics[0]?.code, "list_failed");
  assert.match(loaded.diagnostics[0]?.message ?? "", /10000-entry limit/u);
});

test("prompt discovery is non-recursive, source tagged, CRLF-safe, and symlink aware", async (t) => {
  const root = await temp(t, "rigyn-agent-prompts-");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.createDir("prompts/nested", { recursive: true });
  await env.writeFile("prompts/one.md", "---\r\ndescription: One\r\n---\r\nHello");
  const promptInfo = await env.fileInfo("prompts/one.md");
  assert.equal(promptInfo.ok && promptInfo.value.name, "one.md");
  await env.writeFile("prompts/nested/ignored.md", "Ignored");
  await symlink(join(root, "prompts/one.md"), join(root, "prompts/link.md"));
  const loaded = await loadPromptTemplates(env, "prompts");
  const promptTemplates: PromptTemplate[] = [...loaded.promptTemplates];
  assert.deepEqual(promptTemplates.map((item) => item.name), ["link", "one"]);
  assert.ok(promptTemplates.every((item) => item.content === "Hello"));
  const sourced = await loadSourcedPromptTemplates(env, [{ path: "prompts/one.md", source: { scope: "user" as const } }]);
  assert.deepEqual(sourced.promptTemplates[0]?.source, { scope: "user" });
});

test("prompt templates enforce exact per-file and aggregate byte bounds", async (t) => {
  const root = await temp(t, "rigyn-agent-prompt-bounds-");
  const env = new NodeExecutionEnv({ cwd: root });
  assert.equal((await env.createDir("prompts")).ok, true);
  assert.equal((await env.writeFile("prompts/exact.md", Buffer.alloc(1024 * 1024, 0x61))).ok, true);
  assert.equal((await env.writeFile("prompts/oversized.md", Buffer.alloc(1024 * 1024 + 1, 0x62))).ok, true);

  const loaded = await loadPromptTemplates(env, "prompts");
  const promptTemplates: PromptTemplate[] = [...loaded.promptTemplates];
  assert.deepEqual(promptTemplates.map((entry) => entry.name), ["exact"]);
  assert.equal(loaded.diagnostics.length, 1);
  assert.equal(loaded.diagnostics[0]?.code, "read_failed");
  assert.match(loaded.diagnostics[0]?.message ?? "", /1048576 bytes/u);

  const payload = new Uint8Array(1024 * 1024);
  const entries = Array.from({ length: 17 }, (_, index) => ({
    name: `prompt-${String(index).padStart(2, "0")}.md`,
    path: `aggregate/prompt-${String(index).padStart(2, "0")}.md`,
    kind: "file" as const,
    size: payload.byteLength,
    mtimeMs: 0,
  }));
  let reads = 0;
  const aggregateEnv = {
    cwd: "/workspace",
    async fileInfo(path: string) {
      return { ok: true as const, value: { name: "aggregate", path, kind: "directory" as const, size: 0, mtimeMs: 0 } };
    },
    async listDir() { return { ok: true as const, value: entries }; },
    async readBinaryFile() { reads += 1; return { ok: true as const, value: payload }; },
  } as unknown as ExecutionEnv;
  const aggregate = await loadPromptTemplates(aggregateEnv, "aggregate");
  assert.equal(aggregate.promptTemplates.length, 16);
  assert.equal(reads, 16);
  assert.equal(aggregate.diagnostics.at(-1)?.code, "read_failed");
  assert.match(aggregate.diagnostics.at(-1)?.message ?? "", /16777216 aggregate bytes/u);
});

test("prompt template discovery stops reading after 1024 files", async () => {
  const entries = Array.from({ length: 1025 }, (_, index) => ({
    name: `prompt-${String(index).padStart(4, "0")}.md`,
    path: `prompts/prompt-${String(index).padStart(4, "0")}.md`,
    kind: "file" as const,
    size: 0,
    mtimeMs: 0,
  }));
  let reads = 0;
  const env = {
    cwd: "/workspace",
    async fileInfo(path: string) {
      return { ok: true as const, value: { name: "prompts", path, kind: "directory" as const, size: 0, mtimeMs: 0 } };
    },
    async listDir() { return { ok: true as const, value: entries }; },
    async readBinaryFile() { reads += 1; return { ok: true as const, value: new Uint8Array() }; },
  } as unknown as ExecutionEnv;

  const loaded = await loadPromptTemplates(env, "prompts");
  assert.equal(loaded.promptTemplates.length, 1024);
  assert.equal(reads, 1024);
  assert.equal(loaded.diagnostics.at(-1)?.code, "list_failed");
  assert.match(loaded.diagnostics.at(-1)?.message ?? "", /1024 files/u);
});

test("resource discovery accepts Windows-shaped execution paths", async () => {
  const skillsRoot = String.raw`C:\workspace\skills`;
  const skillPath = String.raw`C:\workspace\skills\SKILL.md`;
  const missing = (path: string) => ({ ok: false as const, error: new FileError("not_found", "missing", path) });
  const skillsEnv = {
    cwd: String.raw`C:\workspace`,
    async canonicalPath(path: string) {
      return { ok: true as const, value: path };
    },
    async fileInfo(path: string) {
      return path === skillsRoot
        ? { ok: true as const, value: { name: "skills", path, kind: "directory" as const, size: 0, mtimeMs: 0 } }
        : missing(path);
    },
    async listDir(path: string) {
      assert.equal(path, skillsRoot);
      return { ok: true as const, value: [{ name: "SKILL.md", path: skillPath, kind: "file" as const, size: 1, mtimeMs: 0 }] };
    },
    async readBinaryFile(path: string) {
      assert.equal(path, skillPath);
      return {
        ok: true as const,
        value: new TextEncoder().encode("---\nname: skills\ndescription: Portable paths\n---\nInstructions"),
      };
    },
  } as unknown as ExecutionEnv;
  const skills = await loadSkills(skillsEnv, skillsRoot);
  const loadedSkills: Skill[] = [...skills.skills];
  assert.deepEqual(skills.diagnostics, []);
  assert.deepEqual(loadedSkills.map((skill) => ({ name: skill.name, filePath: skill.filePath })), [
    { name: "skills", filePath: skillPath },
  ]);

  const promptPath = String.raw`C:\workspace\prompts\one.md`;
  const promptEnv = {
    cwd: String.raw`C:\workspace`,
    async fileInfo(path: string) {
      assert.equal(path, promptPath);
      return { ok: true as const, value: { name: "one.md", path, kind: "file" as const, size: 1, mtimeMs: 0 } };
    },
    async readBinaryFile(path: string) {
      assert.equal(path, promptPath);
      return { ok: true as const, value: new TextEncoder().encode("Hello") };
    },
  } as unknown as ExecutionEnv;
  const prompts = await loadPromptTemplates(promptEnv, promptPath);
  const promptTemplates: PromptTemplate[] = [...prompts.promptTemplates];
  assert.deepEqual(promptTemplates.map((prompt) => prompt.name), ["one"]);
});

test("skill discovery preserves backslashes inside POSIX path components", async () => {
  const skillsRoot = String.raw`/workspace/skills/odd\name`;
  const skillPath = String.raw`/workspace/skills/odd\name/SKILL.md`;
  const missing = (path: string) => ({ ok: false as const, error: new FileError("not_found", "missing", path) });
  const env = {
    cwd: "/workspace",
    async canonicalPath(path: string) {
      return { ok: true as const, value: path };
    },
    async fileInfo(path: string) {
      return path === skillsRoot
        ? { ok: true as const, value: { name: String.raw`odd\name`, path, kind: "directory" as const, size: 0, mtimeMs: 0 } }
        : missing(path);
    },
    async listDir(path: string) {
      assert.equal(path, skillsRoot);
      return { ok: true as const, value: [{ name: "SKILL.md", path: skillPath, kind: "file" as const, size: 1, mtimeMs: 0 }] };
    },
    async readBinaryFile(path: string) {
      assert.equal(path, skillPath);
      return {
        ok: true as const,
        value: new TextEncoder().encode("---\nname: name\ndescription: POSIX path\n---\nInstructions"),
      };
    },
  } as unknown as ExecutionEnv;

  const loaded = await loadSkills(env, skillsRoot);
  const loadedSkills: Skill[] = [...loaded.skills];
  assert.equal(loadedSkills[0]?.name, "name");
  assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.code === "invalid_metadata" && diagnostic.message.includes(String.raw`directory "odd\name"`)));
});

test("tail truncation matches UTF-8 byte-tail semantics for surrogate edges", () => {
  const inputs = ["a\ud83d", "\ude42b", "a\ude42b", "\ud83d\ud83d\ude42", "\ud83d\ude42\ude42", "👩‍💻"];
  for (const input of inputs) {
    const total = Buffer.byteLength(input, "utf8");
    for (let maxBytes = 0; maxBytes <= total + 2; maxBytes++) {
      const bytes = Buffer.from(input, "utf8");
      if (bytes.length <= maxBytes) {
        assert.equal(truncateTail(input, { maxBytes, maxLines: 10 }).content, input);
        continue;
      }
      let start = Math.max(0, bytes.length - maxBytes);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      assert.equal(truncateTail(input, { maxBytes, maxLines: 10 }).content, bytes.subarray(start).toString("utf8"));
    }
  }
});
