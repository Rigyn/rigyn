import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverSkills } from "../../src/context/index.js";
import {
  discoverExtensions,
  LocalExtensionPackageManager,
  parseExtensionManifest,
} from "../../src/extensions/index.js";

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

test("convention discovery honors hierarchical ignore files and excludes hidden resources", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "extensions", "nested"), { recursive: true });
  await mkdir(join(source, "prompts"), { recursive: true });
  await writeFile(join(source, ".gitignore"), "extensions/*.mjs\n!extensions/kept.mjs\n");
  await writeFile(join(source, "extensions", "nested", ".ignore"), "index.mjs\n");
  await writeFile(join(source, "prompts", ".fdignore"), "private.md\n");
  await writeFile(join(source, "extensions", "kept.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "ignored.mjs"), "throw new Error('ignored runtime loaded');\n");
  await writeFile(join(source, "extensions", ".hidden.mjs"), "throw new Error('hidden runtime loaded');\n");
  await writeFile(join(source, "extensions", "nested", "index.mjs"), "throw new Error('nested ignored runtime loaded');\n");
  await writeFile(join(source, "prompts", "public.md"), "Public $ARGUMENTS\n");
  await writeFile(join(source, "prompts", "private.md"), "Private $ARGUMENTS\n");
  await writeFile(join(source, "prompts", ".hidden.md"), "Hidden $ARGUMENTS\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "ignored-resource-kit", version: "0.1.0" }));

  const result = await new LocalExtensionPackageManager({ user: installed }).install(source);
  const generated = JSON.parse(await readFile(join(result.packageRoot, "extension.json"), "utf8")) as {
    contributions: { runtime: Array<{ path: string }>; prompts: Array<{ path: string }> };
  };
  assert.deepEqual(generated.contributions.runtime.map((entry) => entry.path), ["extensions/kept.mjs"]);
  assert.deepEqual(generated.contributions.prompts.map((entry) => entry.path), ["prompts/public.md"]);
});

test("convention packages expose direct root Markdown skills through the active catalog", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "skills"), { recursive: true });
  await writeFile(
    join(source, "skills", "review.md"),
    "---\nname: review\ndescription: Review a change.\n---\nReview it.\n",
  );
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "markdown-skill-kit", version: "0.1.0" }));

  const manager = new LocalExtensionPackageManager({ user: installed });
  await manager.install(source);
  const catalog = await discoverExtensions(manager.sources(true));
  const skills = await discoverSkills(catalog.bundle().skillRoots);
  assert.deepEqual(skills.map((entry) => entry.name), ["review"]);
});

test("convention skill declarations apply directory and direct-file exclusions before discovery", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "skills", "public"), { recursive: true });
  await mkdir(join(source, "skills", "internal"), { recursive: true });
  await writeFile(
    join(source, "skills", "public", "SKILL.md"),
    "---\nname: public\ndescription: Public skill.\n---\nUse it.\n",
  );
  await writeFile(
    join(source, "skills", "internal", "SKILL.md"),
    "---\nname: internal\ndescription: Internal skill.\n---\nDo not load it.\n",
  );
  await writeFile(
    join(source, "skills", "public-root.md"),
    "---\nname: public-root\ndescription: Public root skill.\n---\nUse it.\n",
  );
  await writeFile(
    join(source, "skills", "private.md"),
    "---\nname: private\ndescription: Private root skill.\n---\nDo not load it.\n",
  );
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "filtered-skill-kit",
    version: "0.1.0",
    rigyn: {
      skills: ["skills", "!skills/internal/**", "!skills/private.md"],
    },
  }));

  const manager = new LocalExtensionPackageManager({ user: installed });
  const result = await manager.install(source);
  const generated = JSON.parse(await readFile(join(result.packageRoot, "extension.json"), "utf8")) as {
    contributions: { skillRoots: Array<{ path: string }> };
  };
  assert.deepEqual(generated.contributions.skillRoots.map((entry) => entry.path), [
    "skills/public",
    "skills/public-root.md",
  ]);
  const catalog = await discoverExtensions(manager.sources(true));
  const skills = await discoverSkills(catalog.bundle().skillRoots);
  assert.deepEqual(skills.map((entry) => entry.name), ["public", "public-root"]);
});

test("convention runtime discovery activates entrypoints without treating nested helpers as extensions", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "extensions", "review"), { recursive: true });
  await mkdir(join(source, "extensions", "helper-only"), { recursive: true });
  await mkdir(join(source, "extensions", "deep", "nested"), { recursive: true });
  await writeFile(join(source, "extensions", "direct.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "types.d.ts"), "export declare const fixture: boolean;\n");
  await writeFile(join(source, "extensions", "types.d.mts"), "export declare const fixture: boolean;\n");
  await writeFile(join(source, "extensions", "review", "index.ts"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "review", "index.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "review", "helper.mjs"), "export const helper = true;\n");
  await writeFile(join(source, "extensions", "helper-only", "helper.mjs"), "export const helper = true;\n");
  await writeFile(join(source, "extensions", "deep", "nested", "index.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "entrypoint-kit", version: "0.1.0" }));

  const manager = new LocalExtensionPackageManager({ user: installed });
  const result = await manager.install(source);
  const generated = JSON.parse(await readFile(join(result.packageRoot, "extension.json"), "utf8")) as {
    contributions: { runtime: Array<{ path: string }> };
  };
  assert.deepEqual(generated.contributions.runtime.map((entry) => entry.path), [
    "extensions/direct.mjs",
    "extensions/review/index.ts",
  ]);
});

test("explicit convention runtime globs retain intentional nested entries and exclusions", async (t) => {
  const { source, installed } = await fixture(t);
  await mkdir(join(source, "extensions", "review", "deep"), { recursive: true });
  await mkdir(join(source, "extensions", "deep", "nested"), { recursive: true });
  await writeFile(join(source, "extensions", "direct.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "review", "helper.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "review", "deep", "helper.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "extensions", "deep", "nested", "index.mjs"), "export default function activate() {}\n");
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "explicit-entrypoint-kit",
    version: "0.1.0",
    rigyn: {
      extensions: ["extensions/**/*.mjs", "!extensions/review"],
    },
  }));

  const manager = new LocalExtensionPackageManager({ user: installed });
  const result = await manager.install(source);
  const generated = JSON.parse(await readFile(join(result.packageRoot, "extension.json"), "utf8")) as {
    contributions: { runtime: Array<{ path: string }> };
  };
  assert.deepEqual(generated.contributions.runtime.map((entry) => entry.path), [
    "extensions/deep/nested/index.mjs",
    "extensions/direct.mjs",
  ]);
});

test("handwritten manifests reject TypeScript declaration files as runtime entries", () => {
  for (const path of ["runtime/types.d.ts", "runtime/types.d.mts"]) {
    assert.throws(() => parseExtensionManifest({
      schemaVersion: 1,
      id: "declaration-runtime",
      name: "Declaration runtime",
      contributions: { runtime: [{ path }] },
    }), /declaration|runtime/u);
  }
});
