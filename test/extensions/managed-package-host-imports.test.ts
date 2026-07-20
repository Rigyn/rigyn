import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import {
  LocalExtensionPackageManager,
  discoverExtensions,
  loadRuntimeExtensions,
} from "../../src/extensions/index.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-managed-host-imports-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function command(commandValue: string, args: readonly string[], cwd: string): Promise<void> {
  const child = spawn(commandValue, [...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    },
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (value: Buffer) => stderr.push(value));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`${commandValue} failed (${result.code ?? result.signal}): ${Buffer.concat(stderr).toString("utf8")}`);
  }
}

async function npmInvocation(): Promise<{ command: string; prefix: string[] }> {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) throw new Error("npm_execpath is required for npm package tests on Windows");
  return { command: process.execPath, prefix: [npmExecPath] };
}

async function pack(root: string, source: string): Promise<string> {
  const destination = join(root, `archives-${basename(source)}`);
  await mkdir(destination);
  const npm = await npmInvocation();
  await command(npm.command, [
    ...npm.prefix,
    "pack",
    "--ignore-scripts=true",
    "--json=false",
    "--silent",
    "--pack-destination",
    destination,
    "--",
    source,
  ], root);
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  return join(destination, archives[0]!);
}

async function writePackage(source: string, blocked = false): Promise<void> {
  await mkdir(join(source, "runtime", "commonjs"), { recursive: true });
  await writeFile(join(source, "package.json"), `${JSON.stringify({
    name: blocked ? "rigyn-blocked-host-import" : "rigyn-managed-host-import",
    version: "1.0.0",
    type: "module",
    peerDependencies: { rigyn: ">=0.2.0 <1" },
  }, null, 2)}\n`);
  await writeFile(join(source, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: blocked ? "blocked-host-import" : "managed-host-import",
    name: blocked ? "Blocked host import" : "Managed host import",
    version: "1.0.0",
    contributions: {
      runtime: blocked
        ? [{ path: "runtime/blocked.mjs" }]
        : [
            { path: "runtime/esm.mjs" },
            { path: "runtime/typescript.ts" },
            { path: "runtime/commonjs/index.js" },
          ],
    },
  }, null, 2)}\n`);
  if (blocked) {
    await writeFile(join(source, "runtime", "blocked.mjs"), `
import "rigyn/extensions/runtime";
export default function activate() {}
`);
    return;
  }
  const imports = `
import { estimateTextTokens } from "rigyn/context";
import { isNormalizedUsage } from "rigyn/core";
import { defineRuntimeTool } from "rigyn/extensions";
import { sniffImageMediaType } from "rigyn/images";
import { createNetworkTransport } from "rigyn/net";
import { resolveExecutable } from "rigyn/process";
import { instructionMessage } from "rigyn/prompts";
import { defineProviderAdapter } from "rigyn/providers";
import { createScriptedProvider } from "rigyn/testing";
import { sha256 } from "rigyn/tools";
import { uiText } from "rigyn/tui";
`;
  await writeFile(join(source, "runtime", "esm.mjs"), `${imports}
if ([estimateTextTokens, isNormalizedUsage, defineRuntimeTool, sniffImageMediaType, createNetworkTransport, resolveExecutable, instructionMessage, defineProviderAdapter, createScriptedProvider, sha256, uiText].some((value) => typeof value !== "function")) throw new Error("ESM host imports are invalid");
export default function activate(api) {
  api.registerCommand({ name: "host-import-esm", execute() {} });
}
`);
  await writeFile(join(source, "runtime", "typescript.ts"), `${imports}
const imports: Array<unknown> = [estimateTextTokens, isNormalizedUsage, defineRuntimeTool, sniffImageMediaType, createNetworkTransport, resolveExecutable, instructionMessage, defineProviderAdapter, createScriptedProvider, sha256, uiText];
if (imports.some((value) => typeof value !== "function")) throw new Error("TypeScript host imports are invalid");
export default function activate(api: { registerCommand(command: { name: string; execute(): void }): void }) {
  api.registerCommand({ name: "host-import-typescript", execute() {} });
}
`);
  await writeFile(join(source, "runtime", "commonjs", "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
  await writeFile(join(source, "runtime", "commonjs", "index.js"), `
