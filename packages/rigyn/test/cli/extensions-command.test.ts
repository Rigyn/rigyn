import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runPackageCommand, runProjectPackageCommand } from "../../src/cli/extensions-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";

test("extensions doctor honors offline mode without creating a durable session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-extensions-doctor-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const extension = join(agentDir, "extensions", "offline-probe");
  const activationMarker = join(root, "extension-activated");
  const fakeNpm = join(root, "fake-npm.mjs");
  const networkAttemptMarker = join(root, "network-attempted");
  await mkdir(workspace);
  await mkdir(extension, { recursive: true });
  await writeFile(fakeNpm, [
    'import { writeFileSync } from "node:fs";',
    'if (process.argv.includes("root")) { process.stdout.write("/missing/global/node_modules\\n"); process.exit(0); }',
    `writeFileSync(${JSON.stringify(networkAttemptMarker)}, "attempted\\n");`,
    "process.exit(2);",
  ].join("\n"));
  await writeFile(join(agentDir, "config.json"), JSON.stringify({
    npmCommand: [process.execPath, fakeNpm],
    packages: ["npm:offline-probe-package@latest"],
  }));
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "offline-probe",
    type: "module",
    rigyn: { extensions: ["index.mjs"] },
  }));
  await writeFile(join(extension, "index.mjs"), `
    import { writeFileSync } from "node:fs";
    export default function activate() {
      writeFileSync(${JSON.stringify(activationMarker)}, "active:" + (process.env.RIGYN_OFFLINE ?? "unset") + "\\n");
    }
  `);
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const environment: NodeJS.ProcessEnv = { ...process.env, RIGYN_HOME: agentDir };
  delete environment.RIGYN_OFFLINE;

  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/rigyn.ts"),
    "extensions", "doctor", "--json", "--offline", "--workspace", workspace,
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout) as { healthy?: boolean; runtimeDiagnostics?: unknown[] };
  assert.equal(typeof report.healthy, "boolean");
  assert.ok(Array.isArray(report.runtimeDiagnostics));
  assert.equal(await readFile(activationMarker, "utf8"), "active:unset\n");
  await assert.rejects(access(networkAttemptMarker), /ENOENT/u);
  const sessionFiles = await readdir(join(agentDir, "sessions"), { recursive: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(sessionFiles, []);
  const observabilityFiles = await readdir(join(agentDir, "logs"), { recursive: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(observabilityFiles, []);
});

test("direct package management persists sources and never copies or deletes local packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-package-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  await mkdir(workspace);
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "direct-package-command",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\n");
  const previousAgentDir = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await runPackageCommand(parseManagementArguments([
    "install", packageRoot, "--workspace", workspace, "--json",
  ]));
  const installed = JSON.parse(await readFile(join(agentDir, "config.json"), "utf8")) as { packages?: string[] };
  assert.deepEqual(installed.packages, ["../package"]);
  await access(join(packageRoot, "extensions", "index.mjs"));

  await runPackageCommand(parseManagementArguments([
    "remove", packageRoot, "--workspace", workspace, "--json",
  ]));
  const removed = JSON.parse(await readFile(join(agentDir, "config.json"), "utf8")) as { packages?: string[] };
  assert.deepEqual(removed.packages, []);
  await access(join(packageRoot, "extensions", "index.mjs"));
});

test("offline legacy updates fail without printing text or JSON success", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-offline-legacy-update-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const fakeNpm = join(root, "fake-npm.mjs");
  const networkMarker = join(root, "network-attempted");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(fakeNpm, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(networkMarker)}, "ran");\n`);
  const configPath = join(agentDir, "config.json");
  await writeFile(configPath, JSON.stringify({
    npmCommand: [process.execPath, fakeNpm],
    packages: ["npm:offline-update-package"],
  }));
  const originalConfig = await readFile(configPath);
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const environment: NodeJS.ProcessEnv = { ...process.env, RIGYN_HOME: agentDir };
  delete environment.RIGYN_OFFLINE;
  const cases = [
    ["update", "npm:offline-update-package", "--offline", "--workspace", workspace],
    ["extensions", "update", "--all", "--offline", "--json", "--workspace", workspace],
  ];
  for (const argumentsValue of cases) {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", resolve("src/bin/rigyn.ts"), ...argumentsValue,
    ], {
      cwd: resolve("."),
      env: environment,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot resolve npm:offline-update-package while offline/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Updated |"updated"\s*:/u);
  }
  await assert.rejects(access(networkMarker), /ENOENT/u);
  assert.deepEqual(await readFile(configPath), originalConfig);
});

test("project package commands require trust before mutating project settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-project-package-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  await mkdir(workspace);
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "project-package" }));
  const previousAgentDir = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(runPackageCommand(parseManagementArguments([
    "install", packageRoot, "--local", "--workspace", workspace,
  ])), /project packages contain trusted code.*rerun with --approve.*\/trust/iu);
  await runPackageCommand(parseManagementArguments([
    "install", packageRoot, "--local", "--approve", "--workspace", workspace, "--json",
  ]));
  const configured = JSON.parse(await readFile(join(workspace, ".rigyn", "config.json"), "utf8")) as { packages?: string[] };
  assert.deepEqual(configured.packages, ["../../package"]);
});

test("project package commands cannot treat the active Rigyn home as project scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-project-package-root-collision-"));
  const workspace = join(root, "home");
  const agentDir = join(workspace, ".rigyn");
  const packageRoot = join(workspace, "review-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "root-collision-package",
    version: "1.0.0",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\n");
  const declarationPath = join(agentDir, "packages.json");
  const declaration = JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "collision", source: { kind: "local", path: "review-package" } }],
  });
  await writeFile(declarationPath, declaration);
  const previousAgentDir = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(runProjectPackageCommand(parseManagementArguments([
    "packages", "update", "--all", "--approve", "--workspace", workspace,
  ])), /require workspace trust/u);
  await assert.rejects(access(join(agentDir, "packages.lock.json")), /ENOENT/u);
  assert.equal(await readFile(declarationPath, "utf8"), declaration);
});

test("project package commands resolve declarations into the immutable installed set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-declared-package-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(workspace, "review-package");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "review-package",
    version: "1.0.0",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\n");
  await writeFile(join(workspace, ".rigyn", "packages.json"), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "review", source: { kind: "local", path: "review-package" } }],
  }));
  const previousAgentDir = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await runProjectPackageCommand(parseManagementArguments([
    "packages", "update", "--all", "--approve", "--workspace", workspace, "--json",
  ]));

  const lock = JSON.parse(await readFile(join(workspace, ".rigyn", "packages.lock.json"), "utf8")) as {
    packages?: Array<{ id?: string }>;
  };
  assert.deepEqual(lock.packages?.map((entry) => entry.id), ["review"]);
  await access(join(workspace, ".rigyn", "packages", "review", "extensions", "index.mjs"));
});

test("the project package --offline flag blocks remote resolution without an offline environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-declared-package-offline-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const command = join(root, "fake-npm.mjs");
  const marker = join(root, "remote-command-ran");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(command, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(2);\n`);
  await writeFile(join(agentDir, "config.json"), JSON.stringify({
    npmCommand: [process.execPath, command],
  }));
  await writeFile(join(workspace, ".rigyn", "packages.json"), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "registry", source: { kind: "npm", package: "registry-package", selector: "latest" } }],
  }));
  const previousAgentDir = process.env.RIGYN_HOME;
  const previousOffline = process.env.RIGYN_OFFLINE;
  process.env.RIGYN_HOME = agentDir;
  delete process.env.RIGYN_OFFLINE;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
    if (previousOffline === undefined) delete process.env.RIGYN_OFFLINE;
    else process.env.RIGYN_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(runProjectPackageCommand(parseManagementArguments([
    "packages", "update", "--all", "--offline", "--approve", "--workspace", workspace,
  ])), /while offline/u);
  await assert.rejects(access(marker), /ENOENT/u);
});
