import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runSettingsConfigCommand } from "../../src/cli/config-settings-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";
import { CONFIG_SCHEMA_URI, hasNullValue, PORTABLE_CONFIG_SCAFFOLD } from "../helpers/config-scaffold.js";

test("config path reports exact user and project settings paths without creating files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-path-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const output: string[] = [];
  const options = {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    write: (value: string) => { output.push(value); },
  };

  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "path"]), options), true);
  assert.equal(output.pop(), `${join(agentDir, "config.json")}\n`);
  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "path", "--scope", "project"]), options), true);
  assert.equal(output.pop(), `${join(workspace, ".rigyn", "config.json")}\n`);
  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "path", "--json"]), options), true);
  assert.deepEqual(JSON.parse(output.pop()!), { scope: "user", path: join(agentDir, "config.json") });
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "path", "-l", "--scope", "project"]), options),
    /mutually exclusive/u,
  );
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--json"]), options),
    /valid for config path or validate only/u,
  );
  await assert.rejects(stat(agentDir), /ENOENT/u);
  await assert.rejects(stat(join(workspace, ".rigyn")), /ENOENT/u);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config validate checks the selected merged scope without creating or changing files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-validate-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const output: string[] = [];
  const options = {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    write: (value: string) => { output.push(value); },
  };

  assert.equal(
    await runSettingsConfigCommand(parseManagementArguments(["config", "validate", "--json"]), options),
    true,
  );
  assert.deepEqual(JSON.parse(output.pop()!), {
    schemaVersion: 1,
    scope: "user",
    path: join(agentDir, "config.json"),
    exists: false,
    valid: true,
    errors: [],
  });
  await assert.rejects(stat(agentDir), /ENOENT/u);

  await mkdir(agentDir);
  const globalPath = join(agentDir, "config.json");
  const globalContents = '{"compaction":{"triggerPercent":88},"extensionOwned":{"value":1}}\n';
  await writeFile(globalPath, globalContents, { mode: 0o600 });
  assert.equal(
    await runSettingsConfigCommand(parseManagementArguments(["config", "validate"]), options),
    true,
  );
  assert.equal(output.pop(), `Valid user config: ${globalPath}\n`);
  assert.equal(await readFile(globalPath, "utf8"), globalContents);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("project config commands cannot target the active Rigyn home", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-root-collision-"));
  const workspace = join(root, "home");
  const agentDir = join(workspace, ".rigyn");
  await mkdir(agentDir, { recursive: true });
  const configPath = join(agentDir, "config.json");
  const contents = '{"theme":"mono"}\n';
  await writeFile(configPath, contents);
  let edited = false;
  let trustChecks = 0;
  const output: string[] = [];
  const options = {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    projectTrustResolver: { async isTrusted() { trustChecks += 1; return true; } },
    write: (value: string) => { output.push(value); },
    edit: async () => { edited = true; return '{}\n'; },
  };

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "path", "--scope", "project"]), options),
    /active Rigyn home/u,
  );
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "path", "--scope", "project", "--json"]), options),
    /active Rigyn home/u,
  );
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), options),
    /active Rigyn home/u,
  );
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "validate", "--scope", "project"]), options),
    /active Rigyn home/u,
  );
  assert.equal(edited, false);
  assert.equal(trustChecks, 0);
  assert.deepEqual(output, []);
  assert.equal(await readFile(configPath, "utf8"), contents);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("project config edit rejects an aliased Rigyn home before its config root exists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-root-alias-"));
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
  const workspace = join(root, "actual-home");
  const alias = join(root, "home-alias");
  await mkdir(workspace);
  try {
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Directory aliases are unavailable on this Windows host");
      return;
    }
    throw error;
  }
  let edited = false;

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), {
      environment: { ...process.env, RIGYN_HOME: join(alias, ".rigyn") },
      cwd: workspace,
      projectTrustResolver: { async isTrusted() { return true; } },
      write() {},
      edit: async () => { edited = true; return '{}\n'; },
    }),
    /active Rigyn home/u,
  );
  assert.equal(edited, false);
  await assert.rejects(stat(join(workspace, ".rigyn")), /ENOENT/u);
});

