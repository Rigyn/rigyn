import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import {
  boundedRedactedFailureText,
  installLocalCrashReporter,
} from "../../src/core/local-crash-reporter.js";
import { MAX_DIRECTORY_SCAN_ENTRIES } from "../../src/core/local-observability.js";

async function writeUnrecognizedEntries(directory: string, count: number): Promise<void> {
  const batchSize = 256;
  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(Array.from(
      { length: Math.min(batchSize, count - offset) },
      async (_, index) => await writeFile(join(directory, `unrelated-${offset + index}.tmp`), ""),
    ));
  }
}

test("the crash reporter writes private redacted failure details", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-crash-reporter-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(process.cwd(), "src/core/local-crash-reporter.ts")).href;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { installLocalCrashReporter } from ${JSON.stringify(module)};
     await installLocalCrashReporter(${JSON.stringify(root)}, "print");
     throw new Error("CRASH_SECRET_SENTINEL sk-proj-abcdefghijklmnop");`,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
  assert.notEqual(result.status, 0);
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const path = join(root, files[0]!);
  const serialized = await readFile(path, "utf8");
  assert.match(serialized, /CRASH_SECRET_SENTINEL/u);
  assert.doesNotMatch(serialized, /abcdefghijklmnop/u);
  const parsed = JSON.parse(serialized) as {
    kind: string;
    mode: string;
    origin: string;
    error: { name: string; message: string; stack?: string };
  };
  assert.equal(parsed.kind, "rigyn-crash");
  assert.equal(parsed.mode, "print");
  assert.equal(parsed.origin, "unhandledRejection");
  assert.equal(parsed.error.name, "Error");
  assert.match(parsed.error.message, /CRASH_SECRET_SENTINEL/u);
  assert.equal(parsed.error.stack, undefined);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("the crash reporter accepts a caught top-level failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-top-level-reporter-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(process.cwd(), "src/core/local-crash-reporter.ts")).href;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { installLocalCrashReporter } from ${JSON.stringify(module)};
     const reporter = await installLocalCrashReporter(${JSON.stringify(root)}, "interactive");
     reporter.report(Object.assign(new Error("top-level failure"), { code: "E_TOP" }), "topLevel");
     reporter.close();`,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(await readFile(join(root, files[0]!), "utf8")) as {
    origin: string;
    error: { code?: string; message: string };
  };
  assert.equal(parsed.origin, "topLevel");
  assert.equal(parsed.error.code, "E_TOP");
  assert.equal(parsed.error.message, "top-level failure");
});

test("huge failure text is bounded and redacted before fatal-path transformations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-crash-text-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(process.cwd(), "src/core/local-crash-reporter.ts")).href;
  const result = spawnSync(process.execPath, [
    "--max-old-space-size=64", "--import", "tsx", "--input-type=module", "--eval",
    `import { installLocalCrashReporter } from ${JSON.stringify(module)};
     const reporter = await installLocalCrashReporter(${JSON.stringify(root)}, "sdk");
     const bytes = Buffer.alloc(128 * 1024 * 1024, 120);
     bytes.write("kept-🙂\\0sk-proj-abcdefghijklmnop-");
     const huge = bytes.toString("utf8");
     const failure = new Error();
     Object.defineProperties(failure, {
       message: { configurable: true, value: huge },
       stack: { configurable: true, value: huge },
     });
     reporter.report(failure, "topLevel");
     reporter.close();`,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const serialized = await readFile(join(root, files[0]!), "utf8");
  assert.ok(Buffer.byteLength(serialized, "utf8") < 140 * 1024);
  assert.match(serialized, /kept-🙂/u);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.doesNotMatch(serialized, /abcdefghijklmnop/u);
  assert.doesNotMatch(serialized, /�/u);
  assert.doesNotMatch(serialized, /\\u0000/u);
});

test("fatal failure bounds redact a registered secret that crosses the output cutoff", () => {
  const marker = "LEAK-default-max-cutoff-secret-";
  const secret = `${marker}${"s".repeat((64 * 1_024) - marker.length)}`;
  defaultSecretRedactor.register(secret);
  const prefix = "x".repeat((64 * 1_024) - 16);

  const result = boundedRedactedFailureText(`${prefix}${secret}-tail`);

  assert.equal(result.startsWith(prefix), true);
  assert.equal(result.slice(prefix.length), "[REDACTED]-tail");
  assert.equal(Buffer.byteLength(result, "utf8") <= 64 * 1_024, true);
  assert.doesNotMatch(result, /LEAK-default-max-cutoff/u);
});

test("the top-level executable bounds fatal stderr before redaction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-fatal-stderr-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const entry = join(process.cwd(), "src/bin/rigyn.ts");
  const preload = `data:text/javascript,${encodeURIComponent(`
    const prefix = "--sk-proj-abcdefghijklmnop \\0 kept-🙂 ";
    process.argv.splice(2, process.argv.length, prefix + "x".repeat(17 * 1024 * 1024));
  `)}`;
  const result = spawnSync(process.execPath, [
    "--max-old-space-size=256", "--import", "tsx", "--import", preload, entry,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, RIGYN_HOME: join(root, ".rigyn") },
    maxBuffer: 256 * 1024,
    timeout: 15_000,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64 * 1024 + 9);
  assert.match(result.stderr, /^rigyn: Unknown option:/u);
  assert.match(result.stderr, /\[REDACTED\]/u);
  assert.match(result.stderr, /kept-🙂/u);
  assert.doesNotMatch(result.stderr, /abcdefghijklmnop|\0/u);
});

