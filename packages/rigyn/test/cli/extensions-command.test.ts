import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runPackageCommand, runProjectPackageCommand } from "../../src/cli/extensions-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";

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
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await runPackageCommand(parseManagementArguments([
    "install", packageRoot, "--workspace", workspace, "--json",
  ]));
  const installed = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: string[] };
  assert.deepEqual(installed.packages, ["../package"]);
  await access(join(packageRoot, "extensions", "index.mjs"));

  await runPackageCommand(parseManagementArguments([
    "remove", packageRoot, "--workspace", workspace, "--json",
  ]));
  const removed = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: string[] };
  assert.deepEqual(removed.packages, []);
  await access(join(packageRoot, "extensions", "index.mjs"));
});

test("project package commands require trust before mutating project settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-project-package-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  await mkdir(workspace);
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "project-package" }));
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(runPackageCommand(parseManagementArguments([
    "install", packageRoot, "--local", "--workspace", workspace,
  ])), /project packages contain trusted code.*rerun with --approve.*\/trust/iu);
  await runPackageCommand(parseManagementArguments([
    "install", packageRoot, "--local", "--approve", "--workspace", workspace, "--json",
  ]));
  const configured = JSON.parse(await readFile(join(workspace, ".rigyn", "settings.json"), "utf8")) as { packages?: string[] };
  assert.deepEqual(configured.packages, ["../../package"]);
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
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
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
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    npmCommand: [process.execPath, command],
  }));
  await writeFile(join(workspace, ".rigyn", "packages.json"), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "registry", source: { kind: "npm", package: "registry-package", selector: "latest" } }],
  }));
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  const previousOffline = process.env.RIGYN_OFFLINE;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  delete process.env.RIGYN_OFFLINE;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.RIGYN_OFFLINE;
    else process.env.RIGYN_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(runProjectPackageCommand(parseManagementArguments([
    "packages", "update", "--all", "--offline", "--approve", "--workspace", workspace,
  ])), /while offline/u);
  await assert.rejects(access(marker), /ENOENT/u);
});
