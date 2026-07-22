import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { DefaultPackageManager, type ProgressEvent } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

const capturedChildOutput = new Promise<boolean>((resolve) => {
  const child = spawn(process.execPath, ["--eval", 'process.stdout.write("ready")'], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  let settled = false;
  const finish = (supported: boolean): void => {
    if (settled) return;
    settled = true;
    resolve(supported);
  };
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.once("error", () => finish(false));
  child.once("close", (code) => finish(code === 0 && output === "ready"));
});

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

async function fixture(): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  packages: DefaultPackageManager;
  log: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-package-update-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const executable = join(root, "package-manager.mjs");
  const log = join(root, "calls.jsonl");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(executable, [
    'import { appendFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const operation = args.includes("view") ? "view" : args.includes("install") ? "install" : "other";',
    'const versions = JSON.parse(process.env.RIGYN_TEST_PACKAGE_VERSIONS ?? "{}");',
    'const spec = operation === "view" ? args[args.indexOf("view") + 1] : undefined;',
    'appendFileSync(process.env.RIGYN_TEST_PACKAGE_LOG, JSON.stringify({ operation, args, version: spec === undefined ? undefined : versions[spec] }) + "\\n");',
    'if (operation === "view") {',
    '  if (versions[spec] === "__error") process.exit(2);',
    '  process.stdout.write(JSON.stringify(versions[spec]));',
    "}",
  ].join("\n"));
  const settings = SettingsManager.inMemory({ npmCommand: [process.execPath, executable, "--", "npm"] });
  return {
    root,
    cwd,
    agentDir,
    settings,
    packages: new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }),
    log,
  };
}

async function installed(root: string, scope: "user" | "project", cwd: string, name: string, version: string): Promise<void> {
  const base = scope === "user" ? root : join(cwd, ".rigyn");
  const path = join(base, "npm", "node_modules", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version }));
}

async function calls(path: string): Promise<Array<{ operation: string; args: string[] }>> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { operation: string; args: string[] });
  } catch {
    return [];
  }
}

test("update errors suggest configured npm and Git source prefixes", async () => {
  const value = await fixture();
  value.settings.setPackages(["npm:example", "git:github.com/example/repository"]);
  await assert.rejects(value.packages.update("example"), /Did you mean npm:example\?/u);
  await assert.rejects(value.packages.update("github.com\/example\/repository"), /Did you mean git:github\.com\/example\/repository\?/u);
});

test("updates check versions concurrently and batch only eligible npm packages per scope", async (context) => {
  if (skipUnavailableProcessCapture(
    context,
    await capturedChildOutput,
    "the execution environment does not expose nested child-process output",
  )) return;
  const value = await fixture();
  await installed(value.agentDir, "user", value.cwd, "user-old", "1.0.0");
  await installed(value.agentDir, "user", value.cwd, "user-current", "1.0.0");
  await installed(value.agentDir, "user", value.cwd, "user-unknown", "1.0.0");
  await installed(value.agentDir, "user", value.cwd, "user-range", "1.0.0");
  await installed(value.agentDir, "project", value.cwd, "project-old", "1.0.0");
  await installed(value.agentDir, "project", value.cwd, "project-current", "1.0.0");
  value.settings.setPackages([
    "npm:user-old",
    "npm:user-current",
    "npm:user-unknown",
    "npm:user-range@^1.0.0",
    "npm:user-pinned@1.0.0",
  ]);
  value.settings.setProjectPackages(["npm:project-old", "npm:project-current", "npm:project-missing"]);
  process.env.RIGYN_TEST_PACKAGE_LOG = value.log;
  process.env.RIGYN_TEST_PACKAGE_VERSIONS = JSON.stringify({
    "user-old": "2.0.0",
    "user-current": "1.0.0",
    "user-unknown": "__error",
    "user-range@^1.0.0": ["1.0.0", "1.4.0", "2.0.0"],
    "project-old": "2.0.0",
    "project-current": "1.0.0",
  });
  const progress: ProgressEvent[] = [];
  value.packages.setProgressCallback((event) => progress.push(event));
  try {
    await value.packages.update();
  } finally {
    delete process.env.RIGYN_TEST_PACKAGE_LOG;
    delete process.env.RIGYN_TEST_PACKAGE_VERSIONS;
  }

  const recorded = await calls(value.log);
  const views = recorded.filter((entry) => entry.operation === "view");
  const installs = recorded.filter((entry) => entry.operation === "install");
  assert.equal(views.length, 6);
  assert.equal(installs.length, 2);
  assert.equal(views.some((entry) => entry.args.includes("user-pinned@1.0.0")), false);
  const userInstall = installs.find((entry) => entry.args.includes("user-old@latest"))!;
  const projectInstall = installs.find((entry) => entry.args.includes("project-old@latest"))!;
  const userRoot = userInstall.args[userInstall.args.indexOf("--prefix") + 1]!;
  const projectRoot = projectInstall.args[projectInstall.args.indexOf("--prefix") + 1]!;
  assert.equal(dirname(userRoot), value.agentDir);
  assert.equal(dirname(projectRoot), join(value.cwd, ".rigyn"));
  assert.match(basename(userRoot), /^\.rigyn-package-stage-/u);
  assert.match(basename(projectRoot), /^\.rigyn-package-stage-/u);
  assert.deepEqual(userInstall.args.slice(2), [
    "install", "user-old@latest", "user-unknown@latest", "user-range@^1.0.0",
    "--prefix", userRoot, "--legacy-peer-deps", "--ignore-scripts=true", "--bin-links=false",
  ]);
  assert.deepEqual(projectInstall.args.slice(2), [
    "install", "project-old@latest", "project-missing@latest",
    "--prefix", projectRoot, "--legacy-peer-deps", "--ignore-scripts=true", "--bin-links=false",
  ]);
  assert.deepEqual(progress.map(({ type, action, source }) => [type, action, source]).sort(), [
    ["complete", "update", "project npm packages"],
    ["complete", "update", "user npm packages"],
    ["start", "update", "project npm packages"],
    ["start", "update", "user npm packages"],
  ]);
});

test("available-update checks ignore pinned and missing packages", async (context) => {
  if (skipUnavailableProcessCapture(
    context,
    await capturedChildOutput,
    "the execution environment does not expose nested child-process output",
  )) return;
  const value = await fixture();
  await installed(value.agentDir, "user", value.cwd, "old", "1.0.0");
  await installed(value.agentDir, "user", value.cwd, "current", "2.0.0");
  await installed(value.agentDir, "user", value.cwd, "pinned", "1.0.0");
  value.settings.setPackages(["npm:old", "npm:current", "npm:pinned@1.0.0", "npm:missing"]);
  process.env.RIGYN_TEST_PACKAGE_LOG = value.log;
  process.env.RIGYN_TEST_PACKAGE_VERSIONS = JSON.stringify({ old: "2.0.0", current: "2.0.0" });
  try {
    assert.deepEqual(await value.packages.checkForAvailableUpdates(), [{
      source: "npm:old",
      displayName: "old",
      type: "npm",
      scope: "user",
    }]);
  } finally {
    delete process.env.RIGYN_TEST_PACKAGE_LOG;
    delete process.env.RIGYN_TEST_PACKAGE_VERSIONS;
  }
  const recorded = await calls(value.log);
  assert.deepEqual(recorded.filter((entry) => entry.operation === "view").map((entry) => entry.args[entry.args.indexOf("view") + 1]).sort(), ["current", "old"]);
});
