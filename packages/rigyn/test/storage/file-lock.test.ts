import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import { withFileLock } from "../../src/storage/file-lock.js";

const MAX_CONTROL_FILE_BYTES = 4 * 1024;
const STALE_TOKEN = "00000000-0000-4000-8000-000000000001";
const REPLACEMENT_TOKEN = "00000000-0000-4000-8000-000000000002";

function isControlPath(path: unknown, lock: string, name: "claim" | "owner" | "pid"): boolean {
  const selected = String(path);
  return resolve(dirname(selected)) === resolve(lock) && basename(selected).startsWith(`${name}-`);
}

async function selectedControlPath(
  lock: string,
  name: "claim" | "owner" | "pid",
): Promise<string> {
  const selected = (await readdir(lock)).find((entry) => entry.startsWith(`${name}-`));
  assert.notEqual(selected, undefined);
  return join(lock, selected!);
}

async function writeLockControls(
  lock: string,
  token: string,
  owner: string,
  pid: string | "directory",
): Promise<void> {
  await writeFile(join(lock, `claim-${token}`), token);
  await writeFile(join(lock, `owner-${token}`), owner);
  if (pid === "directory") await mkdir(join(lock, `pid-${token}`));
  else await writeFile(join(lock, `pid-${token}`), pid);
}

function replacementEntries(): string[] {
  return [
    `claim-${REPLACEMENT_TOKEN}`,
    `owner-${REPLACEMENT_TOKEN}`,
    "payload",
    `pid-${REPLACEMENT_TOKEN}`,
  ];
}

async function fixture(context: test.TestContext): Promise<{ root: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-file-lock-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, target: join(root, "config.json") };
}

async function settleWithin<T>(operation: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("file lock operation did not settle")), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("asynchronous file locks serialize operations and clean up", async (context) => {
  const value = await fixture(context);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  const first = withFileLock(value.target, async () => {
    order.push("first-enter");
    firstEntered();
    await firstGate;
    order.push("first-exit");
  });
  await entered;

  let secondEntered!: () => void;
  const secondEntry = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  const second = withFileLock(value.target, async () => {
    order.push("second-enter");
    secondEntered();
  });
  assert.equal(await Promise.race([
    secondEntry.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
  ]), false);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
  await assert.rejects(stat(`${value.target}.lock`), { code: "ENOENT" });
});

test("an asynchronous waiter observes cancellation while a live lock is contended", async (context) => {
  const value = await fixture(context);
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
  let holderEntered!: () => void;
  const entered = new Promise<void>((resolve) => { holderEntered = resolve; });
  const holder = withFileLock(value.target, async () => {
    holderEntered();
    await holderGate;
  });
  await entered;

  const controller = new AbortController();
  const reason = new Error("lock wait cancelled");
  const waiter = withFileLock(value.target, async () => {
    assert.fail("cancelled waiter acquired the lock");
  }, controller.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.abort(reason);

  try {
    await assert.rejects(settleWithin(waiter), (error: unknown) => error === reason);
  } finally {
    releaseHolder();
    await holder;
  }
  await assert.rejects(stat(`${value.target}.lock`), { code: "ENOENT" });
});

test("an abort that wins during asynchronous acquisition releases the new lock", async (context) => {
  const value = await fixture(context);
  const controller = new AbortController();
  const reason = new Error("lock acquisition cancelled");
  let operationCalled = false;
  const operation = withFileLock(value.target, async () => {
    operationCalled = true;
  }, controller.signal);
  queueMicrotask(() => controller.abort(reason));

  await assert.rejects(settleWithin(operation), (error: unknown) => error === reason);
  assert.equal(operationCalled, false);
  await assert.rejects(stat(`${value.target}.lock`), { code: "ENOENT" });
});

test("asynchronous acquisition removes its new lock after owner or PID creation fails", async (context) => {
  const value = await fixture(context);
  for (const controlFile of ["owner", "pid"] as const) {
    const target = `${value.target}-${controlFile}`;
    const original = fs.promises.writeFile;
    let injected = false;
    fs.promises.writeFile = (async (path, ...argumentsValue) => {
      if (!injected && isControlPath(path, `${target}.lock`, controlFile)) {
        injected = true;
        throw Object.assign(new Error(`injected ${controlFile} failure`), { code: "EIO" });
      }
      return await Reflect.apply(original, fs.promises, [path, ...argumentsValue]);
    }) as typeof fs.promises.writeFile;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        withFileLock(target, async () => assert.fail("failed acquisition ran operation")),
        new RegExp(`injected ${controlFile} failure`, "u"),
      );
    } finally {
      fs.promises.writeFile = original;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    await assert.rejects(stat(`${target}.lock`), { code: "ENOENT" });
    assert.equal(
      await settleWithin(withFileLock(target, async () => "reacquired")),
      "reacquired",
    );
  }
});

