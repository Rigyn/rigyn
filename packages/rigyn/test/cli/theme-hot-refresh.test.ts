import assert from "node:assert/strict";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThemeHotRefresher } from "../../src/cli/theme-hot-refresh.js";
import type { ThemeDefinition } from "../../src/tui/theme.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for theme refresh");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test("active loose themes hot-refresh atomically and retain the last valid definition", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "ocean.json");
  const source = (foreground: string): string => JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground } },
  });
  await writeFile(sourcePath, source("#001122"));

  const applied: ThemeDefinition[] = [];
  const invalid: Error[] = [];
  const refresher = new ThemeHotRefresher({
    apply: (definition) => applied.push(definition),
    invalid: (error) => invalid.push(error),
  });
  context.after(() => refresher.close());
  refresher.select({ name: "ocean", sourcePath });

  await writeFile(sourcePath, "{");
  await until(() => invalid.length === 1);
  assert.equal(applied.length, 0);

  await writeFile(sourcePath, source("#aabbcc"));
  await until(() => applied.length === 1);
  assert.equal(applied[0]!.styles.accent?.foreground, "#aabbcc");

  refresher.select(undefined);
  await writeFile(sourcePath, source("#ffffff"));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(applied.length, 1);
});

test("theme hot refresh contains hostile callback failures without inspecting them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-hostile-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "ocean.json");
  const source = (foreground: string): string => JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground } },
  });
  await writeFile(sourcePath, source("#001122"));
  let traps = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap ran");
    },
    get() {
      traps += 1;
      throw new Error("property trap ran");
    },
  });
  const invalid: Error[] = [];
  const refresher = new ThemeHotRefresher({
    apply() { throw hostile; },
    invalid: (cause) => invalid.push(cause),
  });
  context.after(() => refresher.close());
  refresher.select({ name: "ocean", sourcePath });
  await writeFile(sourcePath, source("#aabbcc"));
  await until(() => invalid.length === 1);
  assert.equal(invalid[0]?.message, "[Thrown object]");
  assert.equal(traps, 0);
});

test("a failing invalid-theme observer cannot reject the background refresh", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-invalid-observer-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "ocean.json");
  const source = JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#aabbcc" } },
  });
  await writeFile(sourcePath, source);
  const applied: ThemeDefinition[] = [];
  let invalid = 0;
  const refresher = new ThemeHotRefresher({
    apply: (definition) => applied.push(definition),
    invalid() {
      invalid += 1;
      throw new Error("invalid observer failed");
    },
  });
  context.after(() => refresher.close());
  refresher.select({ name: "ocean", sourcePath });

  await writeFile(sourcePath, "{");
  await until(() => invalid === 1);
  await writeFile(sourcePath, source);
  await until(() => applied.length === 1);
});

test("watcher startup reconciliation does not reapply an unchanged theme", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-unchanged-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "ocean.json");
  await writeFile(sourcePath, JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#001122" } },
  }));

  const applied: ThemeDefinition[] = [];
  const refresher = new ThemeHotRefresher({ apply: (definition) => applied.push(definition) });
  context.after(() => refresher.close());
  refresher.select({ name: "ocean", sourcePath });

  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(applied.length, 0);
});

test("a watcher that could not start can be selected again after its directory appears", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-retry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "later", "ocean.json");
  const applied: ThemeDefinition[] = [];
  const refresher = new ThemeHotRefresher({ apply: (definition) => applied.push(definition) });
  context.after(() => refresher.close());

  refresher.select({ name: "ocean", sourcePath });
  await mkdir(join(root, "later"));
  await writeFile(sourcePath, JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#001122" } },
  }));
  refresher.select({ name: "ocean", sourcePath });
  await writeFile(sourcePath, JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#aabbcc" } },
  }));
  await until(() => applied.length === 1);
  assert.equal(applied[0]!.styles.accent?.foreground, "#aabbcc");
});

test("an asynchronous watcher error is handled and permits a fresh watcher", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-error-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "ocean.json");
  await writeFile(sourcePath, JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#001122" } },
  }));

  const probe = watch(root, { persistent: false }, () => undefined);
  const prototype = Object.getPrototypeOf(probe) as {
    on(this: FSWatcher, event: string, listener: (...arguments_: unknown[]) => void): FSWatcher;
  };
  probe.close();
  const originalOn = prototype.on;
  const watchers: FSWatcher[] = [];
  prototype.on = function(this: FSWatcher, event, listener) {
    if (event === "error") watchers.push(this);
    return originalOn.call(this, event, listener);
  };

  const refresher = new ThemeHotRefresher({ apply() {} });
  context.after(() => refresher.close());
  try {
    refresher.select({ name: "ocean", sourcePath });
    assert.equal(watchers.length, 1);
    assert.ok(watchers[0]!.listenerCount("error") > 0);
    assert.doesNotThrow(() => watchers[0]!.emit("error", new Error("simulated watcher failure")));

    refresher.select({ name: "ocean", sourcePath });
    assert.equal(watchers.length, 2);
    assert.notEqual(watchers[1], watchers[0]);
    assert.ok(watchers[1]!.listenerCount("error") > 0);
  } finally {
    prototype.on = originalOn;
  }
});