const { estimateTextTokens } = require("rigyn/context");
const { isNormalizedUsage } = require("rigyn/core");
const { defineRuntimeTool } = require("rigyn/extensions");
const { sniffImageMediaType } = require("rigyn/images");
const { createNetworkTransport } = require("rigyn/net");
const { resolveExecutable } = require("rigyn/process");
const { instructionMessage } = require("rigyn/prompts");
const { defineProviderAdapter } = require("rigyn/providers");
const { createScriptedProvider } = require("rigyn/testing");
const { sha256 } = require("rigyn/tools");
const { uiText } = require("rigyn/tui");
if ([estimateTextTokens, isNormalizedUsage, defineRuntimeTool, sniffImageMediaType, createNetworkTransport, resolveExecutable, instructionMessage, defineProviderAdapter, createScriptedProvider, sha256, uiText].some((value) => typeof value !== "function")) throw new Error("CommonJS host imports are invalid");
module.exports = function activate(api) {
  api.registerCommand({ name: "host-import-commonjs", execute() {} });
};
`);
}

async function writeLifecyclePackage(
  source: string,
  options: { id: string; command: string; tool: string; dependency: string; dependencyVersion: string },
): Promise<void> {
  await mkdir(join(source, "runtime"), { recursive: true });
  await writeFile(join(source, "package.json"), `${JSON.stringify({
    name: `rigyn-${options.id}`,
    version: "1.0.0",
    type: "module",
    dependencies: { [options.dependency]: options.dependencyVersion },
    peerDependencies: { rigyn: ">=0.2.0 <1" },
  }, null, 2)}\n`);
  await writeFile(join(source, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: options.id,
    name: options.id,
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }, null, 2)}\n`);
  await writeFile(join(source, "runtime", "index.mjs"), `
import { defineRuntimeTool } from "rigyn/extensions";
import { value } from ${JSON.stringify(options.dependency)};

export default function activate(api) {
  api.registerTool(defineRuntimeTool({
    name: ${JSON.stringify(options.tool)},
    description: "Return the externally installed dependency marker.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute() { return { content: value, isError: false }; },
  }));
  api.registerCommand({
    name: ${JSON.stringify(options.command)},
    execute() { return { prompt: value }; },
  });
}
`);
}

async function writeDependencyInstaller(root: string): Promise<string> {
  const script = join(root, "install-dependencies.mjs");
  await writeFile(script, `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (!args.includes("--ignore-scripts=true") || !args.includes("--omit=dev") || !args.includes("--bin-links=false")) {
  process.exit(3);
}
const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  const destination = join(process.cwd(), "node_modules", ...name.split("/"));
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "package.json"), JSON.stringify({
    name,
    version,
    type: "module",
    exports: "./index.mjs",
  }));
  await writeFile(join(destination, "index.mjs"), "export const value = " + JSON.stringify(name + "@" + version) + ";\\n");
}
`);
  return script;
}

async function commitRepository(repository: string): Promise<void> {
  const identity = [
    "-c", "user.name=Rigyn Test",
    "-c", "user.email=rigyn@example.invalid",
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=",
  ];
  await command("git", ["-C", repository, ...identity, "add", "-A"], repository);
  await command("git", ["-C", repository, ...identity, "commit", "--quiet", "-m", "external fixture"], repository);
}

async function assertLifecycle(
  manager: LocalExtensionPackageManager,
  workspace: string,
  expected: { command: string; tool: string; prompt: string },
): Promise<void> {
  const load = async () => {
    const catalog = await discoverExtensions(manager.sources(true));
    return await loadRuntimeExtensions(catalog.bundle().runtime, {
      workspace,
      activationFailure: "throw",
    });
  };
  const first = await load();
  assert.deepEqual(first.diagnostics(), []);
  assert.deepEqual(first.commands().map((entry) => entry.name), [expected.command]);
  assert.deepEqual(first.tools().map((entry) => entry.definition.name), [expected.tool]);
  assert.deepEqual(await first.runCommand(expected.command, {
    args: "",
    threadId: "external-package-proof",
    signal: new AbortController().signal,
  }), { handled: true, prompt: expected.prompt });

  const reloaded = await load();
  await first.close();
  assert.deepEqual(reloaded.diagnostics(), []);
  assert.deepEqual(await reloaded.runCommand(expected.command, {
    args: "",
    threadId: "external-package-proof-reload",
    signal: new AbortController().signal,
  }), { handled: true, prompt: expected.prompt });
  await reloaded.close();
}