test("a failed claim preserves an empty replacement until stale recovery", async (context) => {
  const value = await fixture(context);
  const stale = new Date(Date.now() - 60_000);
  const asyncTarget = `${value.target}-async-claim`;
  const asyncLock = `${asyncTarget}.lock`;
  const originalAsyncWrite = fs.promises.writeFile;
  const originalAsyncStat = fs.promises.lstat;
  let originalAsyncIdentity: fs.BigIntStats | undefined;
  let asyncReplaced = false;
  fs.promises.lstat = (async (path, ...argumentsValue) => {
    const current = await Reflect.apply(
      originalAsyncStat,
      fs.promises,
      [path, ...argumentsValue],
    ) as fs.BigIntStats;
    if (resolve(String(path)) !== resolve(asyncLock)) return current;
    originalAsyncIdentity ??= current;
    return asyncReplaced ? originalAsyncIdentity : current;
  }) as typeof fs.promises.lstat;
  fs.promises.writeFile = (async (path, ...argumentsValue) => {
    if (isControlPath(path, asyncLock, "claim")) {
      await fs.promises.rm(asyncLock, { recursive: true });
      await fs.promises.mkdir(asyncLock);
      asyncReplaced = true;
      throw Object.assign(new Error("injected async claim replacement"), { code: "EIO" });
    }
    return await Reflect.apply(originalAsyncWrite, fs.promises, [path, ...argumentsValue]);
  }) as typeof fs.promises.writeFile;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withFileLock(asyncTarget, async () => assert.fail("failed acquisition ran operation")),
      /injected async claim replacement/u,
    );
  } finally {
    fs.promises.writeFile = originalAsyncWrite;
    fs.promises.lstat = originalAsyncStat;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await fs.promises.readdir(asyncLock), []);
  await utimes(asyncLock, stale, stale);
  assert.equal(await withFileLock(asyncTarget, async () => "reclaimed"), "reclaimed");
});

test("an unclaimed directory lost during acquisition is retried", async (context) => {
  const value = await fixture(context);
  const asyncTarget = `${value.target}-async-lost-unclaimed`;
  const asyncLock = `${asyncTarget}.lock`;
  const originalAsyncWrite = fs.promises.writeFile;
  let asyncInjected = false;
  fs.promises.writeFile = (async (path, ...argumentsValue) => {
    if (!asyncInjected && isControlPath(path, asyncLock, "claim")) {
      asyncInjected = true;
      await fs.promises.rmdir(asyncLock);
      throw Object.assign(new Error("injected lost async directory"), { code: "ENOENT" });
    }
    return await Reflect.apply(originalAsyncWrite, fs.promises, [path, ...argumentsValue]);
  }) as typeof fs.promises.writeFile;
  syncBuiltinESMExports();
  try {
    assert.equal(await withFileLock(asyncTarget, async () => "retried"), "retried");
  } finally {
    fs.promises.writeFile = originalAsyncWrite;
    syncBuiltinESMExports();
  }
  assert.equal(asyncInjected, true);
});

