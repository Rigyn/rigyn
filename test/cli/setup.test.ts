import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  persistDefaultSelection,
  persistUiPreferences,
  updateGlobalConfig,
} from "../../src/cli/setup.js";
import type { HarnessPaths } from "../../src/cli/paths.js";
import { parseJsoncObject, type JsonObject } from "../../src/config/index.js";

const setupModule = pathToFileURL(resolve("src/cli/setup.ts")).href;
const updaterProgram = `
  import { access, writeFile } from "node:fs/promises";
  import { setTimeout as delay } from "node:timers/promises";
  const { updateGlobalConfig } = await import(${JSON.stringify(setupModule)});
  await writeFile(process.env.READY, "ready");
  while (true) {
    try { await access(process.env.GATE); break; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await delay(5);
  }
  await updateGlobalConfig(process.env.CONFIG, async (existing) => {
    await delay(25);
    return { ...existing, [process.env.KEY]: Number(process.env.VALUE) };
  }, { lockTimeoutMs: 10_000, retryDelayMs: 5 });
`;

interface SpawnedWorker {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function pathsFor(root: string): HarnessPaths {
  return {
    configDirectory: join(root, "config"),
    stateDirectory: join(root, "state"),
    globalConfig: join(root, "config", "config.jsonc"),
    trustStore: join(root, "config", "trust.json"),
    credentialStore: join(root, "config", "credentials.enc"),
    credentialKey: join(root, "config", "credentials.key"),
    database: join(root, "state", "sessions.sqlite"),
    modelCatalog: join(root, "state", "models.json"),
    userSkills: join(root, "config", "skills"),
    userExtensions: join(root, "config", "extensions"),
    userPrompts: join(root, "config", "prompts"),
    userThemes: join(root, "config", "themes"),
  };
}

function spawnWorker(program: string, environment: Record<string, string>): SpawnedWorker {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const chunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        done({ code, signal, stderr: Buffer.concat(chunks).toString("utf8") });
      });
    },
  );
  return { child, closed };
}

async function stopWorker(worker: SpawnedWorker): Promise<void> {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill("SIGKILL");
  }
  await worker.closed.catch(() => undefined);
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(10);
  }
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  return parseJsoncObject(await readFile(path, "utf8"), path);
}

async function assertNoWriteArtifacts(configPath: string): Promise<void> {
  const directory = resolve(configPath, "..");
  const names = await readdir(directory);
  const configName = basename(configPath);
  const lockName = `${configName}.lock.sqlite3`;
  assert.equal(names.includes(lockName), true);
  assert.deepEqual(
    names.filter(
      (name) =>
        (name.startsWith(`${configName}.`) && name.endsWith(".tmp")) ||
        name.startsWith(`${lockName}-`) ||
        name.startsWith(`${lockName}.`),
    ),
    [],
  );
}

test("the first config write preserves active values in a complete commented template", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-template-"));
  const paths = pathsFor(root);
  await persistDefaultSelection(paths, { provider: "anthropic", model: "claude-sonnet" });
  const source = await readFile(paths.globalConfig, "utf8");
  const config = await readConfig(paths.globalConfig);
  assert.equal(config.defaultProvider, "anthropic");
  assert.equal(config.defaultModel, "claude-sonnet");
  assert.match(source, /Rigyn global configuration/u);
  for (const key of [
    "defaultProvider",
    "defaultModel",
    "theme",
    "thinking",
    "steeringMode",
    "followUpMode",
    "outboundImages",
    "scopedModels",
    "packageResources",
    "databasePath",
    "shellPath",
    "npmCommand",
    "gitCommand",
    "executionBackend",
    "httpTransport",
    "providerRetry",
    "contextTokenBudget",
    "summaryTokenBudget",
    "autoCompaction",
    "compactionRetainRecentTurns",
    "compactionToolResultBytes",
    "maxSteps",
    "childRuns",
    "providers",
    "models",
    "oauthRegistrations",
    "skillRoots",
    "extensionRoots",
    "doubleEscapeAction",
    "defaultProjectTrust",
  ]) assert.match(source, new RegExp(`// "${key}"`, "u"));
  for (const expected of [
    '"headersTimeoutMs": 300000',
    '"webSocketConnectTimeoutMs": 15000',
    '"baseUrl": "https://api.anthropic.com/v1"',
    '"baseUrl": "https://generativelanguage.googleapis.com/v1"',
    '"baseUrl": "https://api.mistral.ai/v1"',
    '"metadataSource": "maintained"',
  ]) assert.ok(source.includes(expected), `configuration template is missing ${expected}`);
  assert.match(source, /"defaultProvider": "anthropic"/u);
  assert.match(source, /"defaultModel": "claude-sonnet"/u);
  await assertNoWriteArtifacts(paths.globalConfig);
});

