import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { discoverSkills, loadSkill } from "../../src/context/index.js";
import {
  EXTENSION_PACKAGE_PROVENANCE,
  EXTENSION_PACKAGE_LOCK,
  LocalExtensionPackageManager,
  discoverExtensions,
  renderExtensionCommand,
  renderExtensionPrompt,
} from "../../src/extensions/index.js";
import { TuiController } from "../../src/tui/index.js";
import { keyedSqliteLeasePath } from "../../src/process/sqlite-lease.js";
import { FakeInput, FakeOutput } from "../tui/helpers.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-packages-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

interface FixtureOptions {
  version: string;
  word: string;
}

async function writeReferencePackage(root: string, options: FixtureOptions): Promise<void> {
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "skills", "reference-skill"), { recursive: true });
  await mkdir(join(root, "templates"), { recursive: true });
  await mkdir(join(root, "themes"), { recursive: true });
  await writeFile(join(root, "runtime", "index.mjs"), `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(join(root, "runtime-executed"))}, "bad"));\n`);
  await writeFile(join(root, "skills", "reference-skill", "SKILL.md"), `---\nname: reference-skill\ndescription: ${options.word} skill\n---\n${options.word} instructions\n`);
  await writeFile(join(root, "templates", "prompt.md"), `${options.word} prompt {{input}}\n`);
  await writeFile(join(root, "templates", "command.md"), `${options.word} command {{args}}\n`);
  await writeFile(join(root, "themes", "reference.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: "reference",
    base: "dark",
    styles: { accent: { foreground: options.word === "first" ? 81 : 82, bold: true } },
  })}\n`);
  await writeFile(join(root, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "reference",
    name: "Reference package",
    version: options.version,
    contributions: {
      skillRoots: [{ path: "skills" }],
      prompts: [{ id: "reference-prompt", path: "templates/prompt.md" }],
      commands: [{ name: "reference-command", path: "templates/command.md" }],
      themes: [{ name: "reference", path: "themes/reference.json" }],
      runtime: [{ path: "runtime/index.mjs" }],
    },
  }, null, 2)}\n`);
}

test("local package lifecycle installs, discovers, updates, and removes every declarative resource", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const user = join(root, "user-extensions");
  const project = join(root, "project-extensions");
  await mkdir(source);
  await writeReferencePackage(source, { version: "1.0.0", word: "first" });
  const packages = new LocalExtensionPackageManager({ user, project });

  const installed = await packages.install(source, "project");
  assert.equal(installed.id, "reference");
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.scope, "project");
  assert.equal(installed.manifestModified, false);
  assert.equal(installed.provenance.kind, "local");
  assert.equal(installed.provenance.sourcePath, await import("node:fs/promises").then(({ realpath }) => realpath(source)));
  assert.equal(installed.provenance.updatedAt, undefined);
  assert.deepEqual((await packages.list()).map((entry) => [entry.id, entry.scope]), [["reference", "project"]]);

  const untrusted = await discoverExtensions(packages.sources(false));
  assert.equal(untrusted.list().find((entry) => entry.id === "reference")?.status, "blocked");
  assert.equal(untrusted.bundle().runtime.length, 0);

  let catalog = await discoverExtensions(packages.sources(true));
  assert.equal(catalog.doctor().healthy, true);
  assert.deepEqual(catalog.list().find((entry) => entry.id === "reference")?.contributions, {
    skillRoots: 1,
    prompts: 1,
    commands: 1,
    themes: 1,
    runtime: 1,
  });
  const firstBundle = catalog.bundle();
  assert.equal(renderExtensionPrompt(catalog.prompt("reference-prompt")!, "input"), "first prompt input\n");
  assert.equal(renderExtensionCommand(catalog.command("reference-command")!, "args"), "first command args\n");
  assert.equal(catalog.theme("reference")?.definition.styles.accent?.foreground, 81);
  const controller = new TuiController({
    input: new FakeInput(),
    output: new FakeOutput(),
    mode: "classic",
    handleSignals: false,
  });
  controller.setCustomThemes(firstBundle.themes.map((theme) => theme.definition));
  controller.setTheme("reference");
  assert.equal(controller.selectedThemeName(), "reference");
  assert.equal(firstBundle.runtime[0]?.extensionId, "reference");
  assert.match(firstBundle.runtime[0]?.sourcePath ?? "", /runtime[\\/]index\.mjs$/u);
  assert.equal(firstBundle.runtime[0]?.sha256.length, 64);
  const skills = await discoverSkills(firstBundle.skillRoots);
  assert.equal(skills[0]?.name, "reference-skill");
  assert.match((await loadSkill(skills[0]!)).instructions, /first instructions/u);
  await assert.rejects(access(join(source, "runtime-executed")), /ENOENT/u);

  await writeReferencePackage(source, { version: "2.0.0", word: "second" });
  const updated = await packages.update("reference", "project");
  assert.equal(updated.version, "2.0.0");
  assert.equal(updated.provenance.installedAt, installed.provenance.installedAt);
  assert.ok(updated.provenance.updatedAt);
  assert.equal(updated.manifestModified, false);
  catalog = await discoverExtensions(packages.sources(true));
  assert.equal(renderExtensionPrompt(catalog.prompt("reference-prompt")!, "input"), "second prompt input\n");
  assert.equal(catalog.theme("reference")?.definition.styles.accent?.foreground, 82);
  assert.match((await loadSkill((await discoverSkills(catalog.bundle().skillRoots))[0]!)).instructions, /second instructions/u);
  await assert.rejects(access(join(source, "runtime-executed")), /ENOENT/u);

  const removed = await packages.remove("reference", "project");
  assert.equal(removed.version, "2.0.0");
  assert.deepEqual(await packages.list(), []);
  catalog = await discoverExtensions(packages.sources(true));
  assert.equal(catalog.list().some((entry) => entry.id === "reference"), false);
  assert.equal(catalog.prompt("reference-prompt"), undefined);
  assert.equal(catalog.command("reference-command"), undefined);
  assert.equal(catalog.theme("reference"), undefined);
  assert.deepEqual(catalog.bundle().skillRoots, []);
  assert.deepEqual(catalog.bundle().runtime, []);
  controller.setCustomThemes(catalog.bundle().themes.map((theme) => theme.definition));
  assert.equal(controller.selectedThemeName(), "dark");
  controller.close();
});

