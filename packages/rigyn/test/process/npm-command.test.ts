import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultNpmCommand } from "../../src/process/npm-command.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import { PROJECT_PACKAGE_DECLARATION, ProjectPackageManager } from "../../src/extensions/project-packages.js";

async function withWindowsNpm<T>(npmCli: string, operation: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const priorNpmExecPath = process.env.npm_execpath;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  process.env.npm_execpath = npmCli;
  try { return await operation(); }
  finally {
    Object.defineProperty(process, "platform", platform);
    if (priorNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = priorNpmExecPath;
  }
}

test("Windows npm resolution launches npm-cli.js through Node without a command shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-"));
  const node = join(root, "node.exe");
  const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(join(root, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(node, "");
  await writeFile(npmCli, "");

  assert.deepEqual(defaultNpmCommand("win32", {}, node), [node, npmCli]);
  assert.deepEqual(defaultNpmCommand("linux", {}, node), ["npm"]);
});

test("Windows npm resolution honors the active npm entry point", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-env-"));
  const node = join(root, "node.exe");
  const npmCli = join(root, "active-npm-cli.js");
  await writeFile(npmCli, "");

  assert.deepEqual(defaultNpmCommand("win32", { npm_execpath: npmCli }, node), [node, npmCli]);
});

test("Windows-simulated default package operations execute npm-cli.js through Node without a shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-live-default-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const npmCli = join(root, "npm-cli & shell-marker.js");
  const log = join(root, "argv.json");
  await mkdir(workspace);
  await mkdir(agentDir);
  await writeFile(npmCli, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const args = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ execPath: process.execPath, entry: process.argv[1], args }));`,
    'const root = args[args.indexOf("--prefix") + 1];',
    'mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });',
    'writeFileSync(join(root, "node_modules", "fixture", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));',
  ].join("\n"));
  const settings = SettingsManager.inMemory();
  const packages = new DefaultPackageManager({ cwd: workspace, agentDir, settingsManager: settings });

  await withWindowsNpm(npmCli, async () => await packages.install("npm:fixture"));
  const recorded = JSON.parse(await readFile(log, "utf8")) as { execPath: string; entry: string; args: string[] };
  assert.deepEqual([recorded.execPath, recorded.entry], [process.execPath, npmCli]);
  const { args } = recorded;
  assert.deepEqual(args, [
    "install", "fixture", "--prefix", args[3],
    "--legacy-peer-deps", "--ignore-scripts=true", "--bin-links=false",
  ]);
  assert.match(args[3] ?? "", /\.rigyn-package-stage-/u);
});

test("Windows-simulated project package operations execute the resolved Node npm-cli argv without a shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-live-project-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const npmCli = join(root, "npm-cli & shell-marker.js");
  const log = join(root, "argv.jsonl");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await writeFile(npmCli, [
    'import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ execPath: process.execPath, entry: process.argv[1], args }) + "\\n");`,
    'if (args[0] === "pack") {',
    ' const destination = args[args.indexOf("--pack-destination") + 1];',
    ' mkdirSync(destination, { recursive: true });',
    ' writeFileSync(join(destination, "fixture-1.0.0.tgz"), "fixture@1.0.0");',
    ' process.stdout.write(JSON.stringify([{ filename: "fixture-1.0.0.tgz" }]));',
    '} else if (args[0] === "install") {',
    ' const root = args[args.indexOf("--prefix") + 1];',
    ' const target = join(root, "node_modules", "fixture");',
    ' mkdirSync(join(target, "extensions"), { recursive: true });',
    ' writeFileSync(join(target, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", rigyn: { extensions: ["extensions/index.mjs"] } }));',
    ' writeFileSync(join(target, "extensions", "index.mjs"), "export default () => {};\\n");',
    '}',
  ].join("\n"));
  await writeFile(join(workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "fixture", source: { kind: "npm", package: "fixture", selector: "1.0.0" } }],
  }));
  const packages = new ProjectPackageManager({
    workspace,
    projectTrusted: true,
    operationLeaseRoot: join(root, "leases"),
  });

  await withWindowsNpm(npmCli, async () => await packages.update({ all: true }));
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    execPath: string;
    entry: string;
    args: string[];
  });
  assert.equal(calls.every((call) => call.execPath === process.execPath && call.entry === npmCli), true);
  assert.equal(calls[0]?.args[0], "pack");
  assert.equal(calls.some((call) => call.args[0] === "install"), true);
});

test("normal resource refresh propagates the configured npm argv to project-package reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-resource-loader-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const npmCli = join(root, "npm-cli.js");
  const log = join(root, "argv.jsonl");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(npmCli, [
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'const rawArgs = process.argv.slice(2);',
    'const args = rawArgs[0] === "--configured" ? rawArgs.slice(1) : rawArgs;',
    'if (args[0] === "pack") {',
    ' const destination = args[args.indexOf("--pack-destination") + 1];',
    ' mkdirSync(destination, { recursive: true });',
    ' writeFileSync(join(destination, "fixture-1.0.0.tgz"), "fixture@1.0.0");',
    ' process.stdout.write(JSON.stringify([{ filename: "fixture-1.0.0.tgz" }]));',
    '} else if (args[0] === "install") {',
    ' const root = args[args.indexOf("--prefix") + 1];',
    ' const target = join(root, "node_modules", "fixture");',
    ' mkdirSync(join(target, "extensions"), { recursive: true });',
    ' writeFileSync(join(target, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", rigyn: { extensions: ["extensions/index.mjs"] } }));',
    ' writeFileSync(join(target, "extensions", "index.mjs"), "export default () => {};\\n");',
    '}',
  ].join("\n"));
  await writeFile(join(workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "fixture", source: { kind: "npm", package: "fixture", selector: "1.0.0" } }],
  }));
  const settings = SettingsManager.inMemory();
  settings.setProjectTrusted(true);
  settings.setNpmCommand([process.execPath, npmCli, "--configured"]);
  await new ProjectPackageManager({
    workspace,
    projectTrusted: true,
    operationLeaseRoot: join(root, "leases"),
    commands: { npm: { command: process.execPath, prefix: [npmCli] } },
  }).update({ all: true });
  await rm(join(workspace, ".rigyn", "packages"), { recursive: true, force: true });
  await writeFile(log, "");

  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings });
  t.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.refresh();
  const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.every((args) => args[0] === "--configured"), true);
  assert.equal(calls.some((args) => args[1] === "pack"), true);
  assert.equal(calls.some((args) => args[1] === "install"), true);
});
