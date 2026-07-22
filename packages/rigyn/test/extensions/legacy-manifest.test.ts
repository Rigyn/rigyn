import assert from "node:assert/strict";
import test from "node:test";

import { parseLegacyExtensionManifest } from "../../src/extensions/legacy-manifest.js";

function manifest(contributions: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "portable-paths",
    name: "Portable paths",
    contributions,
  };
}

test("legacy contribution paths reject Windows drive-qualified forms on every host", () => {
  const cases: Record<string, unknown>[] = [
    { skillRoots: [{ path: "C:extensions/skills" }] },
    { prompts: [{ id: "drive-prompt", path: "C:extensions/prompt.md" }] },
    { commands: [{ name: "drive-command", path: "C:extensions/command.md" }] },
    { themes: [{ name: "theme", path: "C:extensions/theme.json" }] },
    { runtime: [{ path: "C:extensions/runtime.mjs" }] },
  ];

  for (const contributions of cases) {
    assert.throws(() => parseLegacyExtensionManifest(manifest(contributions)), /normalized relative path/u);
  }
});

test("legacy theme contributions cannot shadow built-in themes", () => {
  for (const name of ["mono", "signal"]) {
    assert.throws(
      () => parseLegacyExtensionManifest(manifest({ themes: [{ name, path: "themes/custom.json" }] })),
      /invalid or reserved/u,
    );
  }
});

test("legacy integrity paths reject Windows drive-qualified forms on every host", () => {
  assert.throws(() => parseLegacyExtensionManifest({
    ...manifest({}),
    integrity: { "C:extensions/runtime.mjs": "a".repeat(64) },
  }), /normalized relative path/u);
});