test("a rejected symlink update leaves the previously installed package active", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const bad = join(root, "bad-source");
  const user = join(root, "user-extensions");
  await mkdir(source);
  await writeReferencePackage(source, { version: "1.0.0", word: "first" });
  const packages = new LocalExtensionPackageManager({ user });
  await packages.install(source);

  await mkdir(bad);
  await writeReferencePackage(bad, { version: "2.0.0", word: "second" });
  await rm(join(bad, "templates", "prompt.md"));
  await symlink(join(source, "templates", "prompt.md"), join(bad, "templates", "prompt.md"));
  await assert.rejects(packages.update("reference", "user", bad), /symbolic link/u);

  const listed = await packages.list("user");
  assert.equal(listed[0]?.version, "1.0.0");
  const catalog = await discoverExtensions(packages.sources(false));
  assert.equal(renderExtensionPrompt(catalog.prompt("reference-prompt")!, "input"), "first prompt input\n");
});

test("manual extensions are preserved and managed provenance is strict", async (t) => {
  const root = await temporary(t);
  const user = join(root, "user-extensions");
  const manual = join(user, "manual");
  await mkdir(manual, { recursive: true });
  await writeFile(join(manual, "extension.json"), `${JSON.stringify({ schemaVersion: 1, id: "manual", contributions: {} })}\n`);
  const packages = new LocalExtensionPackageManager({ user });

  assert.deepEqual(await packages.list(), []);
  await assert.rejects(packages.remove("manual"), /provenance|ENOENT/u);
  assert.match(await readFile(join(manual, "extension.json"), "utf8"), /"manual"/u);

  const source = join(root, "source");
  await mkdir(source);
  await writeReferencePackage(source, { version: "1.0.0", word: "first" });
  await writeFile(join(source, EXTENSION_PACKAGE_PROVENANCE), "{}\n");
  await assert.rejects(packages.install(source), /reserved file/u);
  assert.deepEqual(await packages.list(), []);
});

test("package managers coordinate through a crash-safe SQLite process lease", async (t) => {
  const root = await temporary(t);
  const user = join(root, "user-extensions");
  const leaseRoot = join(root, "leases");
  await mkdir(user, { recursive: true });
  await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
  const lock = await keyedSqliteLeasePath(leaseRoot, "extension-packages", user);
  const second = new LocalExtensionPackageManager({ user }, {}, {}, { operationLeaseRoot: leaseRoot });
  const held = new DatabaseSync(lock);
  held.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const release = setTimeout(() => {
    held.exec("ROLLBACK");
    held.close();
  }, 100);
  const started = Date.now();
  assert.deepEqual(await second.list("user"), []);
  clearTimeout(release);
  assert.ok(Date.now() - started >= 75, "a second manager must wait for the active lock");
  await access(lock);
  await assert.rejects(access(join(user, EXTENSION_PACKAGE_LOCK)), /ENOENT/u);
});

test("package listing can be cancelled while waiting for an active lock", async (t) => {
  const root = await temporary(t);
  const user = join(root, "user-extensions");
  const leaseRoot = join(root, "leases");
  await mkdir(user, { recursive: true });
  await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
  const lock = await keyedSqliteLeasePath(leaseRoot, "extension-packages", user);
  const packages = new LocalExtensionPackageManager({ user }, {}, {}, { operationLeaseRoot: leaseRoot });
  const controller = new AbortController();

  const held = new DatabaseSync(lock);
  held.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const cancel = setTimeout(() => controller.abort(new Error("cancel package listing")), 25);
  try {
    await assert.rejects(
      packages.list("user", { signal: controller.signal }),
      /cancel package listing/u,
    );
  } finally {
    clearTimeout(cancel);
    held.exec("ROLLBACK");
    held.close();
  }
});
