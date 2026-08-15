import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdtemp, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneToolOutputFiles, ToolOutputAccumulator } from "../../src/tools/output-accumulator.js";

test("full tool output uses a private directory and exclusive private file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-private-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await chmod(root, 0o777);

  const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 2 });
  output.append(Buffer.from("one\ntwo\nthree\n"));
  output.finish();
  const activeSnapshot = output.snapshot(true);
  assert.equal(activeSnapshot.fullOutputPath, undefined);
  assert.match((await readdir(root))[0] ?? "", /^\.rigyn-active-/u);
  await output.close();
  const snapshot = output.snapshot();

  assert.ok(snapshot.fullOutputPath?.startsWith(join(root, "rigyn-")));
  assert.deepEqual(await readdir(root), [snapshot.fullOutputPath!.slice(root.length + 1)]);
  assert.equal((await lstat(root)).mode & 0o777, process.platform === "win32" ? (await lstat(root)).mode & 0o777 : 0o700);
  if (process.platform !== "win32") assert.equal((await lstat(snapshot.fullOutputPath!)).mode & 0o777, 0o600);
});

test("full tool output is explicitly capped while the bounded tail remains available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-cap-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const output = new ToolOutputAccumulator({
    directory: root,
    maxBytes: 4,
    maxLines: 1,
    maxPersistedBytes: 5,
  });
  output.append(Buffer.from("first\nsecond\n"));
  output.finish();
  output.snapshot(true);
  await output.close();
  const snapshot = output.snapshot();
  assert.equal(snapshot.fullOutputTruncated, true);
  assert.equal(snapshot.content, "cond");
  assert.equal((await lstat(snapshot.fullOutputPath!)).size, 5);
});

test("finalization refreshes an old active mtime before closed-file pruning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-publish-age-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 1 });
  output.append(Buffer.from("first\nsecond\n"));
  output.finish();
  output.snapshot(true);
  const active = (await readdir(root)).find((name) => name.startsWith(".rigyn-active-"));
  assert.ok(active);
  await utimes(join(root, active), new Date(0), new Date(0));

  await output.close();
  const published = output.snapshot().fullOutputPath;
  assert.equal(typeof published, "string");
  assert.equal((await lstat(published!)).isFile(), true);
});

