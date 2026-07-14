import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceSessionIndex } from "../../src/cli/session-index.js";
import { SessionStore } from "../../src/storage/store.js";

async function runCli(argumentsValue: string[], environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin/rigyn.ts", ...argumentsValue], {
    cwd: resolve("."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI subprocess timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (value) => {
      clearTimeout(timeout);
      resolveExit(value);
    });
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("ordinary saved sessions remain available to all-workspace continue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-cross-workspace-session-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const config = join(root, "config");
  const state = join(root, "state");
  await Promise.all([
    mkdir(workspaceA),
    mkdir(workspaceB),
    mkdir(join(config, "rigyn"), { recursive: true, mode: 0o700 }),
    mkdir(state, { mode: 0o700 }),
  ]);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    NO_COLOR: "1",
  };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  const extension = resolve("examples/custom-provider/runtime/index.mjs");
  const providerArguments = [
    "--extension", extension,
    "--no-extensions",
    "--provider", "gallery-offline",
    "--model", "gallery-offline-v1",
    "--print",
  ];

  const first = await runCli([
    "run", "remember workspace a", "--workspace", workspaceA, ...providerArguments,
  ], environment);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "Offline provider: remember workspace a\n");

  const indexPath = join(state, "rigyn", "session-index.sqlite");
  const index = new DatabaseSync(indexPath, { readOnly: true });
  assert.equal(
    (index.prepare("SELECT count(*) AS count FROM sessions WHERE workspace_root = ?").get(workspaceA) as { count: number }).count,
    1,
  );
  index.close();

  const second = await runCli([
    "run", "resume from b", "--workspace", workspaceB, "--continue", "--all", "--approve", ...providerArguments,
  ], environment);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, "Offline provider: resume from b\n");

  const store = new SessionStore(join(state, "rigyn", "sessions.sqlite"));
  assert.equal(store.listThreads({ workspaceRoot: workspaceA }).length, 1);
  assert.equal(store.listThreads({ workspaceRoot: workspaceB }).length, 0);
  store.close();
});

test("an empty central index backfills every durable workspace in the shared session database", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-backfill-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const config = join(root, "config");
  const state = join(root, "state");
  const stateDirectory = join(state, "rigyn");
  await Promise.all([
    mkdir(workspaceA),
    mkdir(workspaceB),
    mkdir(join(config, "rigyn"), { recursive: true, mode: 0o700 }),
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const sessions = new SessionStore(join(stateDirectory, "sessions.sqlite"));
  for (const [threadId, workspaceRoot] of [["saved-a", workspaceA], ["saved-b", workspaceB]] as const) {
    sessions.createThread({ threadId, workspaceRoot });
    sessions.appendEvent({
      threadId,
      event: { type: "warning", code: "fixture", message: `saved in ${workspaceRoot}` },
    });
  }
  sessions.close();

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    NO_COLOR: "1",
  };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  const result = await runCli([
    "run",
    "create another durable event",
    "--workspace", workspaceB,
    "--extension", resolve("examples/custom-provider/runtime/index.mjs"),
    "--no-extensions",
    "--provider", "gallery-offline",
    "--model", "gallery-offline-v1",
    "--print",
  ], environment);
  assert.equal(result.code, 0, result.stderr);

  const index = new DatabaseSync(join(stateDirectory, "session-index.sqlite"), { readOnly: true });
  assert.deepEqual(
    (index.prepare("SELECT workspace_root FROM workspaces ORDER BY workspace_root").all() as Array<{ workspace_root: string }>)
      .map((row) => row.workspace_root),
    [workspaceA, workspaceB],
  );
  assert.equal(
    (index.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count,
    3,
  );
  index.close();
});

test("an invalid derived index is rebuilt without losing source session history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-rebuild-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const config = join(root, "config");
  const state = join(root, "state");
  const stateDirectory = join(state, "rigyn");
  await Promise.all([
    mkdir(workspaceA),
    mkdir(workspaceB),
    mkdir(join(config, "rigyn"), { recursive: true, mode: 0o700 }),
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const databasePath = join(stateDirectory, "sessions.sqlite");
  const sessions = new SessionStore(databasePath);
  sessions.createThread({ threadId: "saved-a", workspaceRoot: workspaceA });
  sessions.appendEvent({
    threadId: "saved-a",
    event: { type: "warning", code: "fixture", message: "saved source history" },
  });
  sessions.close();

  const indexPath = join(stateDirectory, "session-index.sqlite");
  const invalid = new DatabaseSync(indexPath);
  invalid.exec(`
    PRAGMA application_id = ${0x43485349};
    PRAGMA user_version = 1;
    CREATE TABLE workspaces(foo TEXT) STRICT;
    CREATE TABLE sessions(foo TEXT) STRICT;
  `);
  invalid.close();

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    NO_COLOR: "1",
  };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  const result = await runCli([
    "run",
    "create another durable event",
    "--workspace", workspaceB,
    "--extension", resolve("examples/custom-provider/runtime/index.mjs"),
    "--no-extensions",
    "--provider", "gallery-offline",
    "--model", "gallery-offline-v1",
    "--print",
  ], environment);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Rebuilt the derived cross-workspace session index/u);

  const rebuilt = new DatabaseSync(indexPath, { readOnly: true });
  assert.deepEqual(
    (rebuilt.prepare("SELECT workspace_root FROM workspaces ORDER BY workspace_root").all() as Array<{ workspace_root: string }>)
      .map((row) => row.workspace_root),
    [workspaceA, workspaceB],
  );
  rebuilt.close();
  const source = new SessionStore(databasePath);
  assert.ok(source.getThread("saved-a"));
  source.close();
});

test("a partial central index backfills durable workspaces that were never indexed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-partial-backfill-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const workspaceC = join(root, "workspace-c");
  const config = join(root, "config");
  const state = join(root, "state");
  const stateDirectory = join(state, "rigyn");
  await Promise.all([
    mkdir(workspaceA),
    mkdir(workspaceB),
    mkdir(workspaceC),
    mkdir(join(config, "rigyn"), { recursive: true, mode: 0o700 }),
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const databasePath = join(stateDirectory, "sessions.sqlite");
  const sessions = new SessionStore(databasePath);
  for (const [threadId, workspaceRoot] of [["saved-a", workspaceA], ["saved-c", workspaceC]] as const) {
    sessions.createThread({ threadId, workspaceRoot });
    sessions.appendEvent({
      threadId,
      event: { type: "warning", code: "fixture", message: `saved in ${workspaceRoot}` },
    });
  }
  sessions.close();

  const indexPath = join(stateDirectory, "session-index.sqlite");
  const partial = await WorkspaceSessionIndex.open(indexPath);
  await partial.refreshWorkspace({ workspaceRoot: workspaceA, databasePath });
  partial.close();

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    NO_COLOR: "1",
  };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  const result = await runCli([
    "run",
    "create another durable event",
    "--workspace", workspaceB,
    "--extension", resolve("examples/custom-provider/runtime/index.mjs"),
    "--no-extensions",
    "--provider", "gallery-offline",
    "--model", "gallery-offline-v1",
    "--print",
  ], environment);
  assert.equal(result.code, 0, result.stderr);

  const index = new DatabaseSync(indexPath, { readOnly: true });
  assert.deepEqual(
    (index.prepare("SELECT workspace_root FROM workspaces ORDER BY workspace_root").all() as Array<{ workspace_root: string }>)
      .map((row) => row.workspace_root),
    [workspaceA, workspaceB, workspaceC],
  );
  assert.equal((index.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count, 3);
  index.close();
});
