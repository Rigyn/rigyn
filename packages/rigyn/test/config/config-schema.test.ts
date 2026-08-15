import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Check } from "typebox/value";

import { InMemorySettingsStorage, SETTINGS_KEYS, SettingsManager } from "../../src/core/settings-manager.js";
import { CONFIG_SCHEMA_URI, hasNullValue, PORTABLE_CONFIG_SCAFFOLD } from "../helpers/config-scaffold.js";

test("the versioned config schema accepts the portable installed scaffold and describes every core setting", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../../resources/schemas/config-v1.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const template = JSON.parse(
    await readFile(new URL("../../resources/config.example.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONFIG_SCHEMA_URI);
  assert.deepEqual(template, PORTABLE_CONFIG_SCAFFOLD);
  assert.equal(hasNullValue(template), false);
  assert.deepEqual(
    Object.keys(schema.properties as Record<string, unknown>).filter((key) => key !== "$schema"),
    SETTINGS_KEYS,
  );
  assert.equal(Check(schema as never, template), true);
  assert.equal(Check(schema as never, {
    $schema: CONFIG_SCHEMA_URI,
    defaultModel: null,
    compaction: { enabled: null, recentTokens: null },
    retry: { provider: { timeoutMs: null } },
    tools: null,
    keybindings: { "app.exit": null },
  }), true);
  assert.equal(Check(schema as never, { ...template, misspelledCoreSetting: true }), false);
  assert.equal(Check(schema as never, { ...template, compaction: { triggerPercent: 49 } }), false);
  assert.equal(Check(schema as never, { ...template, compaction: { recentTokens: 0 } }), false);
  assert.equal(Check(schema as never, { ...template, keybindings: { "app.exit": "" } }), false);
});

test("schema metadata stays out of effective settings while unknown extension fields remain compatible", () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({
    $schema: CONFIG_SCHEMA_URI,
    extensionOwned: { enabled: true },
    ["__proto__"]: { global: true },
    theme: "signal",
  }));
  storage.withLock("project", () => JSON.stringify({
    ["__proto__"]: { project: true },
  }));
  const manager = SettingsManager.fromStorage(storage);
  const effective = manager.getSettings() as Record<string, unknown>;

  assert.equal("$schema" in effective, false);
  assert.deepEqual(effective.extensionOwned, { enabled: true });
  assert.equal(Object.hasOwn(effective, "__proto__"), true);
  assert.deepEqual(effective.__proto__, { global: true, project: true });
  assert.equal(Object.getPrototypeOf(effective), Object.prototype);
  assert.equal(effective.theme, "signal");
});