test("external managed archives value-import bounded host subpaths across supported module formats", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  await mkdir(source);
  await mkdir(workspace);
  await writePackage(source);
  const archive = await pack(root, source);
  const manager = new LocalExtensionPackageManager(
    { user: join(root, "installed") },
    {},
    {},
    { operationLeaseRoot: join(root, "leases") },
  );

  const installed = await manager.install(`npm:${pathToFileURL(archive).href}`);
  await assert.rejects(access(join(installed.packageRoot, "node_modules", "rigyn")), /ENOENT/u);
  const firstCatalog = await discoverExtensions(manager.sources(true));
  const first = await loadRuntimeExtensions(firstCatalog.bundle().runtime, {
    workspace,
    activationFailure: "throw",
  });
  assert.deepEqual(first.commands().map((command) => command.name).sort(), [
    "host-import-commonjs",
    "host-import-esm",
    "host-import-typescript",
  ]);

  const reloadedCatalog = await discoverExtensions(manager.sources(true));
  const reloaded = await loadRuntimeExtensions(reloadedCatalog.bundle().runtime, {
    workspace,
    activationFailure: "throw",
  });
  await first.close();
  assert.deepEqual(reloaded.commands().map((command) => command.name).sort(), [
    "host-import-commonjs",
    "host-import-esm",
    "host-import-typescript",
  ]);
  await reloaded.close();

  await manager.remove("managed-host-import");
  assert.equal((await manager.list()).length, 0);
  assert.equal((await discoverExtensions(manager.sources(true))).bundle().runtime.length, 0);
});

test("external managed runtimes cannot use undeclared Rigyn internal subpaths", async (t) => {
  const root = await temporary(t);
  const source = join(root, "blocked-source");
  await mkdir(source);
  await writePackage(source, true);
  const archive = await pack(root, source);
  const manager = new LocalExtensionPackageManager(
    { user: join(root, "installed") },
    {},
    {},
    { operationLeaseRoot: join(root, "leases") },
  );
  await assert.rejects(
    manager.install(`npm:${pathToFileURL(archive).href}`),
    /Runtime extensions may import only documented host modules:.*rigyn\/extensions\/runtime is not exposed/su,
  );
  assert.deepEqual(await manager.list(), []);
  assert.equal((await discoverExtensions(manager.sources(true))).bundle().runtime.length, 0);
});

test("external Git and packed npm packages complete install, activate, reload, dependency, host-import, and remove lifecycles", async (t) => {
  const root = await temporary(t);
  const workspace = join(root, "workspace");
  const repository = join(root, "external-git-repository");
  const npmSource = join(root, "external-npm-source");
  await mkdir(workspace);
  await mkdir(repository);
  await mkdir(npmSource);
  const dependencyInstaller = await writeDependencyInstaller(root);
  const manager = new LocalExtensionPackageManager(
    { user: join(root, "installed") },
    {},
    { npm: { command: process.execPath, prefix: [dependencyInstaller] } },
    { operationLeaseRoot: join(root, "leases") },
  );

  await writeLifecyclePackage(repository, {
    id: "external-git-lifecycle",
    command: "external-git-proof",
    tool: "external_git_dependency",
    dependency: "git-fixture-dependency",
    dependencyVersion: "1.2.3",
  });
  await command("git", ["init", "--quiet", "--initial-branch=main", repository], root);
  await commitRepository(repository);
  const gitInstalled = await manager.install(`git:${pathToFileURL(repository).href}#main`);
  await access(join(gitInstalled.packageRoot, "node_modules", "git-fixture-dependency", "index.mjs"));
  await assert.rejects(access(join(gitInstalled.packageRoot, "node_modules", "rigyn")), /ENOENT/u);
  await assertLifecycle(manager, workspace, {
    command: "external-git-proof",
    tool: "external_git_dependency",
    prompt: "git-fixture-dependency@1.2.3",
  });
  await manager.remove("external-git-lifecycle");
  assert.deepEqual(await manager.list(), []);
  assert.equal((await discoverExtensions(manager.sources(true))).bundle().runtime.length, 0);

  await writeLifecyclePackage(npmSource, {
    id: "external-npm-lifecycle",
    command: "external-npm-proof",
    tool: "external_npm_dependency",
    dependency: "npm-fixture-dependency",
    dependencyVersion: "4.5.6",
  });
  const archive = await pack(root, npmSource);
  const npmInstalled = await manager.install(`npm:${pathToFileURL(archive).href}`);
  await access(join(npmInstalled.packageRoot, "node_modules", "npm-fixture-dependency", "index.mjs"));
  await assert.rejects(access(join(npmInstalled.packageRoot, "node_modules", "rigyn")), /ENOENT/u);
  await assertLifecycle(manager, workspace, {
    command: "external-npm-proof",
    tool: "external_npm_dependency",
    prompt: "npm-fixture-dependency@4.5.6",
  });
  await manager.remove("external-npm-lifecycle");
  assert.deepEqual(await manager.list(), []);
  assert.equal((await discoverExtensions(manager.sources(true))).bundle().runtime.length, 0);
});