test("config validate reports invalid known values and includes the global base for project scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-validate-errors-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await mkdir(agentDir);
  const globalPath = join(agentDir, "config.json");
  const projectPath = join(workspace, ".rigyn", "config.json");
  await writeFile(globalPath, '{"theme":"signal"}\n');
  await writeFile(projectPath, '{"compaction":{"triggerPercent":49}}\n');
  const output: string[] = [];
  const priorExitCode = process.exitCode;
  context.after(async () => {
    process.exitCode = priorExitCode;
    await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true }));
  });

  await assert.rejects(runSettingsConfigCommand(
    parseManagementArguments(["config", "validate", "--scope", "project", "--json"]),
    {
      environment: { ...process.env, RIGYN_HOME: agentDir },
      cwd: workspace,
      projectTrustResolver: { async isTrusted() { return false; } },
      write: (value) => { output.push(value); },
    },
  ), /validated only after the workspace is trusted/u);
  assert.equal(output.length, 0);

  assert.equal(await runSettingsConfigCommand(
    parseManagementArguments(["config", "validate", "--scope", "project", "--json"]),
    {
      environment: { ...process.env, RIGYN_HOME: agentDir },
      cwd: workspace,
      projectTrustResolver: { async isTrusted() { return true; } },
      write: (value) => { output.push(value); },
    },
  ), true);
  const report = JSON.parse(output.pop()!) as {
    scope: string;
    path: string;
    exists: boolean;
    valid: boolean;
    errors: Array<{ scope: string; message: string }>;
  };
  assert.equal(report.scope, "project");
  assert.equal(report.path, projectPath);
  assert.equal(report.exists, true);
  assert.equal(report.valid, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0]?.scope, "project");
  assert.match(report.errors[0]?.message ?? "", /triggerPercent/u);
  assert.equal(process.exitCode, 1);
  assert.equal(await readFile(globalPath, "utf8"), '{"theme":"signal"}\n');
  assert.equal(await readFile(projectPath, "utf8"), '{"compaction":{"triggerPercent":49}}\n');
});

