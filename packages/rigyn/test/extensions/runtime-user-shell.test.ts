import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/tools/hash.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

async function loadFixture(
  context: { after(callback: () => Promise<void>): void },
  source: string,
) {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-user-shell-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadTestDirectExtensions([{
    extensionId: "user-shell-test",
    sourcePath,
    sha256: sha256(source),
    resourceRoot: root,
    scope: "project",
    trusted: true,
  }], { workspace: root });
  context.after(async () => await host.close());
  return { root, host };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for direct user-shell listener");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Direct user-shell operation did not settle")), 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test("user_bash preserves command visibility, isolates invalid results, and can handle execution", async (context) => {
  const source = `export default function activate(rigyn) {
    globalThis.__runtimeUserShellSeen = [];
    rigyn.on("user_bash", (event) => {
      globalThis.__runtimeUserShellSeen.push({ ...event, frozen: Object.isFrozen(event) });
      try { event.command = "forged"; } catch {}
      return { result: { output: "invalid", cancelled: "no", truncated: false } };
    });
    rigyn.on("user_bash", (event) => {
      globalThis.__runtimeUserShellSeen.push({ ...event, frozen: Object.isFrozen(event) });
      return {
        result: {
          output: "synthetic shell result",
          exitCode: 23,
          cancelled: false,
          truncated: true,
          fullOutputPath: "/tmp/rigyn-user-shell.log"
        }
      };
    });
  }`;
  const { root, host } = await loadFixture(context, source);

  const result = await host.reduceBeforeUserShell({ command: "original", cwd: root, hidden: true });

  assert.deepEqual(result, {
    action: "handled",
    command: "original",
    cwd: root,
    result: {
      text: "synthetic shell result",
      exitCode: 23,
      isError: true,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/tmp/rigyn-user-shell.log",
    },
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeUserShellSeen, [
    { type: "user_bash", command: "original", cwd: root, excludeFromContext: true, frozen: true },
    { type: "user_bash", command: "original", cwd: root, excludeFromContext: true, frozen: true },
  ]);
  assert.equal(host.diagnostics().filter((entry) => entry.message.includes("user_bash")).length, 1);
  delete (globalThis as Record<string, unknown>).__runtimeUserShellSeen;
});

test("user_bash operations are replaceable and pending listeners settle on cancellation or unload", async (context) => {
  const source = `export default function activate(rigyn) {
    globalThis.__runtimeUserShellWaits = 0;
    rigyn.on("user_bash", (event, context) => {
      if (!event.command.startsWith("wait")) {
        return { command: event.command + " transformed", cwd: event.cwd, operations: { async exec(command, cwd, options) {
          options.onData(Buffer.from(command + "@" + cwd));
          return { exitCode: 0 };
        } } };
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
  const callerRun = host.reduceBeforeUserShell(
    { command: "wait caller", cwd: root, hidden: false },
    cancelled.signal,
  );
  await waitFor(() => (globalThis as Record<string, unknown>).__runtimeUserShellWaits === 1);
  const callerRejection = assert.rejects(within(callerRun), /caller cancelled/u);
  cancelled.abort(new Error("caller cancelled"));
  await callerRejection;

  const ready = await host.reduceBeforeUserShell({ command: "ready", cwd: root, hidden: false });
  assert.equal(ready.action, "execute");
  assert.equal(ready.command, "ready transformed");
  assert.equal(typeof ready.operations?.exec, "function");
  const chunks: string[] = [];
  const execution = await ready.operations!.exec(ready.command, ready.cwd, {
    signal: new AbortController().signal,
    onData(chunk) { chunks.push(chunk.toString("utf8")); },
  });
  assert.deepEqual(execution, { exitCode: 0 });
  assert.deepEqual(chunks, [`ready transformed@${root}`]);

  const replacementRun = host.reduceBeforeUserShell({ command: "wait replacement", cwd: root, hidden: true });
  await waitFor(() => (globalThis as Record<string, unknown>).__runtimeUserShellWaits === 2);
  const replacementRejection = assert.rejects(within(replacementRun), /host (?:is )?closed/u);
  await host.close();
  await replacementRejection;
  delete (globalThis as Record<string, unknown>).__runtimeUserShellWaits;
});

test("user_bash preserves timeout and non-cancellation signal terminal states", async (context) => {
  const source = `export default function activate(rigyn) {
    rigyn.on("user_bash", (event) => ({
      result: event.command === "signal"
        ? {
            output: "signal preview",
            isError: false,
            cancelled: false,
            signal: "SIGTERM",
            truncated: false
          }
        : {
            output: "timeout preview",
            isError: false,
            cancelled: false,
            timedOut: true,
            truncated: false
          }
    }));
  }`;
  const { root, host } = await loadFixture(context, source);

  assert.deepEqual(
    await host.reduceBeforeUserShell({ command: "signal", cwd: root, hidden: false }),
    {
      action: "handled",
      command: "signal",
      cwd: root,
      result: {
        text: "signal preview",
        isError: true,
        cancelled: false,
        signal: "SIGTERM",
        exitCode: null,
      },
    },
  );
  assert.deepEqual(
    await host.reduceBeforeUserShell({ command: "timeout", cwd: root, hidden: false }),
    {
      action: "handled",
      command: "timeout",
      cwd: root,
      result: {
        text: "timeout preview",
        isError: true,
        cancelled: false,
        timedOut: true,
        exitCode: null,
      },
    },
  );
});

test("native user_bash handled output is rejected beyond the shared 1 MiB boundary", async (context) => {
  const source = `export default function activate(rigyn) {
    rigyn.on("user_bash", () => ({
      result: {
        output: "x".repeat((1024 * 1024) + 1),
        exitCode: 0,
        cancelled: false,
        truncated: false
      }
    }));
  }`;
  const { root, host } = await loadFixture(context, source);

  assert.deepEqual(
    await host.reduceBeforeUserShell({ command: "bounded", cwd: root, hidden: false }),
    { action: "execute", command: "bounded", cwd: root },
  );
  assert.match(
    host.diagnostics().find((entry) => entry.message.includes("user_bash"))?.message ?? "",
    /1048576 bytes/u,
  );
});