test("failed acquisition does not remove a replacement lock directory", async (context) => {
  const value = await fixture(context);
  const asyncTarget = `${value.target}-async-replaced`;
  const asyncLock = `${asyncTarget}.lock`;
  const originalAsync = fs.promises.writeFile;
  const originalAsyncStat = fs.promises.lstat;
  let originalAsyncIdentity: fs.BigIntStats | undefined;
  let asyncReplaced = false;
  fs.promises.lstat = (async (path, ...argumentsValue) => {
    const current = await Reflect.apply(
      originalAsyncStat,
      fs.promises,
      [path, ...argumentsValue],
    ) as fs.BigIntStats;
    if (resolve(String(path)) !== resolve(asyncLock)) return current;
    originalAsyncIdentity ??= current;
    return asyncReplaced ? originalAsyncIdentity : current;
  }) as typeof fs.promises.lstat;
  fs.promises.writeFile = (async (path, ...argumentsValue) => {
    if (!asyncReplaced && isControlPath(path, asyncLock, "pid")) {
      await fs.promises.rm(asyncLock, { recursive: true });
      await fs.promises.mkdir(asyncLock);
      asyncReplaced = true;
      await writeLockControls(asyncLock, REPLACEMENT_TOKEN, "replacement", String(process.pid));
      await fs.promises.writeFile(join(asyncLock, "payload"), "replacement");
      throw Object.assign(new Error("injected async replacement"), { code: "EIO" });
    }
    return await Reflect.apply(originalAsync, fs.promises, [path, ...argumentsValue]);
  }) as typeof fs.promises.writeFile;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withFileLock(asyncTarget, async () => assert.fail("failed acquisition ran operation")),
      /injected async replacement/u,
    );
  } finally {
    fs.promises.writeFile = originalAsync;
    fs.promises.lstat = originalAsyncStat;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(asyncLock, `owner-${REPLACEMENT_TOKEN}`), "utf8"), "replacement");
  assert.deepEqual((await readdir(asyncLock)).sort(), replacementEntries());
});

test("successful control-file writes cannot acquire a replacement lock directory", async (context) => {
  const value = await fixture(context);
  const asyncTarget = `${value.target}-async-successful-replacement`;
  const asyncLock = `${asyncTarget}.lock`;
  const originalAsyncWrite = fs.promises.writeFile;
  const originalAsyncStat = fs.promises.lstat;
  let originalAsyncIdentity: fs.BigIntStats | undefined;
  let asyncReplaced = false;
  let asyncOperationRan = false;
  fs.promises.lstat = (async (path, ...argumentsValue) => {
    const current = await Reflect.apply(
      originalAsyncStat,
      fs.promises,
      [path, ...argumentsValue],
    ) as fs.BigIntStats;
    if (resolve(String(path)) !== resolve(asyncLock)) return current;
    originalAsyncIdentity ??= current;
    return asyncReplaced ? originalAsyncIdentity : current;
  }) as typeof fs.promises.lstat;
  fs.promises.writeFile = (async (path, ...argumentsValue) => {
    if (!asyncReplaced && isControlPath(path, asyncLock, "owner")) {
      await fs.promises.rm(asyncLock, { recursive: true });
      await fs.promises.mkdir(asyncLock);
      asyncReplaced = true;
      await writeLockControls(asyncLock, REPLACEMENT_TOKEN, "replacement", String(process.pid));
      await fs.promises.writeFile(join(asyncLock, "payload"), "replacement");
    }
    return await Reflect.apply(originalAsyncWrite, fs.promises, [path, ...argumentsValue]);
  }) as typeof fs.promises.writeFile;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withFileLock(asyncTarget, async () => {
        asyncOperationRan = true;
      }),
      /File lock was replaced/u,
    );
  } finally {
    fs.promises.writeFile = originalAsyncWrite;
    fs.promises.lstat = originalAsyncStat;
    syncBuiltinESMExports();
  }
  assert.equal(asyncOperationRan, false);
  assert.equal(await readFile(join(asyncLock, `owner-${REPLACEMENT_TOKEN}`), "utf8"), "replacement");
  assert.deepEqual((await readdir(asyncLock)).sort(), replacementEntries());
});

