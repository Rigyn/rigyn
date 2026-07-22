import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { portableLocalPackageSource } from "../../src/utils/paths.js";

async function fixture(cwdSuffix = "workspace"): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  packages: DefaultPackageManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-packages-edge-"));
  const cwd = join(root, cwdSuffix);
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settings = SettingsManager.inMemory();
  return {
    root,
    cwd,
    agentDir,
    settings,
    packages: new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }),
  };
}

async function fakeGitCommand(root: string): Promise<{
  command: [string, ...string[]];
  npmCommand: [string, ...string[]];
  state: string;
}> {
  const state = join(root, "git-state");
  const script = join(root, "git-fixture.mjs");
  const npmScript = join(root, "npm-fixture.mjs");
  await writeFile(state, "1");
  await writeFile(script, [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const state = process.argv[2];',
    'const args = process.argv.slice(3);',
    'const selected = readFileSync(state, "utf8").trim();',
    'const advertised = selected === "race" ? "1" : selected;',
    'const checkedOut = selected === "race" ? "2" : selected;',
    'if (args.includes("clone")) {',
    '  const repository = args.at(-2);',
    '  const target = args.at(-1);',
    '  const name = repository.includes("second") ? "second-package" : "first-package";',
    '  mkdirSync(join(target, "extensions"), { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name, rigyn: { extensions: ["extensions/index.mjs"] } }));',
    '  writeFileSync(join(target, "extensions", "index.mjs"), `export const version = "${selected}";`);',
    '} else if (args.includes("ls-remote")) {',
    '  process.stdout.write(advertised.repeat(40) + "\\trefs/heads/main\\n");',
    '} else if (args.includes("rev-parse")) {',
    '  process.stdout.write(checkedOut.repeat(40) + "\\n");',
    '}',
  ].join("\n"));
  await writeFile(npmScript, "// Package fixtures have no dependencies.\n");
  return {
    state,
    npmCommand: [process.execPath, npmScript, "--", "npm"],
    command: [process.execPath, script, state],
  };
}

test("extension auto-discovery loads direct modules and only folder entry points", async () => {
  const value = await fixture();
  const root = join(value.agentDir, "extensions");
  await mkdir(join(root, "complete"), { recursive: true });
  await mkdir(join(root, "helpers-only"), { recursive: true });
  await writeFile(join(root, "direct.mjs"), "export default () => {};");
  await writeFile(join(root, "complete", "index.ts"), "export default () => {};");
  await writeFile(join(root, "complete", "helper.ts"), "export const helper = true;");
  await writeFile(join(root, "helpers-only", "helper.ts"), "export const helper = true;");

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(root, "complete", "index.ts"),
    join(root, "direct.mjs"),
  ]);
});

test("a nested package manifest may declare multiple extension entry points", async () => {
  const value = await fixture();
  const root = join(value.agentDir, "extensions", "suite");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "one.ts"), "export default () => {};");
  await writeFile(join(root, "src", "two.ts"), "export default () => {};");
  await writeFile(join(root, "src", "helper.ts"), "export const helper = true;");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "suite",
    rigyn: { extensions: ["src/one.ts", "src/two.ts"] },
  }));

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(root, "src", "one.ts"),
    join(root, "src", "two.ts"),
  ]);
});

test("package manifests cannot load lexical or symbolic-link escapes", async () => {
  const value = await fixture();
  const root = join(value.root, "bounded-package");
  const outside = join(value.root, "outside.ts");
  await mkdir(join(root, "extensions"), { recursive: true });
  await writeFile(outside, "export default () => {};");
  await symlink(outside, join(root, "extensions", "escape.ts"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "bounded-package",
    rigyn: { extensions: ["../outside.ts", "extensions/escape.ts"] },
  }));
  value.settings.setPackages([root]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.filter((entry) => entry.metadata.baseDir === root), []);
});

