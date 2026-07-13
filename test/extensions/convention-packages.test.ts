import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverExtensions, LocalExtensionPackageManager } from "../../src/extensions/index.js";

async function fixture(t: test.TestContext): Promise<{ root: string; source: string; installed: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-convention-package-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const installed = join(root, "installed");
  await mkdir(source, { recursive: true });
  return { root, source, installed };
}

test("package.json rigyn declarations install without a handwritten extension manifest", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "agent", "skills", "review"), { recursive: true });
  await mkdir(join(source, "agent", "prompts"), { recursive: true });
  await mkdir(join(source, "agent", "themes"), { recursive: true });
  await writeFile(join(source, "agent", "extension.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "agent", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code.\n---\nReview it.\n");
  await writeFile(join(source, "agent", "prompts", "review.md"), "Review $ARGUMENTS\n");
  await writeFile(join(source, "agent", "themes", "ocean.json"), JSON.stringify({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: { accent: { foreground: 81 } },
  }));
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "@example/agent-kit",
    version: "1.2.3",
    description: "Convention package",
    rigyn: {
      extensions: ["agent/extension.mjs"],
      skills: ["agent/skills"],
      prompts: ["agent/prompts"],
      themes: ["agent/themes"],
    },
  }));

  const manager = new LocalExtensionPackageManager({ user: installed });
  const result = await manager.install(source);
  assert.equal(result.id, "example.agent-kit");
  assert.equal(result.version, "1.2.3");
  const generated = JSON.parse(await readFile(join(result.packageRoot, "extension.json"), "utf8")) as { id: string };
  assert.equal(generated.id, "example.agent-kit");
  const catalog = await discoverExtensions(manager.sources(true));
  assert.deepEqual(catalog.bundle().runtime.map((entry) => entry.extensionId), ["example.agent-kit"]);
  assert.deepEqual(catalog.bundle().prompts.map((entry) => entry.id), ["review"]);
  assert.deepEqual(catalog.bundle().themes.map((entry) => entry.name), ["ocean"]);
  assert.equal(catalog.bundle().skillRoots.length, 1);
});

test("conventional extensions, skills, prompts, and themes directories need only a package name", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "extensions"), { recursive: true });
  await mkdir(join(source, "skills", "helper"), { recursive: true });
  await mkdir(join(source, "prompts"), { recursive: true });
  await mkdir(join(source, "themes"), { recursive: true });
  await writeFile(join(source, "extensions", "index.js"), "export default function activate() {}\n");
  await writeFile(join(source, "skills", "helper", "SKILL.md"), "---\nname: helper\ndescription: Help.\n---\nHelp.\n");
  await writeFile(join(source, "prompts", "fix.md"), "Fix $ARGUMENTS\n");
  await writeFile(join(source, "themes", "forest.json"), JSON.stringify({
    schemaVersion: 1,
    name: "forest",
    base: "dark",
    styles: { success: { foreground: 114 } },
  }));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "convention-kit", version: "0.1.0" }));

  const manager = new LocalExtensionPackageManager({ user: installed });
  await manager.install(source);
  const catalog = await discoverExtensions(manager.sources(true));
  assert.equal(catalog.bundle().runtime.length, 1);
  assert.equal(catalog.bundle().skillRoots.length, 1);
  assert.deepEqual(catalog.bundle().prompts.map((entry) => entry.id), ["fix"]);
  assert.deepEqual(catalog.bundle().themes.map((entry) => entry.name), ["forest"]);
});