test("release cleanup never recursively deletes a replacement lock directory", async (context) => {
  const value = await fixture(context);
  const asyncTarget = `${value.target}-async-release-replacement`;
  const asyncLock = `${asyncTarget}.lock`;
  const originalAsyncUnlink = fs.promises.unlink;
  let asyncReplaced = false;
  fs.promises.unlink = (async (path) => {
    if (!asyncReplaced && isControlPath(path, asyncLock, "claim")) {
      await fs.promises.rm(asyncLock, { recursive: true });
      await fs.promises.mkdir(asyncLock);
      await writeLockControls(asyncLock, REPLACEMENT_TOKEN, "replacement", String(process.pid));
      await fs.promises.writeFile(join(asyncLock, "payload"), "replacement");
      asyncReplaced = true;
    }
    await Reflect.apply(originalAsyncUnlink, fs.promises, [path]);
  }) as typeof fs.promises.unlink;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withFileLock(asyncTarget, async () => "done"),
      /Failed to release file lock/u,
    );
  } finally {
    fs.promises.unlink = originalAsyncUnlink;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(asyncLock, "payload"), "utf8"), "replacement");
  assert.deepEqual((await readdir(asyncLock)).sort(), replacementEntries());
});

test("release failures are surfaced and remain recoverable", async (context) => {
  const value = await fixture(context);
  const stale = new Date(Date.now() - 60_000);
  for (const controlFile of ["owner", "claim"] as const) {
    const target = `${value.target}-async-release-${controlFile}-failure`;
    const lock = `${target}.lock`;
    const originalUnlink = fs.promises.unlink;
    let injected = false;
    let operationRan = false;
    fs.promises.unlink = (async (path, ...argumentsValue) => {
      if (!injected && isControlPath(path, lock, controlFile)) {
        injected = true;
        throw Object.assign(new Error(`injected async ${controlFile} release failure`), { code: "EBUSY" });
      }
      return await Reflect.apply(originalUnlink, fs.promises, [path, ...argumentsValue]);
    }) as typeof fs.promises.unlink;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        withFileLock(target, async () => {
          operationRan = true;
          return "done";
        }),
        /Failed to release file lock/u,
      );
    } finally {
      fs.promises.unlink = originalUnlink;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(operationRan, true);
    const kinds = (await readdir(lock)).map((entry) => entry.split("-")[0]).sort();
    assert.deepEqual(kinds, controlFile === "owner" ? ["claim", "owner"] : ["claim"]);
    await utimes(lock, stale, stale);
    assert.equal(await withFileLock(target, async () => "recovered"), "recovered");
  }
});

test("stale recovery never follows a lock-directory symlink", async (context) => {
  const value = await fixture(context);
  const victim = join(value.root, "victim");
  const lock = `${value.target}.lock`;
  await mkdir(victim);
  await writeLockControls(victim, STALE_TOKEN, "stale", "999999999");
  await writeFile(join(victim, "payload"), "preserved");
  const stale = new Date(Date.now() - 60_000);
  await utimes(victim, stale, stale);
  await symlink(victim, lock, process.platform === "win32" ? "junction" : "dir");

  const controller = new AbortController();
  const reason = new Error("stop symlink contention");
  const pending = withFileLock(value.target, async () => "overlap", controller.signal);
  setTimeout(() => controller.abort(reason), 40).unref();
  await assert.rejects(settleWithin(pending), (error: unknown) => error === reason);

  assert.equal(await readFile(join(victim, "payload"), "utf8"), "preserved");
  assert.equal(await readFile(join(victim, `claim-${STALE_TOKEN}`), "utf8"), STALE_TOKEN);
  assert.equal(await readFile(join(victim, `owner-${STALE_TOKEN}`), "utf8"), "stale");
  assert.equal(await readFile(join(victim, `pid-${STALE_TOKEN}`), "utf8"), "999999999");
});

