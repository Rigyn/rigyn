import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { TrustStore, TrustStoreError } from "../../src/config/trust.js";

const FIXED_TIME = "2026-07-10T12:00:00.000Z";

test("trust store uses canonical entries, private permissions, and atomic cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-private-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const directory = join(root, "state");
  const path = join(directory, "trust.json");
  await mkdir(workspace);
  await mkdir(directory, { mode: 0o755 });
  const canonical = await realpath(workspace);
  await writeFile(path, JSON.stringify({
    version: 1,
    workspaces: { [canonical]: { trustedAt: FIXED_TIME } },
  }), { mode: 0o644 });

  const store = new TrustStore(path);
  assert.deepEqual(await store.list(), [{ workspace: canonical, trustedAt: FIXED_TIME }]);
  assert.equal(await store.decision(workspace), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  await store.untrust(workspace);
  assert.equal(await store.isTrusted(workspace), false);
  await store.trust(workspace);
  assert.equal(await store.isTrusted(workspace), true);
  const persisted = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    workspaces: Record<string, { decision: string; decidedAt: string }>;
  };
  assert.equal(persisted.version, 2);
  assert.deepEqual(Object.keys(persisted.workspaces), [canonical]);
  assert.equal(persisted.workspaces[canonical]!.decision, "trusted");
  assert.equal(new Date(persisted.workspaces[canonical]!.decidedAt).toISOString(), persisted.workspaces[canonical]!.decidedAt);
  assert.deepEqual(await readdir(directory), ["trust.json"]);
});

test("exact untrusted decisions are canonical, durable, and override recursive parent trust", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-denied-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "projects");
  const workspace = join(parent, "one");
  const sibling = join(parent, "two");
  await mkdir(workspace, { recursive: true });
  await mkdir(sibling);
  const store = new TrustStore(join(root, "state", "trust.json"));

  await store.trustDescendants(parent);
  assert.equal(await store.decision(workspace), true);
  await store.deny(workspace);
  assert.equal(await store.decision(workspace), false);
  assert.equal(await store.isTrusted(workspace), false);
  assert.equal(await store.isTrusted(sibling), true);

  if (process.platform !== "win32") {
    const alias = join(root, "workspace-alias");
    await symlink(workspace, alias, "dir");
    assert.equal(await store.decision(alias), false);
  }
  const decisions = await store.listDecisions();
  assert.deepEqual(decisions.map(({ workspace: path, decision, descendants }) => ({ path, decision, descendants })), [
    { path: await realpath(parent), decision: true, descendants: true },
    { path: await realpath(workspace), decision: false, descendants: undefined },
  ]);
  await assert.rejects(store.untrust(workspace), /inherits trust from/u);
  assert.equal(await store.decision(workspace), false);
});

test("recursive trust is explicit, inherited by descendants, and revocable at its parent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-descendants-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "projects");
  const child = join(parent, "one", "nested");
  const sibling = join(root, "outside");
  const store = new TrustStore(join(root, "state", "trust.json"));
  await mkdir(child, { recursive: true });
  await mkdir(sibling);

  await store.trust(parent);
  assert.equal(await store.isTrusted(parent), true);
  assert.equal(await store.isTrusted(child), false);
  await store.trustDescendants(parent);
  assert.equal(await store.isTrusted(child), true);
  assert.equal(await store.isTrusted(sibling), false);
  const listed = await store.list();
  assert.deepEqual(listed, [{
    workspace: await realpath(parent),
    trustedAt: listed[0]!.trustedAt,
    descendants: true,
  }]);

  await assert.rejects(store.untrust(child), /inherits trust from/u);
  assert.equal(await store.isTrusted(child), true);
  await store.untrust(parent);
  assert.equal(await store.isTrusted(child), false);
  await assert.rejects(store.trustDescendants("/"), /root cannot be trusted recursively/u);
});

