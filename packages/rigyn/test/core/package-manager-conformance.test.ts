import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { DefaultPackageManager, getExtensionTempFolder } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

const capturedChildOutput = new Promise<boolean>((resolve) => {
  const child = spawn(process.execPath, ["--eval", 'process.stdout.write("ready")'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.once("error", () => resolve(false));
  child.once("close", (code) => resolve(code === 0 && output === "ready"));
});

const capturedSyncChildOutput = (() => {
  const result = spawnSync(process.execPath, ["--eval", 'process.stdout.write("ready")'], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.error === undefined && result.status === 0 && result.stdout === "ready";
})();

function skipUnavailableProcessCapture(
  context: { skip(message?: string): void },
  supported: boolean,
  message: string,
): boolean {
  if (supported) return false;
  if (process.env.RIGYN_REQUIRE_PROCESS_TESTS === "1") {
    assert.fail(`${message}; required process conformance could not run`);
  }
  context.skip(message);
  return true;
}

async function fixture(suffix = "default"): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  packages: DefaultPackageManager;
}> {
  const root = await mkdtemp(join(tmpdir(), `rigyn-package-conformance-${suffix}-`));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settings = SettingsManager.inMemory();
  return {
    root,
    cwd,
    agentDir,
    settings,
    packages: new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settings,
      activateCandidate: async () => {},
    }),
  };
}

async function readJsonLines(path: string): Promise<Array<{ args: string[]; cwd?: string }>> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd?: string });
  } catch {
    return [];
  }
}

test("force exclusions have stable priority and exact overrides do not match basenames", async () => {
  const value = await fixture("patterns");
  const packageRoot = join(value.root, "filtered");
  await mkdir(join(packageRoot, "extensions", "nested"), { recursive: true });
  await mkdir(join(packageRoot, "prompts", "nested"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "filtered" }));
  await writeFile(join(packageRoot, "extensions", "entry.ts"), "export default () => {};\n");
  await writeFile(join(packageRoot, "prompts", "nested", "entry.md"), "Prompt\n");
  value.settings.setPackages([{
    source: packageRoot,
    extensions: [
      "!extensions/**/*.ts",
      "+entry.ts",
      "+extensions/entry.ts",
      "-extensions/entry.ts",
      "+extensions/entry.ts",
    ],
    prompts: ["!prompts/**/*.md", "+entry.md"],
  }]);

  const resolved = await value.packages.resolve();

  assert.deepEqual(resolved.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "entry.ts"), false],
  ]);
  assert.deepEqual(resolved.prompts.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "prompts", "nested", "entry.md"), false],
  ]);
});

test("an explicit empty manifest section stays authoritative when another section is filtered", async () => {
  const value = await fixture("manifest-authority");
  const packageRoot = join(value.root, "package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "hidden.ts"), "export default () => {};\n");
  await writeFile(join(packageRoot, "prompts", "visible.md"), "Visible\n");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "manifest-authority",
    rigyn: { extensions: [], prompts: ["prompts"] },
  }));
  value.settings.setPackages([{ source: packageRoot, prompts: ["prompts/*.md"] }]);

  const resolved = await value.packages.resolve();

  assert.deepEqual(resolved.extensions, []);
  assert.deepEqual(resolved.prompts.map((entry) => entry.path), [join(packageRoot, "prompts", "visible.md")]);
});

test("an ignored parent skill manifest does not hide valid nested skills", async () => {
  const value = await fixture("ignored-skill-parent");
  const skillRoot = join(value.agentDir, "skills");
  const nestedSkill = join(skillRoot, "nested", "SKILL.md");
  await mkdir(dirname(nestedSkill), { recursive: true });
  await writeFile(join(skillRoot, ".gitignore"), "SKILL.md\n!nested/SKILL.md\n");
  await writeFile(join(skillRoot, "SKILL.md"), "# Ignored parent\n");
  await writeFile(nestedSkill, "# Nested\n");

  const resolved = await value.packages.resolve();

  assert.equal(resolved.skills.some((entry) => entry.path === join(skillRoot, "SKILL.md")), false);
  assert.equal(resolved.skills.some((entry) => entry.path === nestedSkill), true);
});

