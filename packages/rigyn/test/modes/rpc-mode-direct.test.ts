import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function runFixture(
  command: object | readonly object[],
  environment: NodeJS.ProcessEnv = {},
  options: { imports?: readonly string[]; expectedCode?: number; timeoutMs?: number } = {},
): Promise<{ records: Record<string, unknown>[]; stderr: string }> {
  const fixture = fileURLToPath(new URL("../fixtures/rpc-mode-host.mts", import.meta.url));
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    ...(options.imports ?? []).flatMap((specifier) => ["--import", specifier]),
    fixture,
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RIGYN_OFFLINE: "1", ...environment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const commands = Array.isArray(command) ? command : [command];
  child.stdin.end(commands.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC fixture timed out: ${stderr}`));
    }, options.timeoutMs ?? 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: options.expectedCode ?? 0, signal: null });
  const records = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { records, stderr };
}

function dataImport(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

test("public RPC mode owns an existing runtime and serves strict JSONL until stdin closes", async () => {
  const { records } = await runFixture({ id: "state", type: "get_state" });
  assert.deepEqual(records, [{
    id: "state",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "rpc-fixture",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  }]);
});

test("public RPC mode redacts extension errors while preserving structured fields", async () => {
  const secret = "sk-proj-rpc-mode-redaction-1234567890";
  const { records, stderr } = await runFixture(
    { id: "state", type: "get_state" },
    { RIGYN_RPC_EXTENSION_ERROR_SECRET: secret },
  );
  assert.equal(stderr, "");
  const extensionError = records.find((record) => record.type === "extension_error");
  assert.ok(extensionError);
  assert.equal(extensionError.event, "input");
  assert.equal(String(extensionError.extensionPath).includes(secret), false);
  assert.equal(String(extensionError.error).includes(secret), false);
  assert.match(String(extensionError.extensionPath), /\[REDACTED\]/u);
  assert.match(String(extensionError.error), /\[REDACTED\]/u);
});

test("RPC response-size failures preserve the originating command and ID", async () => {
  const { records, stderr } = await runFixture(
    { id: "oversized-state", type: "get_state" },
    { RIGYN_RPC_OVERSIZE: "1" },
  );
  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: "oversized-state",
    type: "response",
    command: "get_state",
    success: false,
    error: "Failed to send response: RPC line exceeded 16777216 bytes",
  });
});

test("unexpected RPC handler failures preserve the originating command and ID", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const failingDispatcher = dataImport(`
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      throw new Error("unexpected dispatcher failure");
    };
  `);

  const { records, stderr } = await runFixture(
    { id: "failed-state", type: "get_state" },
    {},
    { imports: [failingDispatcher] },
  );

  assert.equal(stderr, "");
  assert.deepEqual(records, [{
    id: "failed-state",
    type: "response",
    command: "get_state",
    success: false,
    error: "unexpected dispatcher failure",
  }]);
});

test("public RPC mode correlates and bounds huge dispatcher failures", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const failingDispatcher = dataImport(`
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      throw new Error("sk-proj-rpc-public-bounded-1234567890-" + "x".repeat(17 * 1024 * 1024));
    };
  `);

  const { records, stderr } = await runFixture(
    { id: "huge-public-failure", type: "get_state" },
    {},
    { imports: [failingDispatcher] },
  );

  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "huge-public-failure");
  assert.equal(records[0]?.command, "get_state");
  assert.equal(records[0]?.success, false);
  const detail = String(records[0]?.error);
  assert.ok(Buffer.byteLength(detail, "utf8") <= 4_096);
  assert.match(detail, /\[REDACTED\]/u);
  assert.doesNotMatch(detail, /rpc-public-bounded/u);
});

test("public RPC mode backpressures at 64 concurrent command handlers", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const delayedDispatcher = dataImport(`
    import { writeSync } from "node:fs";
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
    let active = 0;
    let maximum = 0;
    RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return await dispatch.call(this, command);
      } finally {
        active -= 1;
      }
    };
    process.once("exit", () => writeSync(2, "maximum-active:" + maximum + "\\n"));
  `);
  const commands = Array.from({ length: 65 }, (_, index) => ({ id: String(index), type: "get_state" }));

  const { records, stderr } = await runFixture(commands, {}, { imports: [delayedDispatcher] });

  assert.equal(records.length, commands.length);
  assert.match(stderr, /maximum-active:64\n/u);
});

test("public RPC mode lets active commands finish after stdin closes", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const delayedDispatcher = dataImport(`
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      return nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args);
    };
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
    RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
      await new Promise((resolve) => nativeSetTimeout(resolve, 100));
      return await dispatch.call(this, command);
    };
  `);

  const { records } = await runFixture(
    { id: "slow-state", type: "get_state" },
    {},
    { imports: [delayedDispatcher] },
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]?.["id"], "slow-state");
  assert.equal(records[0]?.["success"], true);
});

test("RPC control responses bypass a saturated ordinary-command lane", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const extensionUi = new URL("../../src/interfaces/rpc-extension-ui.ts", import.meta.url).href;
  const blockedDispatcher = dataImport(`
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    const { RpcExtensionUiBridge } = await import(${JSON.stringify(extensionUi)});
    const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
      await gate;
      return await dispatch.call(this, command);
    };
    RpcExtensionUiBridge.prototype.handle = function() {
      release();
      return true;
    };
  `);
  const commands = [
    ...Array.from({ length: 64 }, (_, index) => ({ id: String(index), type: "get_state" })),
    { id: "release", type: "extension_ui_response", cancelled: true },
  ];

  const { records } = await runFixture(commands, {}, {
    imports: [blockedDispatcher],
    timeoutMs: 3_000,
  });

  assert.equal(records.length, 64);
  assert.equal(records.every((record) => record["success"] === true), true);
});

test("RPC priority commands have a bounded backlog", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const blockedDispatcher = dataImport(`
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      return nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args);
    };
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      await new Promise(() => undefined);
    };
  `);
  const commands = Array.from({ length: 1_025 }, (_, index) => ({
    id: String(index),
    type: "abort",
  }));

  const { records } = await runFixture(commands, {}, {
    imports: [blockedDispatcher],
    expectedCode: 1,
    timeoutMs: 3_000,
  });

  assert.deepEqual(records, [{
    id: "1024",
    type: "response",
    command: "abort",
    success: false,
    error: "RPC priority command backlog exceeded 1024",
  }]);
});

test("public RPC mode reports bounded stderr from an abnormal stdin relay exit", async () => {
  const replacement = `
    process.stderr.write("relay-diagnostic:" + "x".repeat(8_192) + ":tail");
    if (process.connected) process.disconnect();
    process.exitCode = 7;
  `;
  const replaceSpawn = dataImport(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(process.cwd() + "/rpc-mode-prepare.cjs");
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = (_command, _arguments, options) =>
      spawn(process.execPath, ["--eval", ${JSON.stringify(replacement)}], options);
    syncBuiltinESMExports();
  `);

  const { records, stderr } = await runFixture(
    { id: "ignored", type: "get_state" },
    {},
    { imports: [replaceSpawn], expectedCode: 1 },
  );

  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["command"], "parse");
  assert.equal(records[0]?.["success"], false);
  const error = String(records[0]?.["error"]);
  assert.match(error, /^RPC stdin relay failed with exit 7: relay-diagnostic:/u);
  assert.ok(error.length < 4_200, `relay diagnostic was not bounded: ${error.length}`);
  assert.doesNotMatch(error, /:tail/u);
});

test("public RPC mode reports a stdin relay spawn error", async () => {
  const replaceSpawn = dataImport(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(process.cwd() + "/rpc-mode-prepare.cjs");
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = (_command, _arguments, options) =>
      spawn(process.platform === "win32" ? "Z:\\\\missing-rigyn-relay.exe" : "/missing-rigyn-relay", [], options);
    syncBuiltinESMExports();
  `);

  const { records, stderr } = await runFixture(
    { id: "ignored", type: "get_state" },
    {},
    { imports: [replaceSpawn], expectedCode: 1 },
  );

  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["command"], "parse");
  assert.equal(records[0]?.["success"], false);
  assert.match(String(records[0]?.["error"]), /ENOENT/u);
});
