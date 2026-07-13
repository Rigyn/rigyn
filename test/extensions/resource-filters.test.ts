import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverExtensions, filterExtensionResources, listExtensionResources } from "../../src/extensions/index.js";

test("missing optional extension roots are empty while required roots remain diagnosable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-optional-extension-root-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const missing = join(root, "missing");

  const optional = await discoverExtensions([{ path: missing, scope: "user", trusted: true, optional: true }]);
  assert.equal(optional.doctor().healthy, true);
  assert.deepEqual(optional.doctor().diagnostics, []);

  const required = await discoverExtensions([{ path: missing, scope: "user", trusted: true }]);
  assert.equal(required.doctor().diagnostics[0]?.code, "EXTENSION_ROOT_MISSING");
});

test("package resource filters list and disable runtime, skills, prompts, commands, and themes independently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-filters-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "example");
  await mkdir(join(packageRoot, "skills", "example"), { recursive: true });
  await writeFile(join(packageRoot, "runtime.mjs"), "export default function activate() {}\n");
  await writeFile(join(packageRoot, "prompt.md"), "Review $ARGUMENTS\n");
  await writeFile(join(packageRoot, "command.md"), "Fix $ARGUMENTS\n");
  await writeFile(join(packageRoot, "theme.json"), JSON.stringify({
    schemaVersion: 1,
    name: "example-theme",
    base: "dark",
    styles: { accent: { foreground: 81 } },
  }));
  await writeFile(join(packageRoot, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example skill.\n---\nUse it.\n");
  await writeFile(join(packageRoot, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "example",
    name: "Example",
    contributions: {
      runtime: [{ path: "runtime.mjs" }],
      skillRoots: [{ path: "skills" }],
      prompts: [{ id: "example-prompt", path: "prompt.md" }],
      commands: [{ name: "example-command", path: "command.md" }],
      themes: [{ name: "example-theme", path: "theme.json" }],
    },
  }));

  const catalog = await discoverExtensions([{ path: root, scope: "user", trusted: true }]);
  assert.deepEqual(listExtensionResources(catalog).map(({ kind, key, enabled }) => ({ kind, key, enabled })), [
    { kind: "command", key: "command:example-command", enabled: true },
    { kind: "prompt", key: "prompt:example-prompt", enabled: true },
    { kind: "runtime", key: "runtime:runtime.mjs", enabled: true },
    { kind: "skill", key: "skill:skills", enabled: true },
    { kind: "theme", key: "theme:example-theme", enabled: true },
  ]);

  const filtered = filterExtensionResources(catalog, {
    example: ["runtime:runtime.mjs", "prompt:example-prompt", "theme:example-theme"],
  });
  assert.equal(filtered.bundle().runtime.length, 0);
  assert.equal(filtered.bundle().prompts.length, 0);
  assert.equal(filtered.bundle().themes.length, 0);
  assert.equal(filtered.bundle().commands.length, 1);
  assert.equal(filtered.bundle().skillRoots.length, 1);
  assert.deepEqual(listExtensionResources(catalog, {
    example: ["runtime:runtime.mjs", "prompt:example-prompt", "theme:example-theme"],
  }).filter((resource) => !resource.enabled).map((resource) => resource.key), [
    "prompt:example-prompt",
    "runtime:runtime.mjs",
    "theme:example-theme",
  ]);
});
