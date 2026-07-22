import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSettingsConfigCommand } from "../../src/cli/config-settings-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";

test("config path reports exact user and project settings paths without creating files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-path-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const output: string[] = [];
  const options = {
    environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
    cwd: workspace,
    write: (value: string) => { output.push(value); },
  };

  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "path"]), options), true);
  assert.equal(output.pop(), `${join(agentDir, "settings.json")}\n`);
  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "path", "--scope", "project"]), options), true);
  assert.equal(output.pop(), `${join(workspace, ".rigyn", "settings.json")}\n`);
  assert.equal(await runSettingsConfigCommand(parseManagementArguments(["config", "path", "--json"]), options), true);
  assert.deepEqual(JSON.parse(output.pop()!), { scope: "user", path: join(agentDir, "settings.json") });
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "path", "-l", "--scope", "project"]), options),
    /mutually exclusive/u,
  );
  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--json"]), options),
    /valid for config path only/u,
  );
  await assert.rejects(stat(agentDir), /ENOENT/u);
  await assert.rejects(stat(join(workspace, ".rigyn")), /ENOENT/u);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit opens a complete inherited-default document when settings are missing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-template-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  let opened: Record<string, unknown> | undefined;
  await runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
    environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
    cwd: workspace,
    write() {},
    edit: async (initial) => {
      opened = JSON.parse(initial) as Record<string, unknown>;
      return initial;
    },
  });

  assert.equal(opened?.defaultProvider, null);
  assert.equal(opened?.theme, "mono");
  assert.deepEqual(opened?.tools, { enabled: null, excluded: [] });
  assert.ok(Object.keys(opened?.keybindings as Record<string, unknown>).includes("app.interrupt"));
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), opened);
  context.after(async () => await import("node:fs/promises").then(async ({ rm }) => await rm(root, { recursive: true, force: true })));
});

test("config edit keeps a missing project override document sparse", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-project-template-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  let initial: string | undefined;
  await runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), {
    environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
    cwd: workspace,
    write() {},
    projectTrustResolver: { async isTrusted() { return true; } },
    edit: async (value) => {
      initial = value;
      return value;
    },
  });

  assert.equal(initial, "{}\n");
  assert.deepEqual(JSON.parse(await readFile(join(workspace, ".rigyn", "settings.json"), "utf8")), {});
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
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, '{"quietStartup":true}\n', { mode: 0o644 });
  const signal = new AbortController().signal;
  const output: string[] = [];
  const options = {
    environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
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
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, '{"theme":"mono"}\n', { mode: 0o600 });
  const base = {
    environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
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
  await symlink(target, join(agentDir, "settings.json"));
  let edited = false;

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit"]), {
      environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
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
  const target = join(outside, "settings.json");
  await writeFile(target, '{"token":"secret"}\n', { mode: 0o600 });
  await symlink(outside, join(workspace, ".rigyn"));
  let edited = false;

  await assert.rejects(
    runSettingsConfigCommand(parseManagementArguments(["config", "edit", "--scope", "project"]), {
      environment: { ...process.env, RIGYN_CODING_AGENT_DIR: agentDir },
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
