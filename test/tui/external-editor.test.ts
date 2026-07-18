import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { editTextExternally, parseEditorCommand } from "../../src/tui/external-editor.js";

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {}
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("editor command parsing handles quoted arguments without invoking a shell", () => {
  assert.deepEqual(parseEditorCommand(`code --wait "two words" 'literal value'`), [
    "code",
    "--wait",
    "two words",
    "literal value",
  ]);
  assert.throws(() => parseEditorCommand("editor 'unfinished"), /unfinished/u);
  assert.throws(() => parseEditorCommand("   "), /empty/u);
});

test("editor command parsing preserves Windows paths, UNC prefixes, and empty arguments", () => {
  assert.deepEqual(
    parseEditorCommand(String.raw`"C:\Program Files\Editor\editor.cmd" --wait "" "C:\drafts\"`),
    [String.raw`C:\Program Files\Editor\editor.cmd`, "--wait", "", "C:\\drafts\\"],
  );
  assert.deepEqual(
    parseEditorCommand(String.raw`"\\server\share\Editor\editor.exe" --reuse-window`),
    [String.raw`\\server\share\Editor\editor.exe`, "--reuse-window"],
  );
  assert.deepEqual(parseEditorCommand(String.raw`C:\Tools\editor.exe`), [String.raw`C:\Tools\editor.exe`]);
});

test("external editor round-trips a private temporary prompt and cleans it up", async (context) => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "external-editor.mjs");
  const root = await mkdtemp(join(tmpdir(), "harness-editor-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const marker = join(root, "path.txt");
  const visual = `"${process.execPath}" "${fixture}"`;
  const result = await editTextExternally("initial", {
    environment: { ...process.env, VISUAL: visual, HARNESS_EDITOR_MARKER: marker },
  });
  assert.equal(result, "edited by fixture\n");
  const editedPath = await readFile(marker, "utf8");
  await assert.rejects(access(editedPath), /ENOENT/u);
});

test("the external-editor fixture rejects a missing target without rewriting itself", async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "external-editor.mjs");
  const before = await readFile(fixture, "utf8");
  const result = spawnSync(process.execPath, [fixture], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing editor path/u);
  assert.equal(await readFile(fixture, "utf8"), before);
});

test("external editor cancellation kills its process tree and removes the temporary prompt", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-editor-cancel-test-"));
  const fixture = join(root, "editor.cjs");
  const ready = join(root, "ready");
  const editorPid = join(root, "editor.pid");
  const childPid = join(root, "child.pid");
  const survived = join(root, "child-survived");
  const promptMarker = join(root, "prompt-path");
  const grandchild = `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1500);
    setInterval(() => {}, 1000);
  `;
  await writeFile(fixture, `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(editorPid)}, String(process.pid));
    writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
    writeFileSync(${JSON.stringify(promptMarker)}, process.argv.at(-1));
    writeFileSync(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1000);
  `);
  context.after(async () => {
    try { process.kill(-Number(await readFile(editorPid, "utf8")), "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  });

  const abort = new AbortController();
  const editing = editTextExternally("initial", {
    environment: {
      ...process.env,
      VISUAL: `"${process.execPath}" "${fixture}"`,
    },
    signal: abort.signal,
  });
  await waitForFile(ready);
  abort.abort(new Error("editor cancelled"));
  await assert.rejects(editing, /editor cancelled/u);
  const temporaryPrompt = await readFile(promptMarker, "utf8");
  await assert.rejects(access(temporaryPrompt), /ENOENT/u);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1600));
  await assert.rejects(access(survived), /ENOENT/u);
  const descendant = Number(await readFile(childPid, "utf8"));
  assert.throws(() => process.kill(descendant, 0), /ESRCH/u);
});
