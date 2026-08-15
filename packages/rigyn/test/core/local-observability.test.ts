import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  acquireProcessLocalObservabilitySink,
  LocalJsonlObservabilitySink,
  MAX_DIRECTORY_SCAN_ENTRIES,
  listLocalObservabilityFiles,
  scanLocalObservabilityFile,
} from "../../src/core/local-observability.js";
import { RuntimeObservability, type ObservabilityRecord } from "../../src/core/observability.js";

function record(index: number, payload = "ok"): ObservabilityRecord {
  return {
    schemaVersion: 1,
    kind: "event",
    timestamp: "2026-08-08T12:00:00.000Z",
    processInstance: "0123456789abcdef",
    mode: "print",
    level: "info",
    area: "runtime",
    name: "fixture",
    fields: { index, payload },
  };
}

async function writeEmptyFiles(directory: string, count: number): Promise<void> {
  const batchSize = 256;
  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(Array.from(
      { length: Math.min(batchSize, count - offset) },
      async (_, index) => await writeFile(join(directory, `unrelated-${offset + index}.tmp`), ""),
    ));
  }
}

test("overflowing heartbeat intervals fall back without becoming one-millisecond timers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-heartbeat-bound-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sink = await LocalJsonlObservabilitySink.create({
    directory: root,
    heartbeatIntervalMs: 2_147_483_648,
  });
  try {
    sink.record(record(1));
    await sink.flush();
    const [name] = await readdir(root);
    assert.ok(name !== undefined);
    const path = join(root, name);
    const stale = new Date("2026-01-01T00:00:00.000Z");
    await utimes(path, stale, stale);
    await delay(25);
    assert.ok((await stat(path)).mtimeMs < Date.now() - 60_000);
  } finally {
    await sink.close();
  }
});

test("local JSONL logs use private permissions and recognized metadata listing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const directory = join(root, "logs");
  const sink = await LocalJsonlObservabilitySink.create({
    directory,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
  });
  sink.record(record(1));
  await sink.close();

  const listed = await listLocalObservabilityFiles(directory);
  assert.equal(listed.partial, false);
  assert.equal(listed.files.length, 1);
  assert.equal(listed.totalBytes > 0, true);
  const path = join(directory, listed.files[0]!.name);
  assert.deepEqual((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [record(1)]);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("listing and cleanup bound directory enumeration and preserve unrecognized entries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-directory-bound-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeEmptyFiles(root, MAX_DIRECTORY_SCAN_ENTRIES + 1);

  const listed = await listLocalObservabilityFiles(root);
  assert.equal(listed.partial, true);
  assert.deepEqual(listed.files, []);

  const sink = await LocalJsonlObservabilitySink.create({ directory: root });
  await sink.close();
  assert.equal((await readdir(root)).length, MAX_DIRECTORY_SCAN_ENTRIES + 1);
});

test("the sink rotates at eight MiB and retains four process segments", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-rotation-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sink = await LocalJsonlObservabilitySink.create({ directory: root });
  const payload = "x".repeat(500);
  for (let batch = 0; batch < 72; batch += 1) {
    for (let index = 0; index < 1_000; index += 1) sink.record(record(batch * 1_000 + index, payload));
    await sink.flush();
  }
  await sink.close();
  const files = (await readdir(root)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 4);
  for (const file of files) assert.equal((await stat(join(root, file))).size <= 8 * 1024 * 1024, true);
  assert.equal(sink.status().droppedRecords, 0);
});

test("the sink bounds records waiting in the asynchronous write tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-burst-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sink = await LocalJsonlObservabilitySink.create({ directory: root });
  const attempted = 100;
  for (let index = 0; index < attempted; index += 1) {
    sink.record(record(index, "x".repeat(64 * 1024)));
  }
  const dropped = sink.status().droppedRecords;
  assert.equal(dropped > 0, true);

  await sink.close();

  const files = (await readdir(root)).filter((name) => name.endsWith(".jsonl"));
  const written = (await Promise.all(files.map(async (file) =>
    (await readFile(join(root, file), "utf8")).trim().split("\n").filter(Boolean).length)))
    .reduce((sum, count) => sum + count, 0);
  assert.equal(written + dropped, attempted);
});