test("trust store rejects corrupt, oversized, non-canonical, and over-count data", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-bounds-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const validWorkspace = join(root, "workspace");

  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "{", { mode: 0o600 });
  await assert.rejects(
    new TrustStore(malformed).list(),
    (error: unknown) => error instanceof TrustStoreError && /valid JSON/u.test(error.message),
  );

  const invalidTimestamp = join(root, "timestamp.json");
  await writeFile(invalidTimestamp, JSON.stringify({
    version: 1,
    workspaces: { [validWorkspace]: { trustedAt: "not-a-timestamp" } },
  }), { mode: 0o600 });
  await assert.rejects(new TrustStore(invalidTimestamp).list(), /invalid entry/u);

  const invalidDescendants = join(root, "descendants.json");
  await writeFile(invalidDescendants, JSON.stringify({
    version: 1,
    workspaces: { [validWorkspace]: { trustedAt: FIXED_TIME, descendants: false } },
  }), { mode: 0o600 });
  await assert.rejects(new TrustStore(invalidDescendants).list(), /invalid entry/u);

  const invalidDecision = join(root, "decision.json");
  await writeFile(invalidDecision, JSON.stringify({
    version: 2,
    workspaces: { [validWorkspace]: { decision: "maybe", decidedAt: FIXED_TIME } },
  }), { mode: 0o600 });
  await assert.rejects(new TrustStore(invalidDecision).listDecisions(), /invalid entry/u);

  const deniedDescendants = join(root, "denied-descendants.json");
  await writeFile(deniedDescendants, JSON.stringify({
    version: 2,
    workspaces: { [validWorkspace]: { decision: "untrusted", decidedAt: FIXED_TIME, descendants: true } },
  }), { mode: 0o600 });
  await assert.rejects(new TrustStore(deniedDescendants).listDecisions(), /invalid entry/u);

  const recursiveRoot = join(root, "recursive-root.json");
  await writeFile(recursiveRoot, JSON.stringify({
    version: 1,
    workspaces: { [parse(root).root]: { trustedAt: FIXED_TIME, descendants: true } },
  }), { mode: 0o600 });
  await assert.rejects(new TrustStore(recursiveRoot).list(), /invalid entry/u);

  const invalidPath = join(root, "path.json");
  await writeFile(invalidPath, JSON.stringify({
    version: 1,
    workspaces: { relative: { trustedAt: FIXED_TIME } },
  }), { mode: 0o600 });
  await assert.rejects(new TrustStore(invalidPath).list(), /invalid workspace path/u);

  const tooMany = join(root, "count.json");
  const workspaces = Object.fromEntries(Array.from(
    { length: 4097 },
    (_, index) => [join(root, `workspace-${index}`), { trustedAt: FIXED_TIME }],
  ));
  await writeFile(tooMany, JSON.stringify({ version: 1, workspaces }), { mode: 0o600 });
  await assert.rejects(new TrustStore(tooMany).list(), /4096 workspace limit/u);

  const oversized = join(root, "oversized.json");
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(new TrustStore(oversized).list(), /byte size limit/u);

  const invalidUtf8 = join(root, "encoding.json");
  await writeFile(invalidUtf8, Buffer.from([0xff]), { mode: 0o600 });
  await assert.rejects(new TrustStore(invalidUtf8).list(), /valid UTF-8/u);
});

test("trust store rejects writable state before consuming potentially tampered trust", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-writable-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const valid = JSON.stringify({ version: 1, workspaces: { "/injected": { trustedAt: FIXED_TIME } } });

  const writableDirectory = join(root, "writable-directory");
  await mkdir(writableDirectory);
  await chmod(writableDirectory, 0o770);
  await writeFile(join(writableDirectory, "trust.json"), valid, { mode: 0o600 });
  await assert.rejects(
    new TrustStore(join(writableDirectory, "trust.json")).list(),
    /directory must not be group- or world-writable/u,
  );

  const writableFile = join(root, "writable-file.json");
  await writeFile(writableFile, valid, { mode: 0o600 });
  await chmod(writableFile, 0o660);
  await assert.rejects(new TrustStore(writableFile).list(), /must not be group- or world-writable/u);
});

test("a deleted workspace can be revoked before replacement content appears", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-revoke-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const store = new TrustStore(join(root, "state", "trust.json"));
  await mkdir(workspace);
  await store.trust(workspace);
  await rm(workspace, { recursive: true, force: true });
  await store.untrust(workspace);
  await mkdir(workspace);
  assert.equal(await store.isTrusted(workspace), false);
  assert.deepEqual(await store.list(), []);
});

test("trust lock rejects impossible PIDs and recovers an expired owner identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-lock-record-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const directory = join(root, "state");
  const path = join(directory, "trust.json");
  await mkdir(workspace);
  await mkdir(directory, { mode: 0o700 });
  const information = await stat(directory);
  const comparableName = "trust.json".normalize("NFC").toLowerCase();
  const key = createHash("sha256")
    .update(`${information.dev}:${information.ino}\0${comparableName}`)
    .digest("hex")
    .slice(0, 32);
  const lockPath = join(directory, `.trust-store-${key}.lock`);
  const invalid = { version: 1, pid: Number.MAX_SAFE_INTEGER, token: "a".repeat(32), createdAt: Date.now() };
  await writeFile(lockPath, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
  const startedAt = performance.now();
  await assert.rejects(new TrustStore(path).trust(workspace), /lock is corrupt/u);
  assert.ok(performance.now() - startedAt < 1_000, "an impossible PID must not force the lock timeout");

  await rm(lockPath);
  const expired = {
    version: 1,
    pid: process.pid,
    token: "b".repeat(32),
    createdAt: Date.now() - 5 * 60_000 - 1,
  };
  await writeFile(lockPath, `${JSON.stringify(expired)}\n`, { mode: 0o600 });
  await writeFile(
    join(directory, `.trust-store-${key}.123.${"c".repeat(32)}.tmp`),
    "partial crash output",
    { mode: 0o600 },
  );
  const store = new TrustStore(path);
  await store.trust(workspace);
  assert.equal(await store.isTrusted(workspace), true);
  assert.deepEqual(await readdir(directory), ["trust.json"]);
});