test("interactive model selection updates defaults without dropping existing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-default-selection-"));
  const paths = pathsFor(root);
  await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(paths.globalConfig, "{\n  // retained setting\n  \"isolation\": \"direct\",\n}\n");
  await persistDefaultSelection(paths, { provider: "openai", model: "gpt-5" });
  await persistDefaultSelection(paths, { provider: "anthropic", model: "claude-sonnet" });
  const config = await readConfig(paths.globalConfig);
  assert.equal(config.isolation, "direct");
  assert.equal(config.defaultProvider, "anthropic");
  assert.equal(config.defaultModel, "claude-sonnet");
  const source = await readFile(paths.globalConfig, "utf8");
  assert.match(source, /\/\/ retained setting/u);
  assert.doesNotMatch(source, /Rigyn global configuration/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(paths.globalConfig)).mode & 0o777, 0o600);
    assert.equal((await stat(`${paths.globalConfig}.lock.sqlite3`)).mode & 0o777, 0o600);
  }
  await assertNoWriteArtifacts(paths.globalConfig);
});

test("same-process preference updates are serialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-config-local-contention-"));
  const paths = pathsFor(root);
  let active = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      await updateGlobalConfig(
        paths.globalConfig,
        async (existing) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await delay(5);
          active -= 1;
          return { ...existing, [`local${index}`]: index };
        },
        { lockTimeoutMs: 5_000, retryDelayMs: 2 },
      );
    }),
  );
  assert.equal(maximum, 1);
  const config = await readConfig(paths.globalConfig);
  for (let index = 0; index < 12; index += 1) assert.equal(config[`local${index}`], index);
  await assertNoWriteArtifacts(paths.globalConfig);
});

test(
  "spawned Node processes preserve every simultaneous preference update",
  { timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "harness-config-process-contention-"));
    const paths = pathsFor(root);
    const gate = join(root, "start");
    const workers = Array.from({ length: 8 }, (_, index) => {
      const ready = join(root, `ready-${index}`);
      return {
        ready,
        worker: spawnWorker(updaterProgram, {
          CONFIG: paths.globalConfig,
          GATE: gate,
          KEY: `worker${index}`,
          READY: ready,
          VALUE: String(index),
        }),
      };
    });
    context.after(async () => {
      await Promise.all(workers.map(async ({ worker }) => await stopWorker(worker)));
    });
    await Promise.all(workers.map(async ({ ready }) => await waitForPath(ready)));
    await writeFile(gate, "start");
    const results = await Promise.all(workers.map(async ({ worker }) => await worker.closed));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null, result.stderr);
    }
    const config = await readConfig(paths.globalConfig);
    for (let index = 0; index < 8; index += 1) assert.equal(config[`worker${index}`], index);
    await assertNoWriteArtifacts(paths.globalConfig);
  },
);

const holderProgram = `
  import { writeFile } from "node:fs/promises";
  import { setTimeout as delay } from "node:timers/promises";
  const { updateGlobalConfig } = await import(${JSON.stringify(setupModule)});
  await updateGlobalConfig(process.env.CONFIG, async (existing) => {
    await writeFile(process.env.READY, "locked");
    await delay(Number(process.env.HOLD_MS));
    return { ...existing, holderCompleted: true };
  }, { lockTimeoutMs: 5_000, retryDelayMs: 5 });
`;