test("retention deletes only expired recognized files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-retention-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const expired = join(root, "rigyn-20260701T000000-1-abcdef123456-000.jsonl");
  const unrelated = join(root, "keep.txt");
  await writeFile(expired, "{}\n", { mode: 0o600 });
  await writeFile(unrelated, "keep\n", { mode: 0o600 });
  await utimes(expired, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
  const sink = await LocalJsonlObservabilitySink.create({
    directory: root,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  await sink.close();
  const files = await readdir(root);
  assert.equal(files.includes(expired.split("/").at(-1)!), false);
  assert.equal(files.includes("keep.txt"), true);
});

test("retention bounds recent recognized files by count and bytes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-retention-bounds-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 140; index += 1) {
    const name = `rigyn-20260808T120000-${index + 1}-${index.toString(16).padStart(12, "0")}-000.jsonl`;
    const path = join(root, name);
    await writeFile(path, "{}\n", { mode: 0o600 });
    await utimes(path, new Date("2026-08-08T12:00:00.000Z"), new Date("2026-08-08T12:00:00.000Z"));
  }
  for (let index = 0; index < 4; index += 1) {
    const name = `rigyn-20260808T120100-${index + 1}-${(index + 1_000).toString(16).padStart(12, "0")}-000.jsonl`;
    const path = join(root, name);
    await writeFile(path, "", { mode: 0o600 });
    await truncate(path, 32 * 1024 * 1024);
    await utimes(path, new Date("2026-08-08T12:01:00.000Z"), new Date("2026-08-08T12:01:00.000Z"));
  }
  await writeFile(join(root, "keep.txt"), "keep\n");

  const sink = await LocalJsonlObservabilitySink.create({
    directory: root,
    now: () => new Date("2026-08-08T13:00:00.000Z"),
  });
  await sink.close();

  const listed = await listLocalObservabilityFiles(root);
  assert.equal(listed.files.length <= 124, true);
  assert.equal(listed.totalBytes <= 96 * 1024 * 1024, true);
  assert.equal((await readFile(join(root, "keep.txt"), "utf8")), "keep\n");
});

