import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

async function fixture(): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  packages: DefaultPackageManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-package-manager-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const settings = SettingsManager.inMemory();
  return { root, cwd, agentDir, settings, packages: new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }) };
}

test("package manifests and conventional directories resolve all resource classes", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "package");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await mkdir(join(packageRoot, "themes"), { recursive: true });
  await writeFile(join(packageRoot, "src", "extension.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review");
  await writeFile(join(packageRoot, "prompts", "review.md"), "Review this");
  await writeFile(join(packageRoot, "themes", "dark.json"), "{}");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture",
    rigyn: {
      extensions: ["src/extension.ts"],
      skills: ["skills"],
      prompts: ["prompts"],
      themes: ["themes"],
    },
  }));
  value.settings.setPackages([packageRoot]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [join(packageRoot, "src", "extension.ts")]);
  assert.equal(result.skills.some((entry) => entry.path === join(packageRoot, "skills", "review", "SKILL.md")), true);
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(packageRoot, "prompts", "review.md")]);
  assert.deepEqual(result.themes.map((entry) => entry.path), [join(packageRoot, "themes", "dark.json")]);
});

test("project resources win canonical duplicates and filters retain disabled entries", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "filtered");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "enabled.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "disabled.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "filtered" }));
  value.settings.setPackages([{ source: packageRoot, extensions: ["+extensions/enabled.ts", "-extensions/disabled.ts"] }]);
  await value.settings.flush();
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "disabled.ts"), false],
    [join(packageRoot, "extensions", "enabled.ts"), true],
  ]);
});

test("auto-discovery loads direct files, extension folders, skills, prompts, and themes", async () => {
  const value = await fixture();
  await mkdir(join(value.agentDir, "extensions", "folder"), { recursive: true });
  await mkdir(join(value.agentDir, "skills", "portable"), { recursive: true });
  await mkdir(join(value.agentDir, "prompts"), { recursive: true });
  await mkdir(join(value.agentDir, "themes"), { recursive: true });
  await writeFile(join(value.agentDir, "extensions", "direct.ts"), "export default () => {};");
  await writeFile(join(value.agentDir, "extensions", "folder", "index.js"), "export default () => {};");
  await writeFile(join(value.agentDir, "skills", "portable", "SKILL.md"), "# Portable");
  await writeFile(join(value.agentDir, "prompts", "ask.md"), "Ask");
  await writeFile(join(value.agentDir, "themes", "plain.json"), "{}");
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(value.agentDir, "extensions", "direct.ts"),
    join(value.agentDir, "extensions", "folder", "index.js"),
  ]);
  assert.equal(result.skills.some((entry) => entry.path === join(value.agentDir, "skills", "portable", "SKILL.md")), true);
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(value.agentDir, "prompts", "ask.md")]);
  assert.deepEqual(result.themes.map((entry) => entry.path), [join(value.agentDir, "themes", "plain.json")]);
});

test("auto-discovered extension packages contribute their declared companion resources", async () => {
  const value = await fixture();
  const packageRoot = join(value.agentDir, "extensions", "companion");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await writeFile(join(packageRoot, "index.ts"), "export default () => {};\n");
  await writeFile(join(packageRoot, "prompts", "inspect.md"), "Inspect");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "companion",
    rigyn: { extensions: ["index.ts"], prompts: ["prompts"] },
  }));

  const result = await value.packages.resolve();

  assert.deepEqual(result.extensions.map((entry) => entry.path), [join(packageRoot, "index.ts")]);
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(packageRoot, "prompts", "inspect.md")]);
  assert.equal(result.prompts[0]?.metadata.baseDir, packageRoot);
});

test("an explicit extension root resolves each direct child factory", async () => {
  const value = await fixture();
  const root = join(value.root, "extension-root");
  await mkdir(join(root, "folder"), { recursive: true });
  await writeFile(join(root, "direct.ts"), "export default () => {};\n");
  await writeFile(join(root, "folder", "index.js"), "export default () => {};\n");

  const result = await value.packages.resolveExtensionSources([root], { temporary: true });

  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(root, "direct.ts"),
    join(root, "folder", "index.js"),
  ]);
  assert.equal(result.extensions.every((entry) => entry.metadata.baseDir === root), true);
});