test("the CLI validator reports a malformed user config without preparing or rewriting it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-validate-cli-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const path = join(agentDir, "config.json");
  const contents = '{"compaction":{"triggerPercent":49}}\n';
  await writeFile(path, contents, { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "config",
    "validate",
    "--workspace",
    workspace,
    "--json",
  ], {
    cwd: resolve("."),
    env: { ...process.env, RIGYN_HOME: agentDir },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout) as { valid: boolean; errors: Array<{ message: string }> };
  assert.equal(report.valid, false);
  assert.match(report.errors[0]?.message ?? "", /triggerPercent/u);
  assert.equal(await readFile(path, "utf8"), contents);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit opens the portable starter when user settings are missing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-template-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  let opened: Record<string, unknown> | undefined;
  await runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    write() {},
    edit: async (initial) => {
      opened = JSON.parse(initial) as Record<string, unknown>;
      return initial;
    },
  });

  assert.deepEqual(opened, PORTABLE_CONFIG_SCAFFOLD);
  assert.equal(hasNullValue(opened), false);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config.json"), "utf8")), opened);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit keeps a missing project override document schema-only", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-project-template-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  let initial: string | undefined;
  await runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    write() {},
    projectTrustResolver: { async isTrusted() { return true; } },
    edit: async (value) => {
      initial = value;
      return value;
    },
  });

  assert.deepEqual(JSON.parse(initial!), {
    $schema: CONFIG_SCHEMA_URI,
  });
  assert.deepEqual(JSON.parse(await readFile(join(workspace, ".rigyn", "config.json"), "utf8")), {
    $schema: CONFIG_SCHEMA_URI,
  });
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit validates JSON and replaces only the selected settings file privately", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-edit-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const authPath = join(agentDir, "auth.json");
  await mkdir(agentDir);
  await writeFile(authPath, "secret sentinel", { mode: 0o600 });
  const settingsPath = join(agentDir, "config.json");
  await writeFile(settingsPath, '{"quietStartup":true}\n', { mode: 0o644 });
  const signal = new AbortController().signal;
  const output: string[] = [];
  const options = {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    signal,
    write: (value: string) => { output.push(value); },
    edit: async (initial: string, editorOptions?: { signal?: AbortSignal }) => {
      assert.equal(initial, '{"quietStartup":true}\n');
      assert.equal(editorOptions?.signal, signal);
      return '{"defaultThinkingLevel":"max","theme":"mono"}';
    },
  };

  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), options), true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    defaultThinkingLevel: "max",
    theme: "mono",
  });
  if (process.platform !== "win32") assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(authPath, "utf8"), "secret sentinel");
  assert.equal(output.pop(), `Updated ${settingsPath}\n`);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit is transactional and project edits require trust", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-transaction-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const settingsPath = join(agentDir, "config.json");
  await writeFile(settingsPath, '{"theme":"mono"}\n', { mode: 0o600 });
  const base = {
    environment: { ...process.env, RIGYN_HOME: agentDir },
    cwd: workspace,
    write() {},
  };

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
      ...base,
      edit: async () => "[]",
    }),
    /JSON object/u,
  );
  assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"mono"}\n');

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
      ...base,
      edit: async () => '{"compaction":{"triggerPercent":49},"extensionOwned":{"value":1}}',
    }),
    /settings\.compaction\.triggerPercent/u,
  );
  assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"mono"}\n');

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
      ...base,
      edit: async () => JSON.stringify({ values: new Array(60_000).fill(0) }),
    }),
    /Normalized settings exceed/u,
  );
  assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"mono"}\n');

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
      ...base,
      edit: async () => {
        await writeFile(settingsPath, '{"theme":"concurrent"}\n');
        return '{"theme":"edited"}';
      },
    }),
    /changed while the external editor was open/u,
  );
  assert.equal(await readFile(settingsPath, "utf8"), '{"theme":"concurrent"}\n');

  if (process.platform !== "win32") await chmod(settingsPath, 0o644);
  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
    ...base,
    edit: async () => '{"theme":"mono"}',
  }), true);
  if (process.platform !== "win32") assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), {
      ...base,
      projectTrustResolver: { async isTrusted() { return false; } },
      edit: async () => '{"theme":"mono"}',
    }),
    /trusted/u,
  );
  await assert.rejects(stat(join(workspace, ".rigyn")), /ENOENT/u);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit rejects symbolic-link settings without reading or changing their target", async (context) => {
  if (process.platform === "win32") {
    context.skip("file symlink creation is not guaranteed on Windows runners");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-symlink-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const target = join(root, "auth-sentinel.json");
  await writeFile(target, '{"token":"secret"}\n', { mode: 0o600 });
  await symlink(target, join(agentDir, "config.json"));
  let edited = false;

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
      environment: { ...process.env, RIGYN_HOME: agentDir },
      cwd: workspace,
      write() {},
      edit: async () => { edited = true; return '{"theme":"mono"}'; },
    }),
    /regular file/u,
  );
  assert.equal(edited, false);
  assert.equal(await readFile(target, "utf8"), '{"token":"secret"}\n');
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("project config edit rejects a symbolic-link settings directory", async (context) => {
  if (process.platform === "win32") {
    context.skip("directory symlink creation is not guaranteed on Windows runners");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-directory-symlink-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const target = join(outside, "config.json");
  await writeFile(target, '{"token":"secret"}\n', { mode: 0o600 });
  await symlink(outside, join(workspace, ".rigyn"));
  let edited = false;

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), {
      environment: { ...process.env, RIGYN_HOME: agentDir },
      cwd: workspace,
      projectTrustResolver: { async isTrusted() { return true; } },
      write() {},
      edit: async () => { edited = true; return '{"theme":"mono"}'; },
    }),
    /Settings directory.*symbolic link/u,
  );
  assert.equal(edited, false);
  assert.equal(await readFile(target, "utf8"), '{"token":"secret"}\n');
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});
