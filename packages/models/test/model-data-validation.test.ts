import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createModelDataManifest,
  MODEL_DATA_MANIFEST_FILE,
  MODEL_DATA_SCHEMA_VERSION,
  readModelDataStructure,
  validateModelDataDirectory,
} from "../scripts/model-data.mjs";
import { parseGeneratorOptions, replaceDirectoryAtomically } from "../../../scripts/generate-provider-models.mjs";

interface Fixture {
  dataDir: string;
  root: string;
  structure: Record<string, Record<string, string>>;
  values: Record<string, Record<string, unknown>>;
}

function writeData(fixture: Fixture, schemaVersion = MODEL_DATA_SCHEMA_VERSION): void {
  const content = `${JSON.stringify(fixture.values)}\n`;
  writeFileSync(join(fixture.dataDir, "test-provider.json"), content);
  const manifest = createModelDataManifest(fixture.structure, { "test-provider.json": content });
  manifest.schemaVersion = schemaVersion;
  writeFileSync(join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rigyn-model-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const providersDir = join(root, "src", "providers");
  const dataDir = join(providersDir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, "src", "models.generated.ts"), `import { TEST_PROVIDER_MODELS } from "./providers/test-provider.models.js";\n`);
  writeFileSync(join(providersDir, "test-provider.models.ts"), `import values from "./data/test-provider.json" with { type: "json" };
import type { Model } from "../types.js";
export const TEST_PROVIDER_MODELS = Object.freeze(values) as Readonly<{
  "model-a": Model<"openai-completions"> & {
    id: "model-a";
    provider: "test-provider";
  };
}>;
`);
  const structure = readModelDataStructure(root);
  const result: Fixture = {
    dataDir,
    root,
    structure,
    values: {
      "model-a": {
        id: "model-a",
        name: "Model A",
        api: "openai-completions",
        provider: "test-provider",
        baseUrl: "https://example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      },
    },
  };
  writeData(result);
  return result;
}

test("generated provider data validates against structural shards and its manifest", (t) => {
  const current = fixture(t);
  assert.doesNotThrow(() => validateModelDataDirectory(current.structure, current.dataDir));
});

test("generated provider data accepts Windows CRLF TypeScript shards", (t) => {
  const current = fixture(t);
  const providerPath = join(current.root, "src", "providers", "test-provider.models.ts");
  writeFileSync(providerPath, readFileSync(providerPath, "utf8").replaceAll("\n", "\r\n"));
  assert.deepEqual(readModelDataStructure(current.root), current.structure);
});

test("generated provider data permits providers with an empty maintained projection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-empty-model-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const providersDir = join(root, "src", "providers");
  const dataDir = join(providersDir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, "src", "models.generated.ts"), `import { EMPTY_PROVIDER_MODELS } from "./providers/empty-provider.models.js";\n`);
  writeFileSync(join(providersDir, "empty-provider.models.ts"), `import values from "./data/empty-provider.json" with { type: "json" };
import type { Model } from "../types.js";
export const EMPTY_PROVIDER_MODELS = Object.freeze(values) as Readonly<{
}>;
`);
  const structure = readModelDataStructure(root);
  const content = "{}\n";
  writeFileSync(join(dataDir, "empty-provider.json"), content);
  writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(createModelDataManifest(structure, { "empty-provider.json": content }))}\n`);
  assert.deepEqual(structure, { "empty-provider": {} });
  assert.doesNotThrow(() => validateModelDataDirectory(structure, dataDir));
});

test("generated provider data rejects identity drift, stale hashes, and incompatible schemas", (t) => {
  const current = fixture(t);
  current.values["model-a"]!.provider = "wrong-provider";
  writeData(current);
  assert.throws(() => validateModelDataDirectory(current.structure, current.dataDir), /has provider/u);

  current.values["model-a"]!.provider = "test-provider";
  writeData(current, MODEL_DATA_SCHEMA_VERSION + 1);
  assert.throws(() => validateModelDataDirectory(current.structure, current.dataDir), /model data schema/u);

  writeData(current);
  writeFileSync(join(current.dataDir, "test-provider.json"), "{}\n");
  assert.throws(() => validateModelDataDirectory(current.structure, current.dataDir), /manifest hash|model IDs/u);
});

test("generated provider data rejects structural aggregator drift", (t) => {
  const current = fixture(t);
  writeFileSync(join(current.root, "src", "models.generated.ts"), `import { MISSING_MODELS } from "./providers/missing.models.js";\n`);
  assert.throws(() => readModelDataStructure(current.root), /aggregator and provider shards do not match/u);
});

test("model generation modes keep strict hydration separate from validation", () => {
  assert.deepEqual(parseGeneratorOptions(["--strict", "--data-only"]), { check: false, checkData: false, dataOnly: true, strict: true });
  assert.throws(() => parseGeneratorOptions(["--data-only"]), /requires --strict/u);
  assert.throws(() => parseGeneratorOptions(["--check", "--data-only", "--strict"]), /mutually exclusive/u);
});

test("manifest hashes cover the exact serialized shard bytes", (t) => {
  const current = fixture(t);
  const manifestPath = join(current.dataDir, MODEL_DATA_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Record<string, string> };
  assert.equal(manifest.files["test-provider.json"]?.length, 64);
  writeFileSync(join(current.dataDir, "test-provider.json"), `${readFileSync(join(current.dataDir, "test-provider.json"), "utf8")} `);
  assert.throws(() => validateModelDataDirectory(current.structure, current.dataDir), /manifest hash/u);
});

test("atomic directory replacement restores the previous generation when validation fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-model-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, "current");
  const staged = join(root, "staged");
  const backup = join(root, "backup");
  mkdirSync(current);
  mkdirSync(staged);
  writeFileSync(join(current, "value.json"), "previous\n");
  writeFileSync(join(staged, "value.json"), "invalid replacement\n");
  assert.throws(() => replaceDirectoryAtomically(current, staged, backup, () => {
    throw new Error("validation failed");
  }), /validation failed/u);
  assert.equal(readFileSync(join(current, "value.json"), "utf8"), "previous\n");
  assert.equal(existsSync(backup), false);
});
