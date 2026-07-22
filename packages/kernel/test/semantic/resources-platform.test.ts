import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type ExecutionEnv,
  FileError,
  JsonlSessionStorage,
  NodeExecutionEnv,
  SessionError,
  executeShellWithCapture,
  formatSkillsForSystemPrompt,
  loadPromptTemplates,
  loadSourcedPromptTemplates,
  loadSkills,
  loadSourcedSkills,
  truncateTail,
} from "../../src/node.js";

async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
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

  const nonzero = await env.exec("exit 7");
  assert.equal(nonzero.ok && nonzero.value.exitCode, 7);
  const timedOut = await env.exec("sleep 2", { timeout: 0.01 });
  assert.equal(!timedOut.ok && timedOut.error.code, "timeout");
  const callback = await env.exec("printf output", { onStdout: () => { throw new Error("callback failed"); } });
  assert.equal(!callback.ok && callback.error.code, "callback_error");
  assert.equal(!callback.ok && callback.error.message, "callback failed");

  const missingShell = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-shell") });
  const unavailable = await missingShell.exec("printf ok");
  assert.equal(!unavailable.ok && unavailable.error.code, "shell_unavailable");

  const nonExecutable = join(root, "not-executable");
  await writeFile(nonExecutable, "#!/bin/sh\n");
  await chmod(nonExecutable, 0o644);
  const spawnFailure = await new NodeExecutionEnv({ cwd: root, shellPath: nonExecutable }).exec("printf ok");
  assert.equal(!spawnFailure.ok && spawnFailure.error.code, "spawn_error");
});

test("shell capture preserves a bounded tail and spills complete output", async (t) => {
  const root = await temp(t, "rigyn-agent-shell-capture-");
  const env = new NodeExecutionEnv({ cwd: root });
  const captured = await executeShellWithCapture(env, "yes line | head -n 15000");
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.value.truncated, true);
  assert.ok(captured.value.fullOutputPath);
  const full = await readFile(captured.value.fullOutputPath!, "utf8");
  assert.ok(full.length > captured.value.output.length);
  assert.ok(full.split("\n").length > 10_000);
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
  await symlink(join(root, "skills/keep"), join(root, "skills/linked"));

  const loaded = await loadSourcedSkills(env, [{ path: "skills", source: "project" as const }]);
  assert.deepEqual(loaded.skills.map((item) => item.skill.name), ["keep", "keep"]);
  assert.ok(loaded.skills.every((item) => item.source === "project"));
  assert.equal(loaded.diagnostics.length, 2);
  assert.ok(loaded.diagnostics.every((item) => item.code === "invalid_metadata" && item.source === "project"));
  assert.ok(loaded.diagnostics.some((item) => /description is required/u.test(item.message)));
  assert.ok(loaded.diagnostics.some((item) => /does not match parent directory/u.test(item.message)));
  assert.equal(loaded.skills.some((item) => item.skill.name === "skip"), false);

  const system = formatSkillsForSystemPrompt([
    ...loaded.skills.map((item) => item.skill),
    { name: "hidden", description: "hidden", content: "", filePath: "<hidden>", disableModelInvocation: true },
  ]);
  assert.match(system, /Keep skill/);
  assert.doesNotMatch(system, /hidden/);
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
  assert.deepEqual(loaded.promptTemplates.map((item) => item.name), ["link", "one"]);
  assert.ok(loaded.promptTemplates.every((item) => item.content === "Hello"));
  const sourced = await loadSourcedPromptTemplates(env, [{ path: "prompts/one.md", source: { scope: "user" as const } }]);
  assert.deepEqual(sourced.promptTemplates[0]?.source, { scope: "user" });
});