test("local lifecycle persists scope-relative sources without deleting user code", async () => {
  const value = await fixture();
  const extension = join(value.cwd, "extension.ts");
  await writeFile(extension, "export default () => {};");
  await value.packages.installAndPersist(extension, { local: true });
  await value.settings.flush();
  assert.deepEqual(value.settings.getProjectSettings().packages, ["../extension.ts"]);
  assert.equal(value.packages.getInstalledPath("../extension.ts", "project"), extension);
  assert.equal(await value.packages.removeAndPersist(extension, { local: true }), true);
  await value.settings.flush();
  assert.deepEqual(value.settings.getProjectSettings().packages, []);
});

test("untrusted project packages cannot access project-managed storage", async () => {
  const value = await fixture();
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const packages = new DefaultPackageManager({ cwd: value.cwd, agentDir: value.agentDir, settingsManager: settings });
  assert.throws(() => packages.addSourceToSettings("npm:example", { local: true }), /not trusted/iu);
  await assert.rejects(packages.install("npm:example", { local: true }), /not trusted/iu);
});

test("untrusted resolution omits project resources while retaining user resources", async () => {
  const value = await fixture();
  const userExtension = join(value.agentDir, "extensions", "user.ts");
  const projectExtension = join(value.cwd, ".rigyn", "extensions", "project.ts");
  await mkdir(join(value.agentDir, "extensions"), { recursive: true });
  await mkdir(join(value.cwd, ".rigyn", "extensions"), { recursive: true });
  await writeFile(userExtension, "export default () => {};");
  await writeFile(projectExtension, "export default () => {};");
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const packages = new DefaultPackageManager({ cwd: value.cwd, agentDir: value.agentDir, settingsManager: settings });
  const resolved = await packages.resolve();
  assert.deepEqual(resolved.extensions.map((entry) => entry.path), [userExtension]);
});

test("manifest globs and override order select explicit resources", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "globbed");
  await mkdir(join(packageRoot, "extensions", "nested"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "two.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "nested", "three.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "globbed",
    rigyn: { extensions: ["extensions/**/*.ts", "!**/two.ts", "+extensions/two.ts", "-extensions/nested/three.ts"] },
  }));
  value.settings.setPackages([packageRoot]);
  await value.settings.flush();
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(packageRoot, "extensions", "one.ts"),
    join(packageRoot, "extensions", "two.ts"),
  ]);
});

test("autoload-disabled project filters reuse a configured user package as a delta", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "shared");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "two.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "shared" }));
  value.settings.setPackages([packageRoot]);
  value.settings.setProjectPackages([{ source: packageRoot, autoload: false, extensions: ["+extensions/two.ts"] }]);
  await value.settings.flush();
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled, entry.metadata.scope]), [
    [join(packageRoot, "extensions", "two.ts"), true, "project"],
    [join(packageRoot, "extensions", "one.ts"), true, "user"],
  ]);
});

test("project portable skills are discovered from cwd through repository root", async () => {
  const value = await fixture();
  const repository = join(value.root, "repository");
  const cwd = join(repository, "packages", "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(repository, ".agents", "skills", "root"), { recursive: true });
  await mkdir(join(repository, "packages", ".agents", "skills", "middle"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(repository, ".agents", "skills", "root", "SKILL.md"), "# Root");
  await writeFile(join(repository, "packages", ".agents", "skills", "middle", "SKILL.md"), "# Middle");
  const packages = new DefaultPackageManager({ cwd, agentDir: value.agentDir, settingsManager: value.settings });
  const result = await packages.resolve();
  assert.equal(result.skills.some((entry) => entry.path.endsWith(join("root", "SKILL.md"))), true);
  assert.equal(result.skills.some((entry) => entry.path.endsWith(join("middle", "SKILL.md"))), true);
});