test("trust store rejects symbolic and non-regular state paths", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-paths-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify({ version: 1, workspaces: {} }), { mode: 0o644 });
  const targetMode = (await stat(target)).mode & 0o777;
  const linkedFile = join(root, "linked.json");
  await symlink(target, linkedFile);
  await assert.rejects(new TrustStore(linkedFile).list(), /non-symbolic regular file/u);
  assert.equal((await stat(target)).mode & 0o777, targetMode, "rejecting a symlink must not chmod its target");

  const directoryAtFile = join(root, "directory.json");
  await mkdir(directoryAtFile);
  await assert.rejects(new TrustStore(directoryAtFile).list(), /non-symbolic regular file/u);

  const fifo = join(root, "fifo.json");
  const fifoResult = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(fifoResult.status, 0, fifoResult.stderr);
  await assert.rejects(new TrustStore(fifo).list(), /non-symbolic regular file/u);

  const actualDirectory = join(root, "actual-state");
  const linkedDirectory = join(root, "linked-state");
  await mkdir(actualDirectory, { mode: 0o755 });
  const actualDirectoryMode = (await stat(actualDirectory)).mode & 0o777;
  await symlink(actualDirectory, linkedDirectory, "dir");
  await assert.rejects(
    new TrustStore(join(linkedDirectory, "trust.json")).trust(workspace),
    /directory.*symbolic link|directory.*regular directory/u,
  );
  assert.equal((await stat(actualDirectory)).mode & 0o777, actualDirectoryMode, "rejecting a directory symlink must not chmod its target");
  assert.deepEqual(await readdir(actualDirectory), []);
});

test("independent processes serialize mixed trust and untrust updates", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-concurrent-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "trust.json");
  const gate = join(root, "gate");
  const remove: string[] = [];
  const keep: string[] = [];
  const add: string[] = [];
  for (const [group, count] of [[remove, 8], [keep, 4], [add, 8]] as const) {
    for (let index = 0; index < count; index += 1) {
      const workspace = join(root, `workspace-${remove.length}-${keep.length}-${add.length}`);
      await mkdir(workspace);
      group.push(await realpath(workspace));
    }
  }

  const store = new TrustStore(path);
  for (const workspace of [...remove, ...keep]) await store.trust(workspace);
  const aliasRoot = join(root, "alias");
  if (process.platform !== "win32") await symlink(root, aliasRoot, "dir");
  const aliasPath = process.platform === "win32" ? path : join(aliasRoot, "state", "trust.json");

  const workers = [
    ...remove.map((workspace, index) => startWorker(index % 2 === 0 ? path : aliasPath, workspace, "untrust", gate, join(root, `ready-remove-${index}`))),
    ...add.map((workspace, index) => startWorker(index % 2 === 0 ? aliasPath : path, workspace, "trust", gate, join(root, `ready-add-${index}`))),
  ];
  await Promise.all(workers.map(async (worker) => await waitUntilPresent(worker.ready)));
  await writeFile(gate, "go", { mode: 0o600 });
  await Promise.all(workers.map(async (worker) => await worker.done));

  assert.deepEqual(
    (await store.list()).map((entry) => entry.workspace).sort(),
    [...keep, ...add].sort(),
  );
  assert.deepEqual(await readdir(join(root, "state")), ["trust.json"]);
});

function startWorker(
  path: string,
  workspace: string,
  action: "trust" | "untrust",
  gate: string,
  ready: string,
): { done: Promise<void>; ready: string } {
  const source = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { TrustStore } from ${JSON.stringify(new URL("../../src/config/trust.ts", import.meta.url).href)};
    await writeFile(process.env.READY, "ready");
    while (true) {
      try { await access(process.env.GATE); break; }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await delay(5);
      }
    }
    const store = new TrustStore(process.env.TRUST_PATH);
    if (process.env.ACTION === "trust") await store.trust(process.env.WORKSPACE);
    else await store.untrust(process.env.WORKSPACE);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, ACTION: action, GATE: gate, READY: ready, TRUST_PATH: path, WORKSPACE: workspace },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`trust worker exited ${String(code)}: ${stdout}${stderr}`));
    });
  });
  return { done, ready };
}

async function waitUntilPresent(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await delay(10);
    }
  }
}