test(
  "a crashed owner is recovered while concurrent replacement processes remain serialized",
  { timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "harness-config-crash-recovery-"));
    const paths = pathsFor(root);
    const ready = join(root, "holder-ready");
    const holder = spawnWorker(holderProgram, {
      CONFIG: paths.globalConfig,
      HOLD_MS: "10000",
      READY: ready,
    });
    context.after(async () => await stopWorker(holder));
    await waitForPath(ready);
    holder.child.kill("SIGKILL");
    const crash = await holder.closed;
    assert.notEqual(crash.code, 0, crash.stderr);

    const gate = join(root, "recover-start");
    const replacements = Array.from({ length: 6 }, (_, index) => {
      const replacementReady = join(root, `recover-ready-${index}`);
      return {
        ready: replacementReady,
        worker: spawnWorker(updaterProgram, {
          CONFIG: paths.globalConfig,
          GATE: gate,
          KEY: `recovered${index}`,
          READY: replacementReady,
          VALUE: String(index),
        }),
      };
    });
    context.after(async () => {
      await Promise.all(replacements.map(async ({ worker }) => await stopWorker(worker)));
    });
    await Promise.all(replacements.map(async (replacement) => await waitForPath(replacement.ready)));
    await writeFile(gate, "start");
    const results = await Promise.all(
      replacements.map(async (replacement) => await replacement.worker.closed),
    );
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const config = await readConfig(paths.globalConfig);
    for (let index = 0; index < 6; index += 1) assert.equal(config[`recovered${index}`], index);
    await assertNoWriteArtifacts(paths.globalConfig);
  },
);

test("a live owner is never stolen and contenders time out", { timeout: 10_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-config-live-timeout-"));
  const paths = pathsFor(root);
  const ready = join(root, "holder-ready");
  const worker = spawnWorker(holderProgram, {
    CONFIG: paths.globalConfig,
    HOLD_MS: "10000",
    READY: ready,
  });
  context.after(async () => await stopWorker(worker));
  await waitForPath(ready);
  const started = performance.now();
  await assert.rejects(
    updateGlobalConfig(
      paths.globalConfig,
      (existing) => ({ ...existing, stolen: true }),
      { lockTimeoutMs: 150, retryDelayMs: 5 },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONFIG_LOCK_TIMEOUT" &&
      /Timed out/u.test(error.message),
  );
  const elapsed = performance.now() - started;
  assert.equal(elapsed >= 100, true);
  assert.equal(elapsed < 1_000, true);
  const timedOutConfig = await readConfig(paths.globalConfig).catch(
    (): Record<string, unknown> => ({}),
  );
  assert.equal(timedOutConfig.stolen, undefined);

  worker.child.kill("SIGKILL");
  await worker.closed;
  await persistUiPreferences(paths, { cleanedAfterTimeout: true });
  await assertNoWriteArtifacts(paths.globalConfig);
});

test("a retry cannot acquire after its deadline when the owner releases later", { timeout: 5_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-config-strict-timeout-"));
  const paths = pathsFor(root);
  const ready = join(root, "holder-ready");
  const worker = spawnWorker(holderProgram, {
    CONFIG: paths.globalConfig,
    HOLD_MS: "300",
    READY: ready,
  });
  context.after(async () => await stopWorker(worker));
  await waitForPath(ready);
  const started = performance.now();
  await assert.rejects(
    updateGlobalConfig(
      paths.globalConfig,
      (existing) => ({ ...existing, crossedDeadline: true }),
      { lockTimeoutMs: 80, retryDelayMs: 5 },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFIG_LOCK_TIMEOUT",
  );
  const elapsed = performance.now() - started;
  assert.equal(elapsed >= 60, true);
  assert.equal(elapsed < 250, true);
  const holderResult = await worker.closed;
  assert.equal(holderResult.code, 0, holderResult.stderr);
  const config = await readConfig(paths.globalConfig);
  assert.equal(config.holderCompleted, true);
  assert.equal(config.crossedDeadline, undefined);
  await assertNoWriteArtifacts(paths.globalConfig);
});

test("failed serialization preserves the previous file and cleans lock artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-config-failed-write-"));
  const paths = pathsFor(root);
  await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  const original = "{\n  \"retained\": true\n}\n";
  await writeFile(paths.globalConfig, original, { mode: 0o600 });
  await writeFile(
    `${paths.globalConfig}.00000000-0000-4000-8000-000000000000.tmp`,
    "stale partial write",
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    updateGlobalConfig(paths.globalConfig, () => circular as JsonObject),
    /circular/u,
  );
  assert.equal(await readFile(paths.globalConfig, "utf8"), original);
  await assertNoWriteArtifacts(paths.globalConfig);
});
