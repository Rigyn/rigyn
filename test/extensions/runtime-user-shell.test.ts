import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { sha256 } from "../../src/tools/hash.js";

async function loadFixture(
  context: { after(callback: () => Promise<void>): void },
  source: string,
) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-user-shell-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "user-shell-test",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  context.after(async () => await host.close());
  return { root, host };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime user-shell listener");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Runtime user-shell operation did not settle")), 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test("before_user_shell chains transforms, preserves hidden, and can prevent execution", async (context) => {
  const source = `export default function activate(api) {
    globalThis.__runtimeUserShellSeen = [];
    api.on("before_user_shell", (event) => {
      globalThis.__runtimeUserShellSeen.push({ ...event, frozen: Object.isFrozen(event) });
      try { event.hidden = false; } catch {}
      return { action: "transform", command: event.command + ":transformed", cwd: event.cwd + ${JSON.stringify(sep)} + "nested" };
    });
    api.on("before_user_shell", () => ({ action: "continue", command: "silently ignored typo" }));
    api.on("before_user_shell", () => ({ action: "transform" }));
    api.on("before_user_shell", (event) => {
      globalThis.__runtimeUserShellSeen.push({ ...event, frozen: Object.isFrozen(event) });
      return { action: "handled", result: { text: "synthetic shell result", exitCode: 23, signal: "TEST" } };
    });
  }`;
  const { root, host } = await loadFixture(context, source);
  await mkdir(join(root, "nested"));

  const result = await host.reduceBeforeUserShell({ command: "original", cwd: root, hidden: true });

  assert.deepEqual(result, {
    action: "handled",
    command: "original:transformed",
    cwd: join(root, "nested"),
    result: { text: "synthetic shell result", exitCode: 23, signal: "TEST" },
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeUserShellSeen, [
    { command: "original", cwd: root, hidden: true, frozen: true },
    { command: "original:transformed", cwd: join(root, "nested"), hidden: true, frozen: true },
  ]);
  assert.equal(host.diagnostics().filter((entry) => entry.message.includes("before_user_shell")).length, 2);
  delete (globalThis as Record<string, unknown>).__runtimeUserShellSeen;
});

test("before_user_shell aborts promptly for caller cancellation and extension replacement", async (context) => {
  const source = `export default function activate(api) {
    globalThis.__runtimeUserShellWaits = 0;
    api.on("before_user_shell", (event, context) => {
      if (!event.command.startsWith("wait")) {
        return { action: "handled", result: { text: "recovered", exitCode: 0 } };
      }
      globalThis.__runtimeUserShellWaits += 1;
      return new Promise((resolve, reject) => {
        const abort = () => reject(context.signal.reason || new Error("listener cancelled"));
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      });
    });
  }`;
  const { root, host } = await loadFixture(context, source);
  const cancelled = new AbortController();
  const callerRun = host.reduceBeforeUserShell({ command: "wait caller", cwd: root, hidden: false }, cancelled.signal);
  await waitFor(() => (globalThis as Record<string, unknown>).__runtimeUserShellWaits === 1);
  const callerRejection = assert.rejects(within(callerRun), /caller cancelled/u);
  cancelled.abort(new Error("caller cancelled"));
  await callerRejection;

  assert.deepEqual(await host.reduceBeforeUserShell({ command: "ready", cwd: root, hidden: false }), {
    action: "handled",
    command: "ready",
    cwd: root,
    result: { text: "recovered", exitCode: 0 },
  });

  const replacementRun = host.reduceBeforeUserShell({ command: "wait replacement", cwd: root, hidden: true });
  await waitFor(() => (globalThis as Record<string, unknown>).__runtimeUserShellWaits === 2);
  const replacementRejection = assert.rejects(within(replacementRun), /host closed/u);
  await host.close();
  await replacementRejection;
  delete (globalThis as Record<string, unknown>).__runtimeUserShellWaits;
});