test("arbitrary thrown values are recorded without reflection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-hostile-crash-reporter-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(process.cwd(), "src/core/local-crash-reporter.ts")).href;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { installLocalCrashReporter } from ${JSON.stringify(module)};
     const reporter = await installLocalCrashReporter(${JSON.stringify(root)}, "sdk");
     let traps = 0;
     const hostile = new Proxy(Object.create(null), {
       get() { traps += 1; throw new Error("cannot inspect"); },
       getPrototypeOf() { traps += 1; throw new Error("cannot inspect"); }
     });
     reporter.report(hostile, "topLevel");
     reporter.report(new Error("recoverable report"), "topLevel");
     reporter.close();
     process.stdout.write(String(traps));`,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "0");
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(await readFile(join(root, files[0]!), "utf8")) as {
    error: { message: string };
  };
  assert.equal(parsed.error.message, "[Thrown object]");
});

test("crash reporting ignores Error accessors and cause hooks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-crash-accessors-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const reporter = await installLocalCrashReporter(root, "sdk");
  let traps = 0;
  const failure = new Error("hidden message");
  Object.defineProperties(failure, {
    cause: { configurable: true, get() { traps += 1; throw new Error("cause getter executed"); } },
    message: { configurable: true, get() { traps += 1; throw new Error("message getter executed"); } },
    stack: { configurable: true, get() { traps += 1; throw new Error("stack getter executed"); } },
  });

  reporter.report(failure, "topLevel");
  reporter.close();

  const files = await readdir(root);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(await readFile(join(root, files[0]!), "utf8")) as {
    error: { cause?: unknown; message: string; stack?: string };
  };
  assert.equal(parsed.error.message, "[Thrown Error]");
  assert.equal(parsed.error.stack, undefined);
  assert.equal(parsed.error.cause, undefined);
  assert.equal(traps, 0);
});

test("crash reporting bounds retained reports without deleting unrelated files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-crash-retention-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 40; index += 1) {
    await writeFile(
      join(root, `rigyn-crash-20260808T120000-1-${index.toString(16).padStart(12, "0")}.json`),
      "{}\n",
    );
  }
  await writeFile(join(root, "keep.txt"), "keep\n");

  const reporter = await installLocalCrashReporter(root, "sdk");
  reporter.report(new Error("bounded crash report"), "topLevel");
  reporter.close();

  const files = await readdir(root);
  const reports = files.filter((name) => name.startsWith("rigyn-crash-"));
  assert.equal(reports.length <= 32, true);
  assert.equal((await Promise.all(reports.map(async (name) => await readFile(join(root, name), "utf8"))))
    .some((contents) => contents.includes("bounded crash report")), true);
  assert.equal(files.includes("keep.txt"), true);
});

test("fatal pruning bounds directory enumeration and preserves unrecognized entries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-crash-directory-bound-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeUnrecognizedEntries(root, MAX_DIRECTORY_SCAN_ENTRIES + 1);

  const reporter = await installLocalCrashReporter(root, "sdk");
  reporter.report(new Error("bounded fatal pruning"), "topLevel");
  reporter.close();

  const files = await readdir(root);
  assert.equal(files.filter((name) => name.startsWith("unrelated-")).length, MAX_DIRECTORY_SCAN_ENTRIES + 1);
  const reports = files.filter((name) => name.startsWith("rigyn-crash-"));
  assert.equal(reports.length, 1);
  assert.match(await readFile(join(root, reports[0]!), "utf8"), /bounded fatal pruning/u);
});
