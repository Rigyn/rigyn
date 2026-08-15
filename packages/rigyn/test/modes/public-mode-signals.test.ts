import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Public mode signal fixture timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test("public RPC mode disposes its runtime and exits on SIGINT", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-public-mode-signal-"));
  const fixture = fileURLToPath(new URL("../fixtures/public-mode-signal-host.mts", import.meta.url));
  const children: ChildProcess[] = [];
  context.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });

  const ready = join(root, "rpc-ready");
  const disposed = join(root, "rpc-disposed");
  const child = spawn(process.execPath, ["--import", "tsx", fixture, "rpc"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RIGYN_MODE_READY: ready,
      RIGYN_MODE_DISPOSED: disposed,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  await waitForFile(ready);
  assert.equal(child.kill("SIGINT"), true);
  assert.deepEqual(await waitForExit(child), { code: 130, signal: null });
  assert.equal(await readFile(disposed, "utf8"), "disposed");
});

test("public print mode leaves process signal and exit ownership to its embedded host", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-public-print-host-signal-"));
  const fixture = fileURLToPath(new URL("../fixtures/public-mode-signal-host.mts", import.meta.url));
  const ready = join(root, "print-ready");
  const disposed = join(root, "print-disposed");
  const child = spawn(process.execPath, ["--import", "tsx", fixture, "print"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RIGYN_MODE_READY: ready,
      RIGYN_MODE_DISPOSED: disposed,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  await waitForFile(ready);
  assert.equal(child.kill("SIGINT"), true);
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
  assert.equal(await readFile(ready, "utf8"), "handled-by-host");
  assert.equal(await readFile(disposed, "utf8"), "disposed");
});
