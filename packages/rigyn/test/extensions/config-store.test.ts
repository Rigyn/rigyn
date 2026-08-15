import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ExtensionConfigConflictError,
  createExtensionConfigStore,
  type ExtensionConfigStore,
} from "../../src/extensions/config-store.js";

const SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/extensions/config-store.ts",
);

interface Fixture {
  root: string;
  user: string;
  workspace: string;
}

async function fixture(context: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-extension-config-"));
  const user = join(root, "user");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(user, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
  ]);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, user, workspace };
}

function store(value: Fixture, writable = (): boolean => true): ExtensionConfigStore {
  return createExtensionConfigStore({
    roots: { user: value.user, workspace: value.workspace },
    writable,
  });
}

async function settleWithin<T>(operation: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("extension config operation did not settle")), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("extension config keeps scopes separate and returns immutable snapshots", async (context) => {
  const paths = await fixture(context);
  const config = store(paths);

  const absent = await config.read("user");
  assert.deepEqual(absent, { revision: null, value: undefined });
  assert.equal(Object.isFrozen(absent), true);

  const input = { nested: [{ enabled: true }], nullable: null };
  const user = await config.replace("user", input, { expectedRevision: null });
  input.nested[0]!.enabled = false;
  assert.match(user.revision ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(user.value, { nested: [{ enabled: true }], nullable: null });
  assert.equal(Object.isFrozen(user), true);
  assert.equal(Object.isFrozen(user.value), true);
  assert.equal(Object.isFrozen((user.value as { nested: object[] }).nested), true);
  assert.equal(Object.isFrozen((user.value as { nested: object[] }).nested[0]), true);
  assert.throws(() => {
    (user.value as { nested: Array<{ enabled: boolean }> }).nested[0]!.enabled = false;
  }, TypeError);

  const workspace = await config.replace("workspace", null, { expectedRevision: null });
  assert.equal(workspace.value, null);
  assert.deepEqual(await config.read("user"), user);
  assert.deepEqual(await config.read("workspace"), workspace);

  const removed = await config.remove("user", { expectedRevision: user.revision });
  assert.deepEqual(removed, { revision: null, value: undefined });
  assert.deepEqual(await config.read("user"), removed);
  assert.equal((await config.read("workspace")).value, null);
});

test("extension config enforces mandatory compare-and-swap revisions", async (context) => {
  const paths = await fixture(context);
  const first = store(paths);
  const second = store(paths);
  const original = await first.replace("user", { version: 1 }, { expectedRevision: null });
  const current = await first.replace("user", { version: 2 }, { expectedRevision: original.revision });

  await assert.rejects(
    second.replace("user", { version: 3 }, { expectedRevision: original.revision }),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionConfigConflictError);
      assert.equal(error.expectedRevision, original.revision);
      assert.equal(error.currentRevision, current.revision);
      return true;
    },
  );
  assert.deepEqual((await first.read("user")).value, { version: 2 });
  await assert.rejects(
    first.remove("user", { expectedRevision: original.revision }),
    ExtensionConfigConflictError,
  );
});

test("extension config serializes competing writers across processes", async (context) => {
  const paths = await fixture(context);
  const sourceUrl = pathToFileURL(SOURCE_PATH).href;
  const script = `
    import { createExtensionConfigStore, ExtensionConfigConflictError } from ${JSON.stringify(sourceUrl)};
    const store = createExtensionConfigStore({
      roots: { user: process.env.CONFIG_USER, workspace: process.env.CONFIG_WORKSPACE },
      writable: () => true,
    });
    try {
      const value = await store.replace("user", { writer: process.env.CONFIG_WRITER }, { expectedRevision: null });
      process.stdout.write(JSON.stringify({ outcome: "written", revision: value.revision }));
    } catch (error) {
      if (!(error instanceof ExtensionConfigConflictError)) throw error;
      process.stdout.write(JSON.stringify({ outcome: "conflict", revision: error.currentRevision }));
    }
  `;
  const run = async (writer: string): Promise<{ outcome: string; revision: string }> => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: resolve(dirname(SOURCE_PATH), "../.."),
      env: {
        ...process.env,
        CONFIG_USER: paths.user,
        CONFIG_WORKSPACE: paths.workspace,
        CONFIG_WRITER: writer,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolveClose, reject) => {
      child.once("error", reject);
      child.once("close", resolveClose);
    });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout) as { outcome: string; revision: string };
  };

  const outcomes = await Promise.all([run("first"), run("second")]);
  assert.deepEqual(outcomes.map((entry) => entry.outcome).sort(), ["conflict", "written"]);
  assert.equal(outcomes[0]!.revision, outcomes[1]!.revision);
  const persisted = (await store(paths).read("user")).value;
  assert.ok(persisted !== null && typeof persisted === "object" && !Array.isArray(persisted));
  assert.ok(["first", "second"].includes(persisted.writer as string));
});

test("extension config is read-only until its owner commits and observes aborts", async (context) => {
  const paths = await fixture(context);
  let committed = false;
  const controller = new AbortController();
  const config = createExtensionConfigStore({
    roots: { user: paths.user, workspace: paths.workspace },
    writable: () => committed,
    signal: controller.signal,
  });

  assert.deepEqual(await config.read("user"), { revision: null, value: undefined });
  await assert.rejects(
    config.replace("user", { enabled: true }, { expectedRevision: null }),
    /not writable/u,
  );
  committed = true;
  const written = await config.replace("user", { enabled: true }, { expectedRevision: null });
  controller.abort();
  await assert.rejects(config.read("user"), { name: "AbortError" });
  await assert.rejects(
    config.remove("user", { expectedRevision: written.revision }),
    { name: "AbortError" },
  );
});