test("stale lock directories are reclaimed", async (context) => {
  const value = await fixture(context);
  const lock = `${value.target}.lock`;
  const stale = new Date(Date.now() - 60_000);

  await mkdir(lock);
  await writeLockControls(lock, STALE_TOKEN, STALE_TOKEN, "999999999");
  await utimes(lock, stale, stale);
  assert.equal(await withFileLock(value.target, async () => "async"), "async");
  await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("stale-lock PID reads accept 4 KiB and reject larger or non-regular files", async (context) => {
  const value = await fixture(context);
  const lock = `${value.target}.lock`;
  const stale = new Date(Date.now() - 60_000);

  await mkdir(lock);
  await writeLockControls(
    lock,
    STALE_TOKEN,
    STALE_TOKEN,
    String(process.pid).padEnd(MAX_CONTROL_FILE_BYTES, " "),
  );
  await utimes(lock, stale, stale);
  const controller = new AbortController();
  const reason = new Error("stop live lock contention");
  const pending = withFileLock(value.target, async () => "overlap", controller.signal);
  setTimeout(() => controller.abort(reason), 40).unref();
  await assert.rejects(settleWithin(pending), (error: unknown) => error === reason);

  await rm(lock, { recursive: true });
  await mkdir(lock);
  await writeLockControls(
    lock,
    STALE_TOKEN,
    STALE_TOKEN,
    String(process.pid).padEnd(MAX_CONTROL_FILE_BYTES + 1, " "),
  );
  await utimes(lock, stale, stale);
  assert.equal(await withFileLock(value.target, async () => "oversized"), "oversized");
  await assert.rejects(stat(lock), { code: "ENOENT" });

  await mkdir(lock);
  await writeLockControls(lock, STALE_TOKEN, STALE_TOKEN, "directory");
  await utimes(lock, stale, stale);
  assert.equal(await withFileLock(value.target, async () => "non-regular"), "non-regular");
  await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("an asynchronously replaced owner fails closed without deleting the replacement", async (context) => {
  const value = await fixture(context);
  const lock = `${value.target}.lock`;

  await assert.rejects(
    withFileLock(value.target, async () => {
      const owner = await selectedControlPath(lock, "owner");
      await writeFile(owner, "replacement");
    }),
    /File lock was replaced/u,
  );
  assert.equal(await readFile(await selectedControlPath(lock, "owner"), "utf8"), "replacement");
});

test("bounded owner replacement reads fail closed at and beyond 4 KiB", async (context) => {
  for (const bytes of [MAX_CONTROL_FILE_BYTES, MAX_CONTROL_FILE_BYTES + 1]) {
    const value = await fixture(context);
    const lock = `${value.target}.lock`;
    const replacement = "replacement".padEnd(bytes, " ");

    await assert.rejects(withFileLock(value.target, async () => {
      const owner = await selectedControlPath(lock, "owner");
      await writeFile(owner, replacement);
    }));
    assert.equal(await readFile(await selectedControlPath(lock, "owner"), "utf8"), replacement);
    await rm(lock, { recursive: true });
  }
});

test("a non-regular owner replacement fails closed without deleting it", async (context) => {
  const value = await fixture(context);
  const lock = `${value.target}.lock`;

  await assert.rejects(withFileLock(value.target, async () => {
    const owner = await selectedControlPath(lock, "owner");
    await rm(owner);
    await mkdir(owner);
  }));
  assert.equal((await stat(await selectedControlPath(lock, "owner"))).isDirectory(), true);
});