test("manifest globs may select resource directories", async () => {
  const value = await fixture();
  const root = join(value.root, "skill-suite");
  await mkdir(join(root, "plugins", "one", "skills", "alpha"), { recursive: true });
  await mkdir(join(root, "plugins", "two", "skills", "beta"), { recursive: true });
  await writeFile(join(root, "plugins", "one", "skills", "alpha", "SKILL.md"), "# Alpha");
  await writeFile(join(root, "plugins", "two", "skills", "beta", "SKILL.md"), "# Beta");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "skill-suite",
    rigyn: { skills: ["plugins/*/skills"] },
  }));
  value.settings.setPackages([root]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.skills.filter((entry) => entry.path.startsWith(root)).map((entry) => entry.path), [
    join(root, "plugins", "one", "skills", "alpha", "SKILL.md"),
    join(root, "plugins", "two", "skills", "beta", "SKILL.md"),
  ]);
});

test("explicit manifest globs may include dependency-owned extension directories", async () => {
  const value = await fixture();
  const root = join(value.root, "extension-suite");
  const extensions = join(root, "node_modules", "dependency", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, "remote.ts"), "export default () => {};");
  await writeFile(join(extensions, "skip.ts"), "export default () => {};");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "extension-suite",
    rigyn: {
      extensions: ["node_modules/dependency/extensions", "-node_modules/dependency/extensions/skip.ts"],
    },
  }));
  value.settings.setPackages([root]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(extensions, "remote.ts"), true],
  ]);
});

test("skill discovery stops descending after finding a skill manifest", async () => {
  const value = await fixture();
  const outer = join(value.agentDir, "skills", "outer");
  await mkdir(join(outer, "nested"), { recursive: true });
  await writeFile(join(outer, "SKILL.md"), "# Outer");
  await writeFile(join(outer, "notes.md"), "not a skill");
  await writeFile(join(outer, "nested", "SKILL.md"), "# Nested");

  const result = await value.packages.resolve();
  assert.deepEqual(
    result.skills.filter((entry) => entry.path.startsWith(value.agentDir)).map((entry) => entry.path),
    [join(outer, "SKILL.md")],
  );
});

test("ignore files apply inside resource roots without inheriting parent rules", async () => {
  const value = await fixture();
  const prompts = join(value.agentDir, "prompts");
  await mkdir(join(prompts, "nested"), { recursive: true });
  await writeFile(join(value.agentDir, ".gitignore"), "prompts/visible.md\n");
  await writeFile(join(prompts, ".gitignore"), "hidden.md\n");
  await writeFile(join(prompts, "hidden.md"), "hidden");
  await writeFile(join(prompts, "visible.md"), "visible");
  await writeFile(join(prompts, "nested", "also-visible.md"), "visible");

  const result = await value.packages.resolve();
  assert.deepEqual(result.prompts.map((entry) => entry.path), [
    join(prompts, "visible.md"),
  ]);
});

test("canonical paths deduplicate symlinked resources", async () => {
  const value = await fixture();
  const shared = join(value.root, "shared");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "index.ts"), "export default () => {};");
  await mkdir(join(value.agentDir, "extensions"), { recursive: true });
  await mkdir(join(value.cwd, ".rigyn", "extensions"), { recursive: true });
  await symlink(shared, join(value.agentDir, "extensions", "user-link"));
  await symlink(shared, join(value.cwd, ".rigyn", "extensions", "project-link"));

  const result = await value.packages.resolve();
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0]?.metadata.scope, "project");
});

test("project package declarations shadow equivalent user declarations", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "shared-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};");
  value.settings.setPackages([packageRoot]);
  value.settings.setProjectPackages([packageRoot]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0]?.metadata.scope, "project");
});

test("package-relative names beginning with tilde are not expanded to the home directory", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "tilde-package");
  await mkdir(join(packageRoot, "~internal"), { recursive: true });
  await writeFile(join(packageRoot, "~internal", "extension.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "tilde-package",
    rigyn: { extensions: ["~internal/extension.ts"] },
  }));
  value.settings.setPackages([packageRoot]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(packageRoot, "~internal", "extension.ts"),
  ]);
  assert.equal(result.extensions[0]?.path.startsWith(homedir()), false);
});

test("filters compose manifest exclusions with user force-includes", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "filtered-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "two.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "filtered-package",
    rigyn: { extensions: ["extensions/*.ts"] },
  }));
  value.settings.setPackages([{
    source: packageRoot,
    extensions: ["!extensions/*.ts", "+extensions/two.ts", "-extensions/one.ts"],
  }]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "one.ts"), false],
    [join(packageRoot, "extensions", "two.ts"), true],
  ]);
});

