import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadSkills } from "../../src/core/skills.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import {
  PROJECT_PACKAGE_DECLARATION,
  ProjectPackageManager,
} from "../../src/extensions/project-packages.js";
import { canonicalizePath } from "../../src/utils/paths.js";

const schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

async function fixture(context: TestContext): Promise<{
  agentDir: string;
  cwd: string;
  root: string;
  settings: SettingsManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-portable-plugin-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir, settings: SettingsManager.inMemory() };
}

function skill(name: string, description = `Use ${name} for focused work.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function writeManifest(root: string, value: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(root, "plugin.json"), `${JSON.stringify({ $schema: schema, name: "portable-tools", ...value }, null, 2)}\n`);
}

test("portable plugins map skills and namespaced Rigyn resources into the existing runtime", async (context) => {
  const value = await fixture(context);
  const plugin = join(value.root, "portable-tools");
  await mkdir(join(plugin, "skills", "review"), { recursive: true });
  await mkdir(join(plugin, "skills", "container", "nested"), { recursive: true });
  await mkdir(join(plugin, "io.github.rigyn", "extensions"), { recursive: true });
  await mkdir(join(plugin, "io.github.rigyn", "prompts"), { recursive: true });
  await mkdir(join(plugin, "io.github.rigyn", "themes"), { recursive: true });
  await writeManifest(plugin, {
    ignored: "reported but not interpreted",
    extensions: { "org.example.unimplemented": false },
  });
  await writeFile(join(plugin, "skills", "review", "SKILL.md"), skill("review"));
  await writeFile(join(plugin, "skills", "container", "nested", "SKILL.md"), skill("nested"));
  await writeFile(join(plugin, "mcp.json"), "not JSON and intentionally unsupported\n");
  await writeFile(join(plugin, "io.github.rigyn", "extensions", "index.mjs"), [
    "export default (api) => {",
    "  api.registerCommand('portable-probe', { handler() {} });",
    "};",
  ].join("\n"));
  await writeFile(join(plugin, "io.github.rigyn", "prompts", "review.md"), "Review $@\n");
  await writeFile(join(plugin, "io.github.rigyn", "themes", "signal.json"), "{}\n");
  value.settings.setPackages([plugin]);

  const manager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  const resolved = await manager.resolve();

  assert.deepEqual(resolved.extensions.map((entry) => entry.path), [
    join(plugin, "io.github.rigyn", "extensions", "index.mjs"),
  ]);
  assert.deepEqual(resolved.skills.map((entry) => entry.path), [
    join(plugin, "skills", "review", "SKILL.md"),
  ]);
  assert.deepEqual(resolved.prompts.map((entry) => entry.path), [
    join(plugin, "io.github.rigyn", "prompts", "review.md"),
  ]);
  assert.deepEqual(resolved.themes.map((entry) => entry.path), [
    join(plugin, "io.github.rigyn", "themes", "signal.json"),
  ]);
  assert.equal(resolved.skills[0]?.metadata.skillValidation?.format, "portable-plugin-1.0.0");
  assert.deepEqual(manager.getDiagnostics().map((entry) => entry.code), [
    "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED",
  ]);

  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    noPromptTemplates: true,
    noThemes: true,
  });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.refresh();
  assert.equal(loader.getSkills().skills.some((entry) => entry.name === "review"), true);
  assert.equal(loader.getExtensions().extensions.some((entry) => entry.commands.has("portable-probe")), true);
  assert.equal(loader.getSkills().diagnostics.some((entry) =>
    entry.code === "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED"), true);
});

test("an invalid plugin manifest is authoritative and never falls through to native discovery", async (context) => {
  const value = await fixture(context);
  const plugin = join(value.root, "invalid-portable");
  await mkdir(join(plugin, "extensions"), { recursive: true });
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ $schema: schema, name: "Invalid-Name" }));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: "native-fallback",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(plugin, "extensions", "index.mjs"), "export default () => {};\n");
  value.settings.setPackages([plugin]);
  const manager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });

  const resolved = await manager.resolve();
  assert.equal(resolved.extensions.some((entry) => entry.path.startsWith(plugin)), false);
  assert.equal(manager.getDiagnostics().some((entry) =>
    entry.code === "PORTABLE_PLUGIN_MANIFEST_INVALID" && entry.severity === "error"), true);

  await assert.rejects(manager.installAndPersist(plugin), /Portable plugin manifest is invalid/u);
});

test("portable manifest failure exceptions are reported without weakening fatal validation", async (context) => {
  const value = await fixture(context);
  const tolerated = join(value.root, "tolerated-manifest");
  await mkdir(join(tolerated, "skills", "usable"), { recursive: true });
  await writeManifest(tolerated, { extensions: "ignored", extra: true });
  await writeFile(join(tolerated, "skills", "usable", "SKILL.md"), skill("usable"));
  const toleratedSettings = SettingsManager.inMemory();
  toleratedSettings.setPackages([tolerated]);
  const toleratedManager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: toleratedSettings,
  });
  assert.equal((await toleratedManager.resolve()).skills.length, 1);
  assert.deepEqual(toleratedManager.getDiagnostics().map((entry) => entry.code), [
    "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED",
    "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED",
  ]);

  const fatal = join(value.root, "fatal-manifest");
  await mkdir(join(fatal, "skills", "hidden"), { recursive: true });
  await writeManifest(fatal, { author: { name: "Example", unexpected: true } });
  await writeFile(join(fatal, "skills", "hidden", "SKILL.md"), skill("hidden"));
  const fatalSettings = SettingsManager.inMemory();
  fatalSettings.setPackages([fatal]);
  const fatalManager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: fatalSettings,
  });
  assert.deepEqual((await fatalManager.resolve()).skills, []);
  assert.equal(fatalManager.getDiagnostics()[0]?.code, "PORTABLE_PLUGIN_MANIFEST_INVALID");
});

test("portable skill failures are isolated and runtime loading revalidates accepted sources", async (context) => {
  const value = await fixture(context);
  const plugin = join(value.root, "skill-validation");
  const valid = join(plugin, "skills", "valid", "SKILL.md");
  const invalid = join(plugin, "skills", "invalid", "SKILL.md");
  await mkdir(join(plugin, "skills", "valid"), { recursive: true });
  await mkdir(join(plugin, "skills", "invalid"), { recursive: true });
  await writeManifest(plugin);
  await writeFile(valid, skill("valid"));
  await writeFile(invalid, skill("wrong-directory"));
  value.settings.setPackages([plugin]);
  const manager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });

  const resolved = await manager.resolve();
  assert.deepEqual(resolved.skills.map((entry) => entry.path), [valid]);
  assert.equal(manager.getDiagnostics().some((entry) => entry.code === "PORTABLE_PLUGIN_SKILL_INVALID"), true);

  await writeFile(valid, skill("changed-after-discovery"));
  const strict = loadSkills({
    cwd: value.cwd,
    agentDir: value.agentDir,
    includeDefaults: false,
    skillPaths: [valid],
    strictSkillRoots: new Map([[canonicalizePath(valid), plugin]]),
  });
  assert.deepEqual(strict.skills, []);
  assert.equal(strict.diagnostics[0]?.code, "PORTABLE_PLUGIN_SKILL_INVALID");

  const native = loadSkills({
    cwd: value.cwd,
    agentDir: value.agentDir,
    includeDefaults: false,
    skillPaths: [valid],
  });
  assert.equal(native.skills.length, 1);
});

test("an invalid fixed skill location does not block namespaced resources", async (context) => {
  const value = await fixture(context);
  const plugin = join(value.root, "invalid-skills-location");
  await mkdir(join(plugin, "io.github.rigyn", "prompts"), { recursive: true });
  await writeManifest(plugin);
  await writeFile(join(plugin, "skills"), "not a directory\n");
  await writeFile(join(plugin, "io.github.rigyn", "prompts", "usable.md"), "Use this prompt.\n");
  value.settings.setPackages([plugin]);
  const manager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });

  const resolved = await manager.resolve();
  assert.deepEqual(resolved.skills, []);
  assert.deepEqual(resolved.prompts.map((entry) => entry.path), [
    join(plugin, "io.github.rigyn", "prompts", "usable.md"),
  ]);
  assert.equal(manager.getDiagnostics()[0]?.code, "PORTABLE_PLUGIN_SKILLS_INVALID");
});

test("portable component containment applies the narrowest failure boundary", {
  skip: process.platform === "win32" ? "symbolic-link creation is not portable on Windows CI" : false,
}, async (context) => {
  const value = await fixture(context);
  const outside = join(value.root, "outside");
  const plugin = join(value.root, "contained-plugin");
  await mkdir(join(outside, "escaped"), { recursive: true });
  await mkdir(join(outside, "external-skill"), { recursive: true });
  await mkdir(join(plugin, "skills", "safe"), { recursive: true });
  await mkdir(join(plugin, "bundled", "linked"), { recursive: true });
  await mkdir(join(plugin, "io.github.rigyn"), { recursive: true });
  await writeManifest(plugin);
  await writeFile(join(plugin, "skills", "safe", "SKILL.md"), skill("safe"));
  await writeFile(join(plugin, "bundled", "linked", "SKILL.md"), skill("linked"));
  await writeFile(join(outside, "external-skill", "SKILL.md"), skill("escape"));
  await writeFile(join(outside, "escaped", "index.mjs"), "export default () => {};\n");
  await symlink(join(plugin, "bundled", "linked"), join(plugin, "skills", "linked"), "dir");
  await symlink(join(outside, "external-skill"), join(plugin, "skills", "escape"), "dir");
  await symlink(join(outside, "escaped"), join(plugin, "io.github.rigyn", "extensions"), "dir");
  value.settings.setPackages([plugin]);
  const manager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });

  const resolved = await manager.resolve();
  assert.deepEqual(new Set(resolved.skills.map((entry) => entry.path)), new Set([
    join(plugin, "bundled", "linked", "SKILL.md"),
    join(plugin, "skills", "safe", "SKILL.md"),
  ]));
  assert.deepEqual(resolved.extensions, []);
  assert.equal(manager.getDiagnostics().some((entry) => entry.code === "PORTABLE_PLUGIN_NAMESPACE_INVALID"), true);
  assert.equal(manager.getDiagnostics().some((entry) => entry.code === "PORTABLE_PLUGIN_SKILL_PATH_ESCAPE"), true);

  const escapedManifestRoot = join(value.root, "escaped-manifest");
  await mkdir(escapedManifestRoot);
  await symlink(join(plugin, "plugin.json"), join(escapedManifestRoot, "plugin.json"), "file");
  const escapedManager = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const escaped = await escapedManager.resolveExtensionSources([escapedManifestRoot], { temporary: true });
  assert.deepEqual(escaped.extensions, []);
  assert.equal(escapedManager.getDiagnostics()[0]?.code, "PORTABLE_PLUGIN_MANIFEST_INVALID");
});

test("declarative project packages accept a portable manifest without changing their transaction model", async (context) => {
  const value = await fixture(context);
  const source = join(value.cwd, "portable-source");
  await mkdir(join(value.cwd, ".rigyn"));
  await mkdir(join(source, "skills", "project-review"), { recursive: true });
  await writeManifest(source, { version: "1.2.3", description: "Portable project resources" });
  await writeFile(join(source, "skills", "project-review", "SKILL.md"), skill("project-review"));
  await writeFile(join(value.cwd, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "portable", source: { kind: "local", path: "portable-source" } }],
  })}\n`);

  const updated = await new ProjectPackageManager({
    workspace: value.cwd,
    projectTrusted: true,
    operationLeaseRoot: join(value.root, "leases"),
  }).update({ all: true });

  assert.equal(updated.status, "ready");
  assert.equal(updated.packages[0]?.name, "portable-tools");
  assert.equal(updated.packages[0]?.version, "1.2.3");
  assert.equal(updated.packages[0]?.manifestPath.endsWith("plugin.json"), true);
});