test("the final duplicate project declaration owns package filtering", async () => {
  const value = await fixture("duplicate-project-source");
  const packageRoot = join(value.cwd, ".rigyn", "npm", "node_modules", "duplicate-fixture");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "duplicate-fixture", version: "1.0.0" }));
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};\n");
  await writeFile(join(packageRoot, "extensions", "two.ts"), "export default () => {};\n");
  value.settings.setProjectPackages([
    { source: "npm:duplicate-fixture", extensions: ["-extensions/one.ts"] },
    { source: "npm:duplicate-fixture", extensions: ["-extensions/two.ts"] },
  ]);

  const resolved = await value.packages.resolve();

  assert.deepEqual(resolved.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "one.ts"), true],
    [join(packageRoot, "extensions", "two.ts"), false],
  ]);
});

test("untrusted project scope rejects local removal before touching lifecycle state", async () => {
  const value = await fixture("untrusted-remove");
  const extension = join(value.cwd, "extension.ts");
  await writeFile(extension, "export default () => {};\n");
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const packages = new DefaultPackageManager({ cwd: value.cwd, agentDir: value.agentDir, settingsManager: settings });

  await assert.rejects(packages.remove(extension, { local: true }), /not trusted/iu);
});

test("npm, pnpm, and Bun uninstall from the same managed roots used for installation", async () => {
  for (const manager of ["npm", "pnpm", "bun"] as const) {
    const value = await fixture(`remove-${manager}`);
    const executable = join(value.root, "manager.mjs");
    const log = join(value.root, "calls.jsonl");
    await mkdir(join(value.agentDir, "npm"), { recursive: true });
    await writeFile(executable, [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");`,
    ].join("\n"));
    value.settings.setNpmCommand([process.execPath, executable, "--", manager]);

    await value.packages.remove("npm:@scope/fixture");

    const root = join(value.agentDir, "npm");
    const expected = manager === "bun"
      ? ["--", "bun", "uninstall", "@scope/fixture", "--cwd", root]
      : manager === "pnpm"
        ? ["--", "pnpm", "uninstall", "@scope/fixture", "--prefix", root]
        : ["--", "npm", "uninstall", "@scope/fixture", "--prefix", root, "--legacy-peer-deps"];
    assert.deepEqual((await readJsonLines(log))[0]?.args, expected);
  }
});