test("offline resolution skips missing network packages without creating install roots", async () => {
  const value = await fixture();
  value.settings.setPackages(["npm:@rigyn/not-installed"]);
  await value.settings.flush();
  const previous = process.env.RIGYN_OFFLINE;
  process.env.RIGYN_OFFLINE = "1";
  try {
    const result = await value.packages.resolve();
    assert.deepEqual(result.extensions, []);
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(result.themes, []);
    assert.equal(result.skills.some((entry) => entry.metadata.source === "npm:@rigyn/not-installed"), false);
  } finally {
    if (previous === undefined) delete process.env.RIGYN_OFFLINE;
    else process.env.RIGYN_OFFLINE = previous;
  }
});

test("local installs emit bounded start and completion progress events", async () => {
  const value = await fixture();
  const extension = join(value.root, "extension with spaces.ts");
  await writeFile(extension, "export default () => {};");
  const events: string[] = [];
  value.packages.setProgressCallback((event) => events.push(`${event.type}:${event.action}:${event.source}`));
  await value.packages.install(extension);
  assert.deepEqual(events, [
    `start:install:${extension}`,
    `complete:install:${extension}`,
  ]);
});

test("invocation package sources resolve temporarily without persisting settings", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "temporary-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "entry.ts"), "export default () => {};");
  const resolved = await value.packages.resolveExtensionSources([packageRoot], { temporary: true });
  assert.deepEqual(resolved.extensions.map((entry) => ({
    path: entry.path,
    scope: entry.metadata.scope,
    origin: entry.metadata.origin,
  })), [{
    path: join(packageRoot, "extensions", "entry.ts"),
    scope: "temporary",
    origin: "package",
  }]);
  assert.deepEqual(value.settings.getSettings().packages, undefined);
});

test("prompt and theme convention discovery is top-level only", async () => {
  const value = await fixture();
  const prompts = join(value.agentDir, "prompts");
  const themes = join(value.agentDir, "themes");
  await mkdir(join(prompts, "nested"), { recursive: true });
  await mkdir(join(themes, "nested"), { recursive: true });
  await writeFile(join(prompts, "top.md"), "top");
  await writeFile(join(prompts, "nested", "hidden.md"), "nested");
  await writeFile(join(themes, "top.json"), "{}");
  await writeFile(join(themes, "nested", "hidden.json"), "{}");

  const result = await value.packages.resolve();
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(prompts, "top.md")]);
  assert.deepEqual(result.themes.map((entry) => entry.path), [join(themes, "top.json")]);
});

test("an autoload-disabled project package is a resource delta over its user package", async () => {
  const value = await fixture();
  const packageRoot = join(value.agentDir, "npm", "node_modules", "rigyn-tools");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "rigyn-tools", version: "1.0.0" }));
  await writeFile(join(packageRoot, "extensions", "keep.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "disable.ts"), "export default () => {};");
  value.settings.setPackages(["npm:rigyn-tools"]);
  value.settings.setProjectPackages([{
    source: "npm:rigyn-tools",
    autoload: false,
    extensions: ["-extensions/disable.ts"],
  }]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => ({
    path: entry.path,
    enabled: entry.enabled,
    scope: entry.metadata.scope,
  })), [
    { path: join(packageRoot, "extensions", "disable.ts"), enabled: false, scope: "project" },
    { path: join(packageRoot, "extensions", "keep.ts"), enabled: true, scope: "user" },
  ]);
});

test("stored local package paths are explicitly relative to their settings directory", async () => {
  const value = await fixture();
  const userPackage = join(value.agentDir, "packages", "local-user");
  const projectPackage = join(value.cwd, ".rigyn", "packages", "local-project");
  await mkdir(userPackage, { recursive: true });
  await mkdir(projectPackage, { recursive: true });

  assert.equal(value.packages.addSourceToSettings(userPackage), true);
  assert.equal(value.packages.addSourceToSettings(projectPackage, { local: true }), true);
  await value.settings.flush();

  assert.deepEqual(value.settings.getGlobalSettings().packages, ["./packages/local-user"]);
  assert.deepEqual(value.settings.getProjectSettings().packages, ["./packages/local-project"]);
});

