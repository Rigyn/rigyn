import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverExtensions,
  LocalExtensionPackageManager,
  parseExtensionManifest,
} from "../../src/extensions/index.js";

test("extension host compatibility uses semantic-version ranges and produces actionable diagnostics", async (t) => {
  assert.equal(parseExtensionManifest({
    schemaVersion: 1,
    id: "compatible",
    compatibility: { hostVersion: ">=0.1.0 <0.2.0" },
    contributions: {},
  }).hostVersionRange, ">=0.1.0 <0.2.0");
  assert.throws(() => parseExtensionManifest({
    schemaVersion: 1,
    id: "invalid-range",
    compatibility: { hostVersion: "definitely not semver" },
    contributions: {},
  }), /semantic-version range/u);

  const root = await mkdtemp(join(tmpdir(), "harness-package-compatibility-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (const [id, range] of [["compatible", ">=0.1.0 <0.2.0"], ["future", ">=9.0.0"]] as const) {
    const extension = join(root, id);
    await mkdir(extension);
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id,
      compatibility: { hostVersion: range },
      contributions: {},
    }));
  }
  const catalog = await discoverExtensions([{ path: root, scope: "user", trusted: true }]);
  assert.equal(catalog.list().find((entry) => entry.id === "compatible")?.status, "active");
  assert.equal(catalog.list().find((entry) => entry.id === "compatible")?.hostVersionRange, ">=0.1.0 <0.2.0");
  assert.equal(catalog.list().find((entry) => entry.id === "future")?.status, "invalid");
  assert.match(
    catalog.doctor().diagnostics.find((entry) => entry.extensionId === "future")?.message ?? "",
    /requires Rigyn >=9\.0\.0; current version is 0\.1\.2/u,
  );
});

test("package.json convention packages enforce rigyn.hostVersion before activation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-convention-compatibility-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(join(source, "prompts"), { recursive: true });
  await writeFile(join(source, "prompts", "future.md"), "future\n");
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "future-package",
    version: "1.0.0",
    rigyn: {
      hostVersion: ">=9.0.0",
      prompts: ["prompts"],
    },
  }));

  const manager = new LocalExtensionPackageManager({ user: join(root, "installed") });
  await assert.rejects(manager.install(source), /requires Rigyn >=9\.0\.0/u);
  assert.deepEqual(await manager.list(), []);
});

test("invocation extensions keep explicit scope and override persistent copies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-invocation-scope-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const user = join(root, "user");
  const invocation = join(root, "invocation");
  for (const [source, description] of [[user, "persistent"], [invocation, "one run"]] as const) {
    await mkdir(join(source, "same"), { recursive: true });
    await writeFile(join(source, "same", "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "same",
      description,
      contributions: {},
    }));
  }

  const catalog = await discoverExtensions([
    { path: user, scope: "user", trusted: true },
    { path: invocation, scope: "invocation", trusted: true },
  ]);
  const selected = catalog.list().find((entry) => entry.status === "active");
  const persistent = catalog.list().find((entry) => entry.scope === "user");
  assert.equal(selected?.scope, "invocation");
  assert.equal(selected?.description, "one run");
  assert.ok((selected?.precedence ?? 0) > (persistent?.precedence ?? 0));
  assert.equal(persistent?.status, "shadowed");
});
