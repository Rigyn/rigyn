import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

interface InventoryEntry {
  subpath: string;
  kind: "library" | "wildcard-library" | "executable" | "metadata";
  tests: string[];
}

interface InventoryPackage {
  name: string;
  manifest: string;
  entries: InventoryEntry[];
}

interface Inventory {
  schemaVersion: number;
  evidenceLimits: Array<{ scope: string; apis: string[]; reason: string }>;
  packages: InventoryPackage[];
}

interface NamedExportInventory {
  schemaVersion: number;
  entries: Record<string, { runtime: string[]; typeOnly: string[] }>;
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const inventoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../release/public-runtime-export-inventory.json");
const namedInventoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../release/public-named-export-inventory.json");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function sourceModules(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await sourceModules(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) output.push(path);
  }
  return output.sort();
}

test("runtime export inventory exactly maps every declared package entry to an evidence file", async () => {
  const inventory = await json(inventoryPath) as unknown as Inventory;
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.evidenceLimits.length > 0, true);
  for (const limit of inventory.evidenceLimits) {
    assert.match(limit.scope, /[A-Za-z]/u);
    assert.equal(limit.apis.length > 0, true);
    assert.match(limit.reason, /[A-Za-z]/u);
  }
  assert.deepEqual(inventory.packages.map((entry) => entry.name).sort(), [
    "@rigyn/kernel",
    "@rigyn/models",
    "@rigyn/terminal",
    "rigyn",
  ]);

  for (const packageEntry of inventory.packages) {
    const manifest = await json(join(repository, packageEntry.manifest));
    assert.equal(manifest.name, packageEntry.name);
    const declared = manifest.exports === undefined
      ? ["."]
      : Object.keys(manifest.exports as Record<string, unknown>);
    const inventoried = packageEntry.entries.map((entry) => entry.subpath);
    assert.deepEqual(inventoried, declared, `${packageEntry.name} export inventory drifted from package.json`);
    assert.equal(new Set(inventoried).size, inventoried.length, `${packageEntry.name} has duplicate inventory entries`);

    for (const entry of packageEntry.entries) {
      assert.equal(entry.tests.length > 0, true, `${packageEntry.name}${entry.subpath} has no semantic test`);
      for (const mapping of entry.tests) {
        const separator = mapping.indexOf("#");
        assert.notEqual(separator, -1, `${mapping} must identify a test behavior after #`);
        const path = join(repository, mapping.slice(0, separator));
        await access(path);
        const behavior = mapping.slice(separator + 1);
        assert.match(behavior, /[A-Za-z]/u);
      }
    }
  }
});

test("wildcard AI entry points execute as source modules and expose initialized values", async () => {
  for (const directory of [
    join(repository, "packages/models/src/providers"),
    join(repository, "packages/models/src/api"),
  ]) {
    const modules = await sourceModules(directory);
    assert.equal(modules.length > 0, true);
    let codeBearing = 0;
    for (const path of modules) {
      const exports = await import(pathToFileURL(path).href) as Record<string, unknown>;
      const values = Object.values(exports);
      if (values.length === 0) continue;
      codeBearing += 1;
      assert.equal(values.every((value) => value !== undefined), true, path);
    }
    assert.equal(codeBearing > 0, true, `${directory} has no executable wildcard entry points`);
  }
});

test("named export baseline structurally covers every code-bearing rigyn entry point", async () => {
  const inventory = await json(namedInventoryPath) as unknown as NamedExportInventory;
  const manifest = await json(join(repository, "packages/rigyn/package.json"));
  const codeEntries = Object.entries(manifest.exports as Record<string, unknown>)
    .filter(([, value]) => typeof value === "object" && value !== null && "types" in value)
    .map(([subpath]) => subpath === "." ? "." : subpath.slice(2));
  assert.equal(inventory.schemaVersion, 1);
  assert.deepEqual(Object.keys(inventory.entries), codeEntries);
  for (const [entry, exports] of Object.entries(inventory.entries)) {
    assert.equal(exports.runtime.length > 0, true, `${entry} has no runtime bindings`);
    assert.deepEqual(exports.runtime, [...new Set(exports.runtime)].sort(), `${entry} runtime bindings are not canonical`);
    assert.deepEqual(exports.typeOnly, [...new Set(exports.typeOnly)].sort(), `${entry} type-only bindings are not canonical`);
    assert.equal(exports.runtime.some((name) => exports.typeOnly.includes(name)), false, `${entry} classifies a binding twice`);
  }
});