test("stored local package paths remain absolute across Windows volumes", () => {
  assert.equal(portableLocalPackageSource("C:\\Users\\tester", "D:\\packages\\tools", win32), "D:/packages/tools");
  assert.equal(
    portableLocalPackageSource("\\\\server\\first\\settings", "\\\\server\\second\\tools", win32),
    "//server/second/tools",
  );
});

test("local installs resolve invocation paths from the launch directory before persisting settings-relative paths", async () => {
  const value = await fixture();
  const packageRoot = join(value.cwd, "local-package");
  await mkdir(packageRoot, { recursive: true });

  await value.packages.installAndPersist("./local-package");
  await value.settings.flush();

  assert.deepEqual(value.settings.getGlobalSettings().packages, ["../workspace/local-package"]);
  assert.equal(value.packages.getInstalledPath("../workspace/local-package", "user"), packageRoot);
});

test("manifest exclusions remain absent when user filters are layered", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "layered-manifest");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "visible.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "manifest-hidden.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "user-hidden.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "layered-manifest",
    rigyn: { extensions: ["extensions", "!**/manifest-hidden.ts"] },
  }));
  value.settings.setPackages([{
    source: packageRoot,
    extensions: ["!**/user-hidden.ts"],
  }]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "user-hidden.ts"), false],
    [join(packageRoot, "extensions", "visible.ts"), true],
  ]);
});

test("an explicit package manifest does not activate undeclared convention resources", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "manifest-authority");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "declared.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "prompts", "undeclared.md"), "not declared");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "manifest-authority",
    rigyn: { extensions: ["extensions/declared.ts"] },
  }));
  value.settings.setPackages([packageRoot]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [join(packageRoot, "extensions", "declared.ts")]);
  assert.deepEqual(result.prompts, []);
});

test("equivalent Git transports replace refs without discarding resource filters", async () => {
  const value = await fixture();
  value.settings.setPackages([{
    source: "git:https://github.com/example/tools.git@v1",
    extensions: ["+extensions/one.ts"],
  }]);

  assert.equal(value.packages.addSourceToSettings("git:git@github.com:example/tools@v2"), true);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [{
    source: "git:git@github.com:example/tools@v2",
    extensions: ["+extensions/one.ts"],
  }]);
  assert.equal(value.packages.addSourceToSettings("git:ssh://git@github.com/example/tools@v2"), true);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [{
    source: "git:ssh://git@github.com/example/tools@v2",
    extensions: ["+extensions/one.ts"],
  }]);
  assert.equal(value.packages.addSourceToSettings("git:ssh://git@github.com/example/tools@v2"), false);
  assert.equal(value.packages.removeSourceFromSettings("git:https://github.com/example/tools"), true);
  assert.deepEqual(value.settings.getGlobalSettings().packages, []);
});

test("package source identities reject npm options and retain distinct file and SSH authorities", async () => {
  const value = await fixture();
  assert.throws(() => value.packages.addSourceToSettings("npm:--global"), /Invalid npm package source/u);
  assert.deepEqual(value.settings.getGlobalSettings().packages, undefined);

  const firstArchive = pathToFileURL(join(value.root, "@scope", "a.tgz")).href;
  const secondArchive = pathToFileURL(join(value.root, "@scope", "b.tgz")).href;
  assert.equal(value.packages.addSourceToSettings(`npm:${firstArchive}`), true);
  assert.equal(value.packages.addSourceToSettings(`npm:${secondArchive}`), true);
  assert.equal(value.packages.addSourceToSettings("git:ssh://alice@example.com:22/owner/repo.git"), true);
  assert.equal(value.packages.addSourceToSettings("git:ssh://bob@example.com:2222/owner/repo.git"), true);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [
    `npm:${firstArchive}`,
    `npm:${secondArchive}`,
    "git:ssh://alice@example.com:22/owner/repo.git",
    "git:ssh://bob@example.com:2222/owner/repo.git",
  ]);
});