test("failed finalization removes both the unpublished active file and a linked final name", () => {
  const moduleUrl = new URL("../../src/tools/output-accumulator.ts", import.meta.url).href;
  const source = `
    import { mkdtempSync, readdirSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { ToolOutputAccumulator } from ${JSON.stringify(moduleUrl)};
    const root = mkdtempSync(join(tmpdir(), "rigyn-output-publish-failure-"));
    try {
      const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 1 });
      output.append(Buffer.from("first\\nsecond\\n"));
      output.finish();
      output.snapshot(true);
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate { constructor() { throw new Error("injected clock failure"); } };
      await output.close();
      globalThis.Date = NativeDate;
      const snapshot = output.snapshot();
      if (snapshot.fullOutputPath !== undefined || snapshot.fullOutputUnavailable !== true) {
        throw new Error("failed publication was advertised");
      }
      if (readdirSync(root).some((name) => name.endsWith(".log") || name.startsWith(".rigyn-active-"))) {
        throw new Error("failed publication leaked an output artifact");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    encoding: "utf8",
    cwd: join(import.meta.dirname, "../../.."),
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("admission reserves the full per-file allowance and reports unavailable output at aggregate capacity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-admission-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 8; index += 1) {
    await writeFile(
      join(root, `.rigyn-active-${process.pid}-67108864-${String(index).padStart(32, "0")}-rigyn-bash-${String(index).padStart(16, "0")}.log.part`),
      "",
      { mode: 0o600 },
    );
  }

  const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 1 });
  output.append(Buffer.from("first\nsecond\n"));
  output.finish();
  const snapshot = output.snapshot(true);
  await output.close();

  assert.equal(snapshot.truncation.truncated, true);
  assert.equal(snapshot.fullOutputPath, undefined);
  assert.equal(snapshot.fullOutputTruncated, true);
  assert.equal(snapshot.fullOutputUnavailable, true);
  assert.equal((await readdir(root)).filter((name) => name.startsWith(".rigyn-active-")).length, 8);
});

test("retention keeps live active files and reaps only definitely dead active creators", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-active-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const live = `.rigyn-active-${process.pid}-64-${"a".repeat(32)}-rigyn-bash-${"1".repeat(16)}.log.part`;
  const dead = `.rigyn-active-2147483647-64-${"b".repeat(32)}-rigyn-bash-${"2".repeat(16)}.log.part`;
  await writeFile(join(root, live), "live", { mode: 0o600 });
  await writeFile(join(root, dead), "dead", { mode: 0o600 });

  pruneToolOutputFiles({ directory: root });

  assert.deepEqual(await readdir(root), [live]);
});

test("the persisted per-file reservation cannot exceed the hard 64 MiB boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-file-cap-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  assert.throws(
    () => new ToolOutputAccumulator({ directory: root, maxPersistedBytes: 64 * 1024 * 1024 + 1 }),
    /must not exceed 67108864 bytes/u,
  );
  assert.throws(
    () => new ToolOutputAccumulator({ directory: root, prefix: "foreign" }),
    /prefix is invalid/u,
  );
});

test("retention-lock contention refuses persistence without failing the command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-lock-contention-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const lock = join(root, ".rigyn-retention.lock");
  await writeFile(lock, `${JSON.stringify({ pid: process.pid, token: "a".repeat(32) })}\n`, { mode: 0o600 });

  const started = performance.now();
  const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 1 });
  output.append(Buffer.from("first\nsecond\n"));
  output.finish();
  const snapshot = output.snapshot(true);
  await output.close();

  assert.equal(snapshot.content, "cond");
  assert.equal(snapshot.fullOutputUnavailable, true);
  assert.equal(snapshot.fullOutputTruncated, true);
  assert.equal(snapshot.fullOutputPath, undefined);
  assert.ok(performance.now() - started < 250);
});

test("a definitely dead retention lock is recovered in place", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-dead-lock-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const lock = join(root, ".rigyn-retention.lock");
  await writeFile(lock, `${JSON.stringify({ pid: 2147483647, token: "b".repeat(32) })}\n`, { mode: 0o600 });

  const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 1 });
  output.append(Buffer.from("first\nsecond\n"));
  output.finish();
  output.snapshot(true);
  await output.close();

  assert.match(output.snapshot().fullOutputPath ?? "", /rigyn-bash-[a-f0-9]{16}\.log$/u);
});

test("dead staged retention controls are reaped before and after canonical lock publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-staged-lock-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const pid = 2147483647;
  const token = "d".repeat(32);
  const staged = join(root, `.rigyn-retention-owner-${pid}-${token}.tmp`);
  const lock = join(root, ".rigyn-retention.lock");
  await writeFile(staged, "{", { mode: 0o600 });

  pruneToolOutputFiles({ directory: root });
  assert.deepEqual(await readdir(root), []);

  await writeFile(staged, `${JSON.stringify({ pid, token })}\n`, { mode: 0o600 });
  await link(staged, lock);
  pruneToolOutputFiles({ directory: root });
  assert.deepEqual(await readdir(root), []);
});

test("an unsafe replacement at the lock path is never deleted", () => {
  const moduleUrl = new URL("../../src/tools/output-accumulator.ts", import.meta.url).href;
  const source = `
    import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { pruneToolOutputFiles } from ${JSON.stringify(moduleUrl)};
    const root = mkdtempSync(join(tmpdir(), "rigyn-lock-foreign-"));
    const lock = join(root, ".rigyn-retention.lock");
    mkdirSync(lock, { mode: 0o700 });
    const injected = join(lock, "foreign.keep");
    writeFileSync(injected, "keep", { mode: 0o600 });
    let failed = false;
    try { pruneToolOutputFiles({ directory: root }); } catch { failed = true; }
    if (!failed || !existsSync(injected)) throw new Error("foreign lock entry was removed");
    rmSync(root, { recursive: true, force: true });
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    encoding: "utf8",
    cwd: join(import.meta.dirname, "../../.."),
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("concurrent processes admit at most the remaining aggregate reservation and never prune live active output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-multiprocess-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 7; index += 1) {
    const path = join(root, `rigyn-bash-${String(index).padStart(16, "0")}.log`);
    await writeFile(path, "", { mode: 0o600 });
    await truncate(path, 64 * 1024 * 1024);
  }
  const moduleUrl = new URL("../../src/tools/output-accumulator.ts", import.meta.url).href;
  const source = `
    import { readdirSync } from "node:fs";
    import { ToolOutputAccumulator } from ${JSON.stringify(moduleUrl)};
    const directory = process.argv[1];
    const output = new ToolOutputAccumulator({ directory, maxBytes: 4, maxLines: 1 });
    output.append(Buffer.from("first\\nsecond\\n"));
    output.finish();
    const before = output.snapshot(true);
    const active = readdirSync(directory).find((name) => name.includes(String(process.pid)) && name.startsWith(".rigyn-active-"));
    process.stdout.write(JSON.stringify({ phase: "ready", active, unavailable: before.fullOutputUnavailable === true }) + "\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    await output.close();
    const after = output.snapshot();
    process.stdout.write(JSON.stringify({ phase: "closed", path: after.fullOutputPath, unavailable: after.fullOutputUnavailable === true }) + "\\n");
  `;
  const children = [0, 1].map(() => spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source, root],
    { cwd: join(import.meta.dirname, "../../.."), stdio: ["pipe", "pipe", "pipe"] },
  ));
  t.after(() => {
    for (const child of children) child.kill();
  });
  const nextLine = (child: (typeof children)[number]): Promise<Record<string, unknown>> => new Promise((resolveLine, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      child.stdout.off("data", onData);
      resolveLine(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`spill child exited ${code}`));
    });
  });

  const ready = await Promise.all(children.map(nextLine));
  assert.equal(ready.filter((entry) => typeof entry.active === "string").length, 1);
  assert.equal(ready.filter((entry) => entry.unavailable === true).length, 1);
  const activeBefore = (await readdir(root)).filter((name) => name.startsWith(".rigyn-active-"));
  assert.equal(activeBefore.length, 1);
  const closedBefore = await Promise.all((await readdir(root)).filter((name) => /^rigyn-.*\.log$/u.test(name)).map(
    async (name) => (await lstat(join(root, name))).size,
  ));
  const activeReservations = activeBefore.reduce((total, name) => {
    const match = /^\.rigyn-active-[1-9][0-9]*-([1-9][0-9]*)-/u.exec(name);
    assert.ok(match);
    return total + Number(match[1]);
  }, 0);
  assert.ok(activeReservations + closedBefore.reduce((total, bytes) => total + bytes, 0) <= 512 * 1024 * 1024);

  pruneToolOutputFiles({ directory: root });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".rigyn-active-")), activeBefore);

  const closedPromises = children.map(nextLine);
  for (const child of children) child.stdin.write("close\n");
  const closed = await Promise.all(closedPromises);
  assert.equal(closed.filter((entry) => typeof entry.path === "string").length, 1);
  assert.equal(closed.filter((entry) => entry.unavailable === true).length, 1);
  const published = closed.find((entry) => typeof entry.path === "string")?.path;
  assert.equal(typeof published, "string");
  assert.equal((await lstat(published as string)).isFile(), true);
  assert.equal((await readdir(root)).some((name) => name.startsWith(".rigyn-active-")), false);
});

