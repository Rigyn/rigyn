import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { keyedSqliteLeasePath, withSqliteProcessLease } from "../../src/process/sqlite-lease.js";

test("SQLite process leases serialize operations and honor cancellation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-process-lease-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "operation.lock.sqlite3");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const first = withSqliteProcessLease(path, async () => {
    firstEntered();
    await gate;
    return "first";
  }, { timeoutMs: 2_000, retryMs: 5, label: "fixture lock" });
  await entered;

  const controller = new AbortController();
  const cancelled = withSqliteProcessLease(path, async () => "unexpected", {
    timeoutMs: 2_000,
    retryMs: 5,
    label: "fixture lock",
  }, controller.signal);
  setTimeout(() => controller.abort(new Error("cancel fixture lease")), 20);
  await assert.rejects(cancelled, /cancel fixture lease/u);

  let secondEntered = false;
  const second = withSqliteProcessLease(path, async () => {
    secondEntered = true;
    return "second";
  }, { timeoutMs: 2_000, retryMs: 5, label: "fixture lock" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(secondEntered, false);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
});

test("SQLite process leases recover immediately after their owner process exits", {
  skip: process.platform === "win32" ? "SIGKILL fixture requires POSIX signal delivery" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-process-lease-crash-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "operation.lock.sqlite3");
  const moduleUrl = pathToFileURL(new URL("../../src/process/sqlite-lease.ts", import.meta.url).pathname).href;
  const source = `
    import { withSqliteProcessLease } from ${JSON.stringify(moduleUrl)};
    await withSqliteProcessLease(${JSON.stringify(path)}, async () => {
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }, { timeoutMs: 2000, retryMs: 5, label: "crash fixture" });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not acquire the fixture lease")), 2_000);
    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("locked")) return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const startedAt = Date.now();
  const value = await withSqliteProcessLease(path, async () => "recovered", {
    timeoutMs: 2_000,
    retryMs: 5,
    label: "crash fixture",
  });
  assert.equal(value, "recovered");
  assert.ok(Date.now() - startedAt < 500, "crashed owner left a stale wait behind");
});

test("SQLite process leases reject a writable shared path boundary", {
  skip: process.platform === "win32" ? "POSIX ownership and mode check" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-process-lease-boundary-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const shared = join(root, "shared");
  const leases = join(shared, "leases");
  await mkdir(leases, { recursive: true, mode: 0o700 });
  await chmod(shared, 0o777);
  await assert.rejects(
    withSqliteProcessLease(join(leases, "operation.sqlite3"), async () => undefined, {
      timeoutMs: 1_000,
      label: "unsafe fixture",
    }),
    /writable shared ancestor/u,
  );
});

test("keyed SQLite leases use canonical filesystem identity", {
  skip: process.platform === "win32" ? "directory symlink fixture requires POSIX" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-process-lease-identity-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  const leases = join(root, "leases");
  await mkdir(workspace);
  await symlink(workspace, alias);
  assert.equal(
    await keyedSqliteLeasePath(leases, "project-packages", workspace),
    await keyedSqliteLeasePath(leases, "project-packages", alias),
  );
});