test("a moving Git ref cannot race the advertised revision into persistent storage", async () => {
  const value = await fixture();
  const fake = await fakeGitCommand(value.root);
  value.settings.setNpmCommand(fake.npmCommand);
  await writeFile(fake.state, "race");
  const packages = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    gitCommand: fake.command,
  });
  const source = "git:https://example.test/owner/first.git@main";
  await assert.rejects(packages.install(source), /Git ref changed while it was being installed/u);
  assert.equal(packages.getInstalledPath(source, "user"), undefined);
});

test("temporary Git refresh activation failure keeps the prior complete checkout", async () => {
  const value = await fixture();
  const fake = await fakeGitCommand(value.root);
  value.settings.setNpmCommand(fake.npmCommand);
  const packages = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    gitCommand: fake.command,
    activateCandidate: async (candidate) => {
      const extension = candidate.resources.extensions[0];
      if (extension !== undefined && (await readFile(extension.path, "utf8")).includes('"2"')) {
        throw new Error("candidate rejected");
      }
    },
  });
  const source = "git:https://example.test/owner/first.git";
  const initial = await packages.resolveExtensionSources([source], { temporary: true });
  const path = initial.extensions[0]?.path;
  assert.ok(path);
  assert.match(await readFile(path, "utf8"), /"1"/u);

  await writeFile(fake.state, "2");
  const refreshed = await packages.resolveExtensionSources([source], { temporary: true });
  assert.equal(refreshed.extensions[0]?.path, path);
  assert.match(await readFile(path, "utf8"), /"1"/u);
});

test("a later package activation failure leaves an entire multi-package update unchanged", async () => {
  const value = await fixture();
  const fake = await fakeGitCommand(value.root);
  value.settings.setNpmCommand(fake.npmCommand);
  const first = "git:https://example.test/owner/first.git";
  const second = "git:https://example.test/owner/second.git";
  const initial = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    gitCommand: fake.command,
    activateCandidate: async () => undefined,
  });
  await initial.installAndPersist(first);
  await initial.installAndPersist(second);
  const firstPath = initial.getInstalledPath(first, "user");
  const secondPath = initial.getInstalledPath(second, "user");
  assert.ok(firstPath);
  assert.ok(secondPath);
  const firstExtension = join(firstPath, "extensions", "index.mjs");
  const secondExtension = join(secondPath, "extensions", "index.mjs");
  await writeFile(fake.state, "2");

  const updating = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    gitCommand: fake.command,
    activateCandidate: async (candidate) => {
      if (candidate.source === second) throw new Error("second candidate rejected");
    },
  });
  await assert.rejects(updating.update(), /second candidate rejected/u);
  assert.match(await readFile(firstExtension, "utf8"), /"1"/u);
  assert.match(await readFile(secondExtension, "utf8"), /"1"/u);
});