test("a live child writer heartbeats its segment across age cleanup and later writes remain visible", { timeout: 10_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-live-heartbeat-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(process.cwd(), "src/core/local-observability.ts")).href;
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { LocalJsonlObservabilitySink } from ${JSON.stringify(module)};
     const sink = await LocalJsonlObservabilitySink.create({
       directory: ${JSON.stringify(root)},
       heartbeatIntervalMs: 20,
     });
     const record = (index) => ({
       schemaVersion: 1,
       kind: "event",
       timestamp: new Date().toISOString(),
       processInstance: "0123456789abcdef",
       mode: "serve",
       level: "error",
       area: "runtime",
       name: "fixture",
       fields: { index },
     });
     sink.record(record(1));
     await sink.flush();
     process.stdout.write("ready\\n");
     process.stdin.once("data", async () => {
       sink.record(record(2));
       await sink.flush();
       process.stdout.write("written\\n");
     });
     setInterval(() => undefined, 1_000);`,
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  try {
    assert.deepEqual(await lines.next(), { value: "ready", done: false }, stderr);
    const before = await listLocalObservabilityFiles(root);
    assert.equal(before.files.length, 1);
    const active = join(root, before.files[0]!.name);
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(active, stale, stale);
    const deadline = Date.now() + 2_000;
    while ((await stat(active)).mtimeMs < Date.now() - 1_000 && Date.now() < deadline) await delay(20);
    assert.equal((await stat(active)).mtimeMs >= Date.now() - 1_000, true, "active segment was not heartbeated");

    const newcomer = await LocalJsonlObservabilitySink.create({ directory: root });
    await newcomer.close();
    assert.equal((await listLocalObservabilityFiles(root)).files.some((file) => file.name === before.files[0]!.name), true);

    child.stdin!.write("write\n");
    assert.deepEqual(await lines.next(), { value: "written", done: false }, stderr);
    const contents = await readFile(active, "utf8");
    assert.equal(contents.trim().split("\n").length, 2);
  } finally {
    child.stdin?.end();
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
});

test("repeated heartbeat ticks queue at most one update behind a blocked write tail", { timeout: 10_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-heartbeat-queue-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const probe = await open(join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as {
    utimes(atime: string | number | Date, mtime: string | number | Date): Promise<void>;
  };
  await probe.close();
  await rm(join(root, "probe"));
  const original = prototype.utimes;
  let release!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
  let heartbeatCalls = 0;
  prototype.utimes = async function heartbeatFixture(): Promise<void> {
    heartbeatCalls += 1;
    if (heartbeatCalls === 1) await blocked;
  };
  const sink = await LocalJsonlObservabilitySink.create({ directory: root, heartbeatIntervalMs: 10 });
  try {
    sink.record(record(1));
    await sink.flush();
    const deadline = Date.now() + 2_000;
    while (heartbeatCalls === 0 && Date.now() < deadline) await delay(10);
    assert.equal(heartbeatCalls, 1);
    await delay(80);

    const flushed = sink.flush();
    release();
    await flushed;
    await sink.close();
    assert.equal(heartbeatCalls, 1);
  } finally {
    release();
    await sink.close();
    prototype.utimes = original;
  }
});

test("quota cleanup preserves every recently refreshed segment", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-active-quota-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const now = new Date();
  for (let index = 0; index < 130; index += 1) {
    const name = `rigyn-20260808T120000-${index + 1}-${index.toString(16).padStart(12, "0")}-000.jsonl`;
    await writeFile(join(root, name), "{}\n", { mode: 0o600 });
  }

  const sink = await LocalJsonlObservabilitySink.create({ directory: root, now: () => now });
  await sink.close();
  assert.equal((await listLocalObservabilityFiles(root)).files.length, 130);
});

test("a closed segment becomes age-prunable after the active freshness grace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-closed-heartbeat-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sink = await LocalJsonlObservabilitySink.create({ directory: root, heartbeatIntervalMs: 20 });
  sink.record(record(1));
  await sink.close();
  const listed = await listLocalObservabilityFiles(root);
  assert.equal(listed.files.length, 1);

  const cleanup = await LocalJsonlObservabilitySink.create({
    directory: root,
    now: () => new Date(Date.now() + 8 * 24 * 60 * 60_000),
  });
  await cleanup.close();
  assert.equal((await listLocalObservabilityFiles(root)).files.length, 0);
});

test("symbolic-link destinations disable logging without affecting the target", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-link-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const link = join(root, "logs");
  await mkdir(target);
  await symlink(target, link, "dir");
  const sink = await LocalJsonlObservabilitySink.create({ directory: link });
  sink.record(record(1));
  await sink.close();
  assert.equal(sink.status().disabled, true);
  assert.deepEqual(await readdir(target), []);
});

test("the bounded snapshot reader rejects a file replaced by a symbolic link", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-read-link-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const logs = join(root, "logs");
  const target = join(root, "target.jsonl");
  const name = "rigyn-20260808T120000-1-abcdef123456-000.jsonl";
  const path = join(logs, name);
  await mkdir(logs);
  await writeFile(path, `${JSON.stringify(record(1))}\n`);
  const listed = await listLocalObservabilityFiles(logs);
  await rm(path);
  await writeFile(target, "PRIVATE_TARGET_SENTINEL\n");
  await symlink(target, path, "file");
  let snapshots = 0;
  const result = await scanLocalObservabilityFile(listed.directory, listed.files[0]!, {
    maximumBytes: 8 * 1024 * 1024,
    maximumLineBytes: 64 * 1024,
    maximumRecords: 100,
    onSnapshot() { snapshots += 1; },
  });
  assert.equal(result, undefined);
  assert.equal(snapshots, 0);
});

test("the bounded snapshot reader skips an oversized line and resumes at the next record", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-read-bound-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const name = "rigyn-20260808T120000-1-abcdef123456-000.jsonl";
  const aggregate = { ...record(2), kind: "metrics_snapshot", name: "metrics_snapshot" } as const;
  await writeFile(join(root, name), [
    `{"kind":"metrics_snapshot","padding":"${"x".repeat(1_000)}"}`,
    JSON.stringify(aggregate),
    "",
  ].join("\n"));
  const listed = await listLocalObservabilityFiles(root);
  const observed: ObservabilityRecord[] = [];
  const result = await scanLocalObservabilityFile(listed.directory, listed.files[0]!, {
    maximumBytes: 8 * 1024 * 1024,
    maximumLineBytes: 512,
    maximumRecords: 100,
    onSnapshot(value) { observed.push(value); },
  });
  assert.deepEqual(observed, [aggregate]);
  assert.equal(result?.recordsSkipped, 1);
  assert.equal(result?.partial, false);
});

test("listing an unreadable log directory fails open", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-unreadable-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const logs = join(root, "logs");
  await mkdir(logs);
  await chmod(logs, 0o000);
  try {
    assert.deepEqual(await listLocalObservabilityFiles(logs), {
      directory: logs,
      files: [],
      totalBytes: 0,
      partial: true,
    });
  } finally {
    await chmod(logs, 0o700);
  }
});

test("concurrent sinks keep process records in separate files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-concurrent-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const [first, second] = await Promise.all([
    LocalJsonlObservabilitySink.create({ directory: root }),
    LocalJsonlObservabilitySink.create({ directory: root }),
  ]);
  first.record(record(1));
  second.record(record(2));
  await Promise.all([first.close(), second.close()]);

  const listed = await listLocalObservabilityFiles(root);
  assert.equal(listed.files.length, 2);
  const indexes = (await Promise.all(listed.files.map(async (file) =>
    (JSON.parse((await readFile(join(root, file.name), "utf8")).trim()) as ObservabilityRecord).fields.index)))
    .sort();
  assert.deepEqual(indexes, [1, 2]);
});

test("process-local sink acquisition coalesces concurrent callers and isolates directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-process-sink-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  const [first, repeated, second] = await Promise.all([
    acquireProcessLocalObservabilitySink(firstDirectory),
    acquireProcessLocalObservabilitySink(firstDirectory),
    acquireProcessLocalObservabilitySink(secondDirectory),
  ]);

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  await Promise.all([first.close(), second.close()]);
});

test("one process-local sink retains snapshots for 129 concurrent runtime observers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-process-retention-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sink = await acquireProcessLocalObservabilitySink(root);
  const observers = Array.from({ length: 129 }, () => new RuntimeObservability(sink, {
    mode: "serve",
    level: "info",
    closeSink: false,
    snapshotIntervalMs: 60_000,
  }));

  await Promise.all(observers.map(async (observer) => await observer.close()));

  const listed = await listLocalObservabilityFiles(root);
  assert.equal(listed.files.length, 1);
  const processInstances = new Set<string>();
  let snapshots = 0;
  for (const file of listed.files) {
    const scan = await scanLocalObservabilityFile(root, file, {
      maximumBytes: 8 * 1024 * 1024,
      maximumLineBytes: 64 * 1024,
      maximumRecords: 1_000,
      onSnapshot(value) {
        snapshots += 1;
        processInstances.add(value.processInstance);
      },
    });
    assert.notEqual(scan, undefined);
  }
  assert.equal(snapshots, 129);
  assert.equal(processInstances.size, 129);
  assert.equal(sink.status().droppedRecords, 0);
  assert.equal(sink.status().writerFailures, 0);
  await sink.close();
});

test("a disabled process-local sink is evicted so a later runtime can retry", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-process-retry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const blocker = join(root, "blocker");
  const directory = join(blocker, "logs");
  await writeFile(blocker, "not a directory");

  const disabled = await acquireProcessLocalObservabilitySink(directory);
  assert.equal(disabled.status().disabled, true);
  await rm(blocker);

  const retried = await acquireProcessLocalObservabilitySink(directory);
  assert.notEqual(retried, disabled);
  assert.equal(retried.status().disabled, false);
  await retried.close();
});

test("a closed process-local sink is never returned to a later runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-observability-process-closed-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const first = await acquireProcessLocalObservabilitySink(root);
  await first.close();

  const second = await acquireProcessLocalObservabilitySink(root);
  assert.notEqual(second, first);
  second.record(record(1));
  await second.close();
  assert.equal((await listLocalObservabilityFiles(root)).files.length, 1);
});