test("updating a legacy global npm package migrates it into managed storage without a registry lookup", async (context) => {
  if (skipUnavailableProcessCapture(
    context,
    capturedSyncChildOutput,
    "the execution environment blocks synchronous child-process output",
  )) return;
  const value = await fixture("legacy-migration");
  const executable = join(value.root, "manager.mjs");
  const log = join(value.root, "calls.jsonl");
  const legacyRoot = join(value.root, "legacy", "node_modules");
  const legacyPath = join(legacyRoot, "legacy-fixture");
  const managedPath = join(value.agentDir, "npm", "node_modules", "legacy-fixture");
  await mkdir(legacyPath, { recursive: true });
  await writeFile(join(legacyPath, "package.json"), JSON.stringify({ name: "legacy-fixture", version: "1.0.0" }));
  await writeFile(executable, [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + "\\n");`,
    'if (args.includes("root")) process.stdout.write(' + JSON.stringify(legacyRoot) + ');',
    'if (args.includes("install")) {',
    '  const prefix = args[args.indexOf("--prefix") + 1];',
    '  const target = join(prefix, "node_modules", "legacy-fixture");',
    '  mkdirSync(target, { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "legacy-fixture", version: "1.0.0" }));',
    '}',
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, executable, "--", "npm"]);
  value.settings.setPackages(["npm:legacy-fixture"]);

  assert.equal(value.packages.getInstalledPath("npm:legacy-fixture", "user"), legacyPath);
  await value.packages.update("npm:legacy-fixture");

  assert.equal(value.packages.getInstalledPath("npm:legacy-fixture", "user"), managedPath);
  const calls = await readJsonLines(log);
  assert.equal(calls.some(({ args }) => args.includes("view")), false);
  assert.equal(calls.some(({ args }) => args.includes("legacy-fixture@latest") && args.includes("--prefix")), true);
});

test("resolution enforces exact and range versions without consulting the registry", async () => {
  const value = await fixture("versions");
  const executable = join(value.root, "manager.mjs");
  const log = join(value.root, "calls.jsonl");
  for (const [name, version] of [["exact-fixture", "1.0.0"], ["range-fixture", "1.4.0"]] as const) {
    const packageRoot = join(value.agentDir, "npm", "node_modules", name);
    await mkdir(join(packageRoot, "extensions"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version }));
    await writeFile(join(packageRoot, "extensions", "index.ts"), "export default () => {};\n");
  }
  await writeFile(executable, [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + "\\n");`,
    'if (args.includes("install")) {',
    '  const root = args[args.indexOf("--prefix") + 1];',
    '  const target = join(root, "node_modules", "exact-fixture");',
    '  mkdirSync(join(target, "extensions"), { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "exact-fixture", version: "2.0.0" }));',
    '  writeFileSync(join(target, "extensions", "index.ts"), "export default () => {};");',
    '}',
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, executable, "--", "npm"]);
  value.settings.setPackages(["npm:exact-fixture@2.0.0", "npm:range-fixture@^1.0.0"]);

  const resolved = await value.packages.resolve();

  assert.equal(resolved.extensions.some((entry) => entry.path.includes("exact-fixture")), true);
  assert.equal(resolved.extensions.some((entry) => entry.path.includes("range-fixture")), true);
  const calls = await readJsonLines(log);
  assert.equal(calls.some(({ args }) => args.includes("view")), false);
  assert.deepEqual(calls.filter(({ args }) => args.includes("install")).map(({ args }) => args[args.indexOf("install") + 1]), [
    "exact-fixture@2.0.0",
  ]);
});

test("availability checks retain the user package behind a project resource delta", async (context) => {
  if (skipUnavailableProcessCapture(
    context,
    await capturedChildOutput,
    "the execution environment does not expose nested child-process output",
  )) return;
  const value = await fixture("delta-updates");
  const executable = join(value.root, "manager.mjs");
  const userPath = join(value.agentDir, "npm", "node_modules", "shared-fixture");
  await mkdir(userPath, { recursive: true });
  await writeFile(join(userPath, "package.json"), JSON.stringify({ name: "shared-fixture", version: "1.0.0" }));
  await writeFile(executable, [
    'if (process.argv.includes("view")) process.stdout.write(JSON.stringify("2.0.0"));',
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, executable, "--", "npm"]);
  value.settings.setPackages(["npm:shared-fixture"]);
  value.settings.setProjectPackages([{
    source: "npm:shared-fixture",
    autoload: false,
    extensions: ["-extensions/disabled.ts"],
  }]);

  assert.deepEqual(await value.packages.checkForAvailableUpdates(), [{
    source: "npm:shared-fixture",
    displayName: "shared-fixture",
    type: "npm",
    scope: "user",
  }]);
});