test("npm batch cancellation reaches the process tree and preserves the installed root", async () => {
  const value = await fixture();
  const marker = join(value.root, "npm-update-pid");
  const script = join(value.root, "npm-update.mjs");
  await writeFile(script, [
    'import { writeFileSync } from "node:fs";',
    'const marker = process.argv[2];',
    'const args = process.argv.slice(3);',
    'if (args.includes("view")) process.exit(0);',
    'writeFileSync(marker, String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, script, marker, "--", "npm"]);
  value.settings.setPackages(["npm:first-package", "npm:second-package"]);
  const npmRoot = join(value.agentDir, "npm");
  for (const name of ["first-package", "second-package"]) {
    const target = join(npmRoot, "node_modules", name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  await writeFile(join(npmRoot, "package.json"), JSON.stringify({ private: true }));

  const controller = new AbortController();
  const pending = value.packages.update(undefined, { signal: controller.signal });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await readFile(marker); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const pid = Number(await readFile(marker, "utf8"));
  controller.abort(new Error("cancel npm update"));
  await assert.rejects(pending, /cancel npm update/u);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
    catch { alive = false; }
  }
  assert.equal(alive, false);
  assert.equal(
    JSON.parse(await readFile(join(npmRoot, "node_modules", "first-package", "package.json"), "utf8")).version,
    "1.0.0",
  );
  assert.equal(
    JSON.parse(await readFile(join(npmRoot, "node_modules", "second-package", "package.json"), "utf8")).version,
    "1.0.0",
  );
});

test("npm uninstall ignores an option-like installed manifest name", async () => {
  const value = await fixture();
  const log = join(value.root, "npm-uninstall.json");
  const script = join(value.root, "npm-uninstall.mjs");
  await writeFile(script, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`,
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, script, "--", "npm"]);
  const root = join(value.agentDir, "npm");
  const installed = join(root, "node_modules", "safe-package");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "--global", version: "1.0.0" }));

  await value.packages.remove("npm:safe-package");
  assert.deepEqual(JSON.parse(await readFile(log, "utf8")), [
    "--", "npm", "uninstall", "safe-package", "--prefix", root, "--legacy-peer-deps",
  ]);
});

test("configured package-manager argv selects exact npm, pnpm, and Bun install conventions", async () => {
  for (const manager of ["npm", "pnpm", "bun"] as const) {
    const value = await fixture(`workspace-${manager}`);
    const executable = join(value.root, `fake-${manager}.mjs`);
    const log = join(value.root, `${manager}.json`);
    await writeFile(executable, [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const args = process.argv.slice(2);',
      'writeFileSync(process.env.RIGYN_TEST_ARGV_LOG, JSON.stringify({',
      '  args,',
      '  ignoreScripts: process.env.npm_config_ignore_scripts,',
      '  binLinks: process.env.npm_config_bin_links,',
      '}));',
      'const prefix = args.indexOf("--prefix");',
      'const cwd = args.indexOf("--cwd");',
      'const root = prefix >= 0 ? args[prefix + 1] : args[cwd + 1];',
      'mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });',
      'writeFileSync(join(root, "node_modules", "fixture", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));',
    ].join("\n"));
    value.settings.setNpmCommand([process.execPath, executable, "--", manager]);
    process.env.RIGYN_TEST_ARGV_LOG = log;
    try {
      await value.packages.install("npm:fixture");
    } finally {
      delete process.env.RIGYN_TEST_ARGV_LOG;
    }
    const recorded = JSON.parse(await readFile(log, "utf8")) as {
      args: string[];
      ignoreScripts?: string;
      binLinks?: string;
    };
    const { args } = recorded;
    const rootFlag = manager === "bun" ? "--cwd" : "--prefix";
    const installRoot = args[args.indexOf(rootFlag) + 1]!;
    assert.equal(dirname(installRoot), value.agentDir);
    assert.match(basename(installRoot), /^\.rigyn-package-stage-/u);
    const expected = manager === "bun"
      ? ["--", "bun", "install", "fixture", "--cwd", installRoot, "--omit=peer", "--ignore-scripts"]
      : manager === "pnpm"
        ? [
            "--", "pnpm", "install", "fixture", "--prefix", installRoot,
            "--ignore-scripts=true",
            "--config.bin-links=false",
            "--config.auto-install-peers=false",
            "--config.strict-peer-dependencies=false",
            "--config.strict-dep-builds=false",
          ]
        : [
            "--", "npm", "install", "fixture", "--prefix", installRoot, "--legacy-peer-deps",
            "--ignore-scripts=true", "--bin-links=false",
          ];
    assert.deepEqual(args, expected);
    assert.equal(recorded.ignoreScripts, "true");
    assert.equal(recorded.binLinks, "false");
  }
});

test("portable .agents skills honor scoped override patterns and retain their own metadata roots", async () => {
  const value = await fixture();
  const previousHome = process.env.HOME;
  const home = join(value.root, "home");
  process.env.HOME = home;
  try {
    await mkdir(join(value.cwd, ".git"), { recursive: true });
    const userSkill = join(home, ".agents", "skills", "user-disabled", "SKILL.md");
    const projectSkill = join(value.cwd, ".agents", "skills", "project-disabled", "SKILL.md");
    await mkdir(join(userSkill, ".."), { recursive: true });
    await mkdir(join(projectSkill, ".."), { recursive: true });
    await writeFile(userSkill, "---\nname: user-disabled\ndescription: user\n---\n");
    await writeFile(projectSkill, "---\nname: project-disabled\ndescription: project\n---\n");
    value.settings.setSkillPaths(["-skills/user-disabled"]);
    value.settings.setProjectSkillPaths(["-skills/project-disabled"]);
    await value.settings.flush();

    const result = await value.packages.resolve();
    const user = result.skills.find((entry) => entry.path === userSkill);
    const project = result.skills.find((entry) => entry.path === projectSkill);
    assert.equal(user?.enabled, false);
    assert.equal(user?.metadata.baseDir, join(home, ".agents"));
    assert.equal(project?.enabled, false);
    assert.equal(project?.metadata.baseDir, join(value.cwd, ".agents"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("temporary npm installs use private deterministic storage while explicit installs remain available offline", async () => {
  const value = await fixture();
  const executable = join(value.root, "fake-npm.mjs");
  await writeFile(executable, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    'const rootIndex = args.indexOf("--prefix");',
    'const cwdIndex = args.indexOf("--cwd");',
    'const root = rootIndex >= 0 ? args[rootIndex + 1] : cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;',
    'const spec = args[args.indexOf("install") + 1];',
    'if (root && spec && !spec.startsWith("--")) {',
    '  const name = spec.replace(/^@/, "").split("@")[0].split("/").at(-1);',
    '  const target = join(root, "node_modules", name);',
    '  mkdirSync(join(target, "extensions"), { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name, version: "1.0.0", rigyn: { extensions: ["extensions/index.mjs"] } }));',
    '  writeFileSync(join(target, "extensions", "index.mjs"), "export default () => {};");',
    "}",
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, executable, "--", "npm"]);
  await value.settings.flush();

  const temporary = await value.packages.resolveExtensionSources(["npm:temporary-package"], { temporary: true });
  assert.match(
    (temporary.extensions[0]?.path ?? "").replaceAll("\\", "/"),
    /\/tmp\/extensions\/npm\/[0-9a-f]{8}\/node_modules\/temporary-package\/extensions\/index\.mjs$/u,
  );

  const progress: Array<{ type: string; message?: string }> = [];
  value.packages.setProgressCallback((event) => progress.push(event));
  const previousOffline = process.env.RIGYN_OFFLINE;
  process.env.RIGYN_OFFLINE = "1";
  try {
    await value.packages.install("npm:manual-package");
  } finally {
    if (previousOffline === undefined) delete process.env.RIGYN_OFFLINE;
    else process.env.RIGYN_OFFLINE = previousOffline;
  }
  await access(join(value.agentDir, "npm", "node_modules", "manual-package", "package.json"));
  assert.equal(progress[0]?.message, "Installing npm:manual-package...");
});

test("removing a managed Git package prunes its portable hashed repository directory", async () => {
  const value = await fixture();
  const identity = createHash("sha256").update("github.com/owner/package").digest("hex");
  const packagePath = join(value.agentDir, "git", "repositories", identity);
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, "marker"), "installed");

  await value.packages.remove("git:github.com/owner/package");
  await assert.rejects(access(join(value.agentDir, "git", "repositories")));
  await access(join(value.agentDir, "git"));
});

test("temporary Git refreshes emit pull progress while retaining the cached checkout", async () => {
  const value = await fixture();
  const binaryDirectory = join(value.root, "bin");
  const fakeGitScript = join(binaryDirectory, "fake-git.mjs");
  await mkdir(binaryDirectory);
  await writeFile(fakeGitScript, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    'while (args[0] === "-c") args.splice(0, 2);',
    'if (args.includes("clone")) {',
    "  const target = args.at(-1);",
    '  mkdirSync(join(target, "extensions"), { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "temporary-git", rigyn: { extensions: ["extensions/index.mjs"] } }));',
    '  writeFileSync(join(target, "extensions", "index.mjs"), "export default () => {};");',
    '} else {',
    '  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");',
    "}",
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, fakeGitScript, "--", "npm"]);
  const packages = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    gitCommand: [process.execPath, fakeGitScript],
  });
  const source = "git:https://example.test/owner/temporary-git.git";
  await packages.resolveExtensionSources([source], { temporary: true });
  const events: string[] = [];
  packages.setProgressCallback((event) => events.push(`${event.type}:${event.action}:${event.source}`));

  const resolved = await packages.resolveExtensionSources([source], { temporary: true });

  assert.equal(resolved.extensions.length, 1);
  assert.deepEqual(events, [
    `start:pull:${source}`,
    `complete:pull:${source}`,
  ]);
});
