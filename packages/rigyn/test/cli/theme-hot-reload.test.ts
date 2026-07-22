import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThemeHotReloader } from "../../src/cli/theme-hot-reload.js";
import type { ThemeDefinition } from "../../src/tui/theme.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for theme reload");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test("active loose themes hot-reload atomically and retain the last valid definition", async (context) => {
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
  const reloader = new ThemeHotReloader({
    apply: (definition) => applied.push(definition),
    invalid: (error) => invalid.push(error),
  });
  context.after(() => reloader.close());
  reloader.select({ name: "ocean", sourcePath });

  await writeFile(sourcePath, "{");
  await until(() => invalid.length === 1);
  assert.equal(applied.length, 0);

  await writeFile(sourcePath, source("#aabbcc"));
  await until(() => applied.length === 1);
  assert.equal(applied[0]!.styles.accent?.foreground, "#aabbcc");

  reloader.select(undefined);
  await writeFile(sourcePath, source("#ffffff"));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(applied.length, 1);
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
  const reloader = new ThemeHotReloader({ apply: (definition) => applied.push(definition) });
  context.after(() => reloader.close());
  reloader.select({ name: "ocean", sourcePath });

  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(applied.length, 0);
});

test("a watcher that could not start can be selected again after its directory appears", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-theme-watch-retry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "later", "ocean.json");
  const applied: ThemeDefinition[] = [];
  const reloader = new ThemeHotReloader({ apply: (definition) => applied.push(definition) });
  context.after(() => reloader.close());

  reloader.select({ name: "ocean", sourcePath });
  await mkdir(join(root, "later"));
  await writeFile(sourcePath, JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#001122" } },
  }));
  reloader.select({ name: "ocean", sourcePath });
  await writeFile(sourcePath, JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: "#aabbcc" } },
  }));
  await until(() => applied.length === 1);
  assert.equal(applied[0]!.styles.accent?.foreground, "#aabbcc");
});