test("an installed pinned Git source is freshly staged before dependency installation", async () => {
  const value = await fixture("git-ref");
  const binaryDirectory = join(value.root, "bin");
  const gitRuntime = join(binaryDirectory, "git.mjs");
  const gitLog = join(value.root, "git.jsonl");
  const managerRuntime = join(value.root, "manager.mjs");
  const managerLog = join(value.root, "manager.jsonl");
  const installed = join(value.agentDir, "git", "example.test", "owner", "fixture");
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "git-fixture", version: "1.0.0" }));
  await writeFile(gitRuntime, [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");`,
    'if (args.includes("clone")) {',
    '  const target = args.at(-1);',
    '  mkdirSync(target, { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "git-fixture", version: "2.0.0" }));',
    '} else if (args.includes("ls-remote")) {',
    '  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\trefs/heads/release\\n");',
    '} else if (args.includes("rev-parse")) {',
    '  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");',
    '}',
  ].join("\n"));
  await writeFile(managerRuntime, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(managerLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, managerRuntime, "--", "npm"]);
  const packages = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    activateCandidate: async () => {},
    gitCommand: [process.execPath, gitRuntime],
  });
  await packages.install("git:https://example.test/owner/fixture.git@release");

  const invocations = (await readJsonLines(gitLog)).map(({ args }) => args);
  const clone = invocations.find((args) => args.includes("clone"));
  const candidate = clone?.at(-1);
  assert.equal(clone?.at(-2), "https://example.test/owner/fixture.git");
  assert.equal(dirname(dirname(candidate ?? "")), value.agentDir);
  assert.match(basename(dirname(candidate ?? "")), /^\.rigyn-package-stage-/u);
  assert.equal(basename(candidate ?? ""), "package");
  assert.deepEqual(invocations.find((args) => args.includes("fetch"))?.slice(-3), ["--", "origin", "refs/heads/release"]);
  assert.deepEqual(invocations.find((args) => args.includes("checkout"))?.slice(-3), ["--no-recurse-submodules", "--detach", "FETCH_HEAD"]);
  assert.deepEqual(invocations.find((args) => args.includes("rev-parse"))?.slice(-2), ["--verify", "HEAD^{commit}"]);
  assert.equal(invocations.some((args) => args.includes("reset") || args.includes("clean")), false);
  const dependencyInstall = (await readJsonLines(managerLog))[0];
  assert.deepEqual(dependencyInstall?.args, ["--", "npm", "install", "--ignore-scripts=true", "--bin-links=false"]);
  assert.equal(dirname(dirname(dependencyInstall?.cwd ?? "")), value.agentDir);
  assert.match(basename(dirname(dependencyInstall?.cwd ?? "")), /^\.rigyn-package-stage-/u);
  assert.equal(basename(dependencyInstall?.cwd ?? ""), "package");
});

test("captured package-manager output settles only after inherited stdout closes", async (context) => {
  if (skipUnavailableProcessCapture(
    context,
    await capturedChildOutput,
    "the execution environment does not expose nested child-process output",
  )) return;
  const value = await fixture("close-settlement");
  const executable = join(value.root, "manager.mjs");
  const delayedOutput = join(value.root, "delayed-output.mjs");
  const installed = join(value.agentDir, "npm", "node_modules", "late-output");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "late-output", version: "1.0.0" }));
  await writeFile(delayedOutput, [
    'setTimeout(() => process.stdout.write(JSON.stringify("2.0.0")), 30);',
  ].join("\n"));
  await writeFile(executable, [
    'import { spawn } from "node:child_process";',
    'if (process.argv.includes("view")) {',
    `  spawn(process.execPath, [${JSON.stringify(delayedOutput)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();`,
    '}',
  ].join("\n"));
  value.settings.setNpmCommand([process.execPath, executable, "--", "npm"]);
  value.settings.setPackages(["npm:late-output"]);

  assert.deepEqual(await value.packages.checkForAvailableUpdates(), [{
    source: "npm:late-output",
    displayName: "late-output",
    type: "npm",
    scope: "user",
  }]);
});

test("temporary extension storage is private on POSIX systems", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission bits do not apply on Windows");
    return;
  }
  const value = await fixture("permissions");
  const temporaryRoot = getExtensionTempFolder(value.agentDir);
  const mode = (await stat(temporaryRoot)).mode & 0o777;

  assert.equal(mode, 0o700);
  assert.equal(dirname(temporaryRoot), join(value.agentDir, "tmp"));
});