test("resource discovery accepts Windows-shaped execution paths", async () => {
  const skillsRoot = String.raw`C:\workspace\skills`;
  const skillPath = String.raw`C:\workspace\skills\SKILL.md`;
  const missing = (path: string) => ({ ok: false as const, error: new FileError("not_found", "missing", path) });
  const skillsEnv = {
    cwd: String.raw`C:\workspace`,
    async fileInfo(path: string) {
      return path === skillsRoot
        ? { ok: true as const, value: { name: "skills", path, kind: "directory" as const, size: 0, mtimeMs: 0 } }
        : missing(path);
    },
    async listDir(path: string) {
      assert.equal(path, skillsRoot);
      return { ok: true as const, value: [{ name: "SKILL.md", path: skillPath, kind: "file" as const, size: 1, mtimeMs: 0 }] };
    },
    async readTextFile(path: string) {
      assert.equal(path, skillPath);
      return { ok: true as const, value: "---\nname: skills\ndescription: Portable paths\n---\nInstructions" };
    },
  } as unknown as ExecutionEnv;
  const skills = await loadSkills(skillsEnv, skillsRoot);
  assert.deepEqual(skills.diagnostics, []);
  assert.deepEqual(skills.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })), [
    { name: "skills", filePath: skillPath },
  ]);

  const promptPath = String.raw`C:\workspace\prompts\one.md`;
  const promptEnv = {
    cwd: String.raw`C:\workspace`,
    async fileInfo(path: string) {
      assert.equal(path, promptPath);
      return { ok: true as const, value: { name: "one.md", path, kind: "file" as const, size: 1, mtimeMs: 0 } };
    },
    async readTextFile(path: string) {
      assert.equal(path, promptPath);
      return { ok: true as const, value: "Hello" };
    },
  } as unknown as ExecutionEnv;
  const prompts = await loadPromptTemplates(promptEnv, promptPath);
  assert.deepEqual(prompts.promptTemplates.map((prompt) => prompt.name), ["one"]);
});

test("skill discovery preserves backslashes inside POSIX path components", async () => {
  const skillsRoot = String.raw`/workspace/skills/odd\name`;
  const skillPath = String.raw`/workspace/skills/odd\name/SKILL.md`;
  const missing = (path: string) => ({ ok: false as const, error: new FileError("not_found", "missing", path) });
  const env = {
    cwd: "/workspace",
    async fileInfo(path: string) {
      return path === skillsRoot
        ? { ok: true as const, value: { name: String.raw`odd\name`, path, kind: "directory" as const, size: 0, mtimeMs: 0 } }
        : missing(path);
    },
    async listDir(path: string) {
      assert.equal(path, skillsRoot);
      return { ok: true as const, value: [{ name: "SKILL.md", path: skillPath, kind: "file" as const, size: 1, mtimeMs: 0 }] };
    },
    async readTextFile(path: string) {
      assert.equal(path, skillPath);
      return { ok: true as const, value: "---\nname: name\ndescription: POSIX path\n---\nInstructions" };
    },
  } as unknown as ExecutionEnv;

  const loaded = await loadSkills(env, skillsRoot);
  assert.equal(loaded.skills[0]?.name, "name");
  assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.code === "invalid_metadata" && diagnostic.message.includes(String.raw`parent directory "odd\name"`)));
});

test("JSONL storage reports malformed headers and dangling leaves", async (t) => {
  const root = await temp(t, "rigyn-agent-jsonl-invalid-");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.writeFile("bad.jsonl", "not-json\n");
  await assert.rejects(JsonlSessionStorage.open(env, join(root, "bad.jsonl")), (error: unknown) => error instanceof SessionError && error.code === "invalid_session");

  const header = { type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: root };
  const leaf = { type: "leaf", id: "leaf", parentId: null, timestamp: new Date().toISOString(), targetId: "missing" };
  await env.writeFile("dangling.jsonl", `${JSON.stringify(header)}\n${JSON.stringify(leaf)}\n`);
  const storage = await JsonlSessionStorage.open(env, join(root, "dangling.jsonl"));
  await assert.rejects(storage.getLeafId(), (error: unknown) => error instanceof SessionError && error.code === "invalid_session");
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