test("an output stream failure degrades to a bounded unavailable snapshot", { skip: process.platform !== "linux" }, () => {
  const moduleUrl = new URL("../../src/tools/output-accumulator.ts", import.meta.url).href;
  const source = `
    import { closeSync, mkdtempSync, readlinkSync, readdirSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { ToolOutputAccumulator } from ${JSON.stringify(moduleUrl)};

    const root = mkdtempSync(join(tmpdir(), "rigyn-output-stream-error-"));
    try {
      const output = new ToolOutputAccumulator({ directory: root, maxBytes: 1, maxLines: 1 });
      output.append(Buffer.from("first"));
      await new Promise((resolve) => setImmediate(resolve));
      output.snapshot(true);
      const activeName = readdirSync(root).find((name) => name.startsWith(".rigyn-active-"));
      if (activeName === undefined) throw new Error("active output file was not created");
      const path = join(root, activeName);
      const descriptor = readdirSync("/proc/self/fd")
        .map(Number)
        .find((fd) => {
          try { return readlinkSync(\`/proc/self/fd/\${fd}\`) === path; }
          catch { return false; }
        });
      if (descriptor === undefined) throw new Error("output descriptor was not found");
      closeSync(descriptor);
      output.append(Buffer.from("second"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await output.close();
      const snapshot = output.snapshot();
      if (snapshot.fullOutputPath !== undefined
        || snapshot.fullOutputUnavailable !== true
        || snapshot.fullOutputTruncated !== true
        || !snapshot.truncation.truncated) {
        throw new Error("stream failure did not degrade to bounded unavailable output");
      }
      if (readdirSync(root).some((name) => name.startsWith(".rigyn-active-"))) {
        throw new Error("stream failure leaked active output");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    encoding: "utf8",
    cwd: join(import.meta.dirname, "../../.."),
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("tool output cleanup removes expired and excess files but never follows links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-prune-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "harness-output-outside-"));
  const outside = join(outsideRoot, "secret");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  await writeFile(outside, "keep", { mode: 0o600 });
  const old = join(root, "rigyn-bash-0000000000000001.log");
  const newer = join(root, "rigyn-bash-0000000000000002.log");
  await writeFile(old, "old", { mode: 0o600 });
  await writeFile(newer, "new", { mode: 0o600 });
  await symlink(outside, join(root, "rigyn-bash-0000000000000003.log"));
  await utimes(old, new Date(1_000), new Date(1_000));
  await utimes(newer, new Date(2_000), new Date(2_000));

  const result = pruneToolOutputFiles({ directory: root, now: 3_000, maxAgeMs: 10_000, maxFiles: 1, maxTotalBytes: 1_024 });
  assert.equal(result.removedFiles, 1);
  assert.deepEqual((await readdir(root)).sort(), [
    "rigyn-bash-0000000000000002.log",
    "rigyn-bash-0000000000000003.log",
  ]);
  assert.equal((await lstat(outside)).size, 4);
});