test("extension config replacement observes generation cancellation while waiting for its lock", async (context) => {
  const paths = await fixture(context);
  const path = join(paths.user, "config.json");
  const lock = `${path}.lock`;
  await mkdir(lock);
  const controller = new AbortController();
  const reason = new Error("replacement generation retired while waiting");
  const config = createExtensionConfigStore({
    roots: { user: paths.user, workspace: paths.workspace },
    signal: controller.signal,
    writable: () => true,
  });
  const replacement = config.replace("user", { escaped: true }, { expectedRevision: null });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.abort(reason);

  await assert.rejects(settleWithin(replacement), (error: unknown) => error === reason);
  assert.equal((await lstat(lock)).isDirectory(), true);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("extension config removal observes generation cancellation while waiting for its lock", async (context) => {
  const paths = await fixture(context);
  const seeded = await store(paths).replace("user", { version: 1 }, { expectedRevision: null });
  const path = join(paths.user, "config.json");
  const lock = `${path}.lock`;
  await mkdir(lock);
  const controller = new AbortController();
  const reason = new Error("removal generation retired while waiting");
  const config = createExtensionConfigStore({
    roots: { user: paths.user, workspace: paths.workspace },
    signal: controller.signal,
    writable: () => true,
  });
  const removal = config.remove("user", { expectedRevision: seeded.revision });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.abort(reason);

  await assert.rejects(settleWithin(removal), (error: unknown) => error === reason);
  assert.equal((await lstat(lock)).isDirectory(), true);
  assert.deepEqual((await store(paths).read("user")).value, { version: 1 });
});

test("extension config cannot replace or remove after its generation becomes stale", async (context) => {
  const paths = await fixture(context);
  const replacementController = new AbortController();
  let replacementChecks = 0;
  const replacement = createExtensionConfigStore({
    roots: { user: paths.user, workspace: paths.workspace },
    signal: replacementController.signal,
    writable: () => {
      replacementChecks += 1;
      if (replacementChecks === 3) {
        queueMicrotask(() => replacementController.abort(new Error("replacement generation retired")));
      }
      return true;
    },
  });

  await assert.rejects(
    replacement.replace("user", { escaped: true }, { expectedRevision: null }),
    /replacement generation retired/u,
  );
  await assert.rejects(readFile(join(paths.user, "config.json")), { code: "ENOENT" });

  const seeded = await store(paths).replace("user", { version: 1 }, { expectedRevision: null });
  const removalController = new AbortController();
  let removalChecks = 0;
  const removal = createExtensionConfigStore({
    roots: { user: paths.user, workspace: paths.workspace },
    signal: removalController.signal,
    writable: () => {
      removalChecks += 1;
      if (removalChecks === 3) {
        queueMicrotask(() => removalController.abort(new Error("removal generation retired")));
      }
      return true;
    },
  });

  await assert.rejects(
    removal.remove("user", { expectedRevision: seeded.revision }),
    /removal generation retired/u,
  );
  assert.deepEqual((await store(paths).read("user")).value, { version: 1 });
});

test("extension config rejects malformed, oversized, and non-JSON documents", async (context) => {
  const paths = await fixture(context);
  const config = store(paths);
  const path = join(paths.user, "config.json");

  await assert.rejects(
    config.replace("user", { invalid: Number.NaN } as never, { expectedRevision: null }),
    /JSON value/u,
  );
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await assert.rejects(
    config.replace("user", cyclic as never, { expectedRevision: null }),
    /JSON value/u,
  );
  await assert.rejects(
    config.replace("user", "x".repeat(64 * 1024), { expectedRevision: null }),
    /65,536 bytes/u,
  );

  await writeFile(path, "{broken", { mode: 0o600 });
  await assert.rejects(config.read("user"), /invalid JSON/u);
  await writeFile(path, `"${"x".repeat(64 * 1024)}"`, { mode: 0o600 });
  await assert.rejects(config.read("user"), /65,536 bytes/u);
});

test("extension config rejects link and non-regular targets without touching them", async (context) => {
  const paths = await fixture(context);
  const config = store(paths);
  const outside = join(paths.root, "outside.json");
  const path = join(paths.user, "config.json");
  await writeFile(outside, "outside", { mode: 0o600 });
  await symlink(outside, path);

  await assert.rejects(config.read("user"), /symbolic link/u);
  await assert.rejects(
    config.replace("user", { changed: true }, { expectedRevision: null }),
    /symbolic link/u,
  );
  await assert.rejects(config.remove("user", { expectedRevision: null }), /symbolic link/u);
  assert.equal(await readFile(outside, "utf8"), "outside");

  await rm(path);
  await mkdir(path);
  await assert.rejects(config.read("user"), /regular file/u);
});

test("extension config writes atomically with private permissions and cleans auxiliaries", async (context) => {
  const paths = await fixture(context);
  const config = store(paths);
  const first = await config.replace("user", { version: 1 }, { expectedRevision: null });
  const second = await config.replace("user", { version: 2 }, { expectedRevision: first.revision });
  const path = join(paths.user, "config.json");

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 2 });
  assert.deepEqual(await readdir(paths.user), ["config.json"]);
  if (process.platform !== "win32") {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    const third = await config.replace("user", { version: 3 }, { expectedRevision: second.revision });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(third.value, { version: 3 });
  }
});
