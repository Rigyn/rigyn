import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const mainModule = pathToFileURL(fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url))).href;
const agentSessionModule = pathToFileURL(fileURLToPath(new URL("../../src/service/agent-session.ts", import.meta.url))).href;
const cliModule = fileURLToPath(new URL("../../src/bin/rigyn.ts", import.meta.url));
const sessionManagerModule = pathToFileURL(
  fileURLToPath(new URL("../../src/storage/session-manager.ts", import.meta.url)),
).href;
const sessionV4Module = pathToFileURL(
  fileURLToPath(new URL("../../../kernel/src/session-v4/index.ts", import.meta.url)),
).href;

async function executeWithClosedStdin(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdin, ...spawnOptions } = options;
  const child = spawn(file, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(stdin);
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeout);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Command exited with ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
  return { stdout, stderr };
}

test("human CLI warnings redact credentials and escape terminal controls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-warning-output-"));
  const entrypoint = join(root, "entrypoint.mjs");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const secret = "sk-proj-1234567890abcdefghijkl";
  const invalidThinking = `${secret}\x1b[31m`;
  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
await main(${JSON.stringify(["--thinking", invalidThinking, "--version"])});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: process.env,
    timeout: 30_000,
  });
  assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
  assert.doesNotMatch(result.stderr, /\x1b/u);
  assert.match(result.stderr, /Invalid thinking level "\[REDACTED\]\\x1b\[31m"/u);
});

test("compatible leading flags preserve management-command dispatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-leading-management-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
for (const invocation of ${JSON.stringify([
    ["--offline", "config", "path"],
    ["--approve", "config", "path"],
    ["--no-approve", "config", "path"],
    ["--offline", "config", "--", "path"],
    ["--json", "sessions", "doctor"],
  ])}) await main(invocation);
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, RIGYN_HOME: agentDir, RIGYN_OFFLINE: "1" },
    timeout: 30_000,
  });
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(0, 4), Array(4).fill(join(agentDir, "config.json")));
  assert.equal((JSON.parse(lines.slice(4).join("\n")) as { healthy?: boolean }).healthy, true);
});

test("invalid leading management flags fail before agent state is created", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-invalid-leading-management-"));
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
const errors = [];
for (const invocation of ${JSON.stringify([
    ["--local", "sessions", "doctor"],
    ["--yes", "config", "path"],
    ["--offline", "--offline", "config", "path"],
  ])}) {
  try {
    await main(invocation);
    errors.push("accepted");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}
process.stdout.write(JSON.stringify(errors));
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, RIGYN_HOME: agentDir, RIGYN_OFFLINE: "1" },
    timeout: 30_000,
  });
  assert.equal(result.stderr, "");
  const errors = JSON.parse(result.stdout) as string[];
  assert.match(errors[0]!, /--local is not valid for sessions/u);
  assert.match(errors[1]!, /--yes is not valid for config/u);
  assert.match(errors[2]!, /Flag --offline was provided more than once/u);
  await assert.rejects(access(agentDir), { code: "ENOENT" });
});

test("text mode merges piped input, file arguments, and only the first prompt before file expansion", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-prompt-composition-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await mkdir(workspace);
  await writeFile(join(workspace, "context.txt"), "file body", "utf8");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "text",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-compose",
  "--model", "inline-model",
  "@context.txt",
  "first prompt",
  "second prompt",
], {
  extensionFactories: [{
    name: "inline-prompt-composition",
    factory(rigyn) {
      rigyn.registerProvider("inline-compose", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      rigyn.on("input", (event) => {
        appendFileSync(${JSON.stringify(observed)}, JSON.stringify(event.text) + "\\n");
        return { action: "handled" };
      });
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
    stdin: "stdin text",
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
  const inputs = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
  assert.deepEqual(inputs, [
    "stdin text\n@context.txt\nfirst prompt\n\n<file path=\"context.txt\">\nfile body\n</file>",
    "second prompt",
  ]);
});

test("an explicit text mode remains one-shot when both streams are TTYs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-explicit-text-mode-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "mode.txt");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
await main([
  "--mode", "text",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-text-mode",
  "--model", "inline-model",
  "hello",
], {
  extensionFactories: [{
    name: "inline-text-mode",
    factory(rigyn) {
      rigyn.registerProvider("inline-text-mode", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      rigyn.on("session_start", (_event, extensionContext) => {
        writeFileSync(${JSON.stringify(observed)}, extensionContext.mode);
      });
      rigyn.on("input", () => ({ action: "handled" }));
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(await readFile(observed, "utf8"), "print");
});

test("interactive CLI executes slash commands before an active prompt settles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-active-slash-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
let releasePrompt;
let released = false;
let active = false;
let suspended;
const promptGate = new Promise((resolve) => { releasePrompt = resolve; });
let fallback;
const release = (source) => {
  if (released) return;
  released = true;
  clearTimeout(fallback);
  record("release:" + source);
  releasePrompt();
};

AgentSession.prototype.prompt = async function(text, options) {
  if (text === "/active-resource now") {
    record("resource:" + options.streamingBehavior);
    setImmediate(() => process.stdin.emit("data", Buffer.from("/follow next step\\r")));
    return;
  }
  active = true;
  suspended = {
    operationId: "active-slash-operation",
    acceptedAt: "2026-08-11T00:00:00.000Z",
    cancelled: false,
    attempts: 1,
    claimedQueueIds: [],
    effects: [{
      effectId: "active-slash-effect",
      callId: "active-slash-call",
      name: "bash",
      policy: "never_repeat",
      status: "dispatched",
      step: 0,
      index: 0,
      inputHash: "active-slash-input",
    }],
  };
  record("prompt:" + text);
  setImmediate(() => process.stdin.emit("data", Buffer.from("/active-resource now\\r")));
  fallback = setTimeout(() => release("timeout"), 750);
  await promptGate;
  record("prompt:settled");
};
Object.defineProperty(AgentSession.prototype, "isStreaming", {
  configurable: true,
  get() { return active; },
});
Object.defineProperty(AgentSession.prototype, "isIdle", {
  configurable: true,
  get() { return !active && suspended === undefined; },
});
Object.defineProperty(AgentSession.prototype, "suspendedRun", {
  configurable: true,
  get() { return suspended; },
});
AgentSession.prototype.followUp = async function(text) {
  record("follow:" + text);
  setImmediate(() => process.stdin.emit("data", Buffer.from("/help\\r")));
};
AgentSession.prototype.abort = async function(reason) {
  if (String(reason).includes("/new requested")) {
    record("abort:" + reason);
    active = false;
    suspended = { ...suspended, cancelled: true };
    release("new");
  }
};
AgentSession.prototype.recoverInterruptedRun = async function(options = {}) {
  record("recover:" + JSON.stringify(options.resolutions ?? []));
  if ((options.resolutions?.length ?? 0) === 0) {
    return {
      recovered: false,
      operationId: suspended?.operationId,
      blocked: [{
        effectId: "active-slash-effect",
        name: "bash",
        reason: "This tool cannot be repeated safely.",
      }],
    };
  }
  const operationId = suspended.operationId;
  suspended = undefined;
  return { recovered: true, operationId, blocked: [] };
};

const originalNotify = TuiController.prototype.notify;
TuiController.prototype.notify = function(message, kind) {
  if (String(message).startsWith("Interactive commands:")) {
    record("help");
    setImmediate(() => process.stdin.emit("data", Buffer.from("/new\\r")));
  }
  if (String(message) === "Started a new session") {
    record("new");
    setTimeout(() => process.stdin.emit("data", Buffer.from("/quit\\r")), 250);
  }
  return originalNotify.call(this, message, kind);
};
let started = false;
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  if (started) return;
  started = true;
  setImmediate(() => process.stdin.emit("data", Buffer.from("hold\\r")));
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "active-command-provider",
  "--model", "active-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "active-command-provider-fixture",
    factory(rigyn) {
      rigyn.registerProvider("active-command-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "active-model",
          name: "Active Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      rigyn.registerCommand("active-resource", {
        handler() { return { prompt: "resource prompt" }; },
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Active slash fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Active slash fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
  for (const expected of [
    "prompt:hold",
    "resource:followUp",
    "follow:next step",
    "help",
    "abort:/new requested",
    "release:new",
    'recover:[{"effectId":"active-slash-effect","outcome":"abandoned"}]',
    "new",
  ]) assert.notEqual(records.indexOf(expected), -1, expected);
  assert.ok(records.indexOf("resource:followUp") < records.indexOf("prompt:settled"));
  assert.ok(records.indexOf("help") < records.indexOf("prompt:settled"));
  assert.ok(records.indexOf("abort:/new requested") < records.indexOf('recover:[{"effectId":"active-slash-effect","outcome":"abandoned"}]'));
  assert.ok(records.indexOf('recover:[{"effectId":"active-slash-effect","outcome":"abandoned"}]') < records.indexOf("new"));
  assert.equal(stderr, "");
});

test("installed interactive CLI executes an active extension handler and follows its prompt once", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-active-extension-handler-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
const messageText = (message) => typeof message.content === "string"
  ? message.content
  : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
let releaseFirst;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
let requests = 0;
let started = false;
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  if (started) return;
  started = true;
  setImmediate(() => process.stdin.emit("data", Buffer.from("hold\\r")));
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "active-handler-provider",
  "--model", "active-handler-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "active-handler-fixture",
    factory(rigyn) {
      rigyn.registerProvider("active-handler-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "active-handler-model",
          name: "Active handler model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* (model, context) {
          requests += 1;
          const latest = context.messages.filter((message) => message.role === "user").map(messageText).at(-1);
          record("provider:start:" + latest);
          yield { type: "response_start", model: model.id };
          if (requests === 1) {
            setImmediate(() => process.stdin.emit("data", Buffer.from("/active-resource now\\r")));
            await firstGate;
          }
          yield { type: "text_delta", part: 0, text: "answer-" + requests };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
          record("provider:end:" + latest);
          if (requests === 2) setTimeout(() => process.stdin.emit("data", Buffer.from("/quit\\r")), 20);
        },
      });
      rigyn.registerCommand("active-resource", {
        handler(args) {
          record("handler:" + args);
          setImmediate(releaseFirst);
          return { prompt: "returned prompt " + args };
        },
      });
      rigyn.on("input", (event) => {
        record("input:" + event.text);
        return { action: "continue" };
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Active extension fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Active extension fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
  assert.equal(records.filter((entry) => entry === "handler:now").length, 1);
  assert.equal(records.filter((entry) => entry === "input:returned prompt now").length, 1);
  assert.equal(records.filter((entry) => entry === "provider:start:returned prompt now").length, 1);
  assert.ok(records.indexOf("handler:now") < records.indexOf("provider:end:hold"));
  assert.ok(records.indexOf("provider:end:hold") < records.indexOf("provider:start:returned prompt now"));
  assert.equal(stderr, "");
});

test("interactive CLI cancellation prevents a prompt from starting after reference preparation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-cancel-prompt-preparation-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(workspace, "slow.txt"), "prepared input", "utf8");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  const pathsModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tools/paths.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};
import { WorkspaceBoundary } from ${JSON.stringify(pathsModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
let releasePreparation;
const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const readableFile = WorkspaceBoundary.prototype.readableFile;
WorkspaceBoundary.prototype.readableFile = async function(path) {
  if (path === "slow.txt") {
    record("prepare:started");
    setImmediate(() => process.stdin.emit("data", Buffer.from("/cancel\\r")));
    await preparationGate;
    record("prepare:released");
  }
  return await readableFile.call(this, path);
};

AgentSession.prototype.prompt = async function(text) {
  record("prompt:" + text);
};
const abort = AgentSession.prototype.abort;
AgentSession.prototype.abort = async function(reason) {
  if (reason === "Cancelled by user") {
    record("abort:" + reason);
    releasePreparation();
    setTimeout(() => process.stdin.emit("data", Buffer.from("/quit\\r")), 100);
  }
  return await abort.call(this, reason);
};

let started = false;
const setStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  setStartup.apply(this, args);
  if (started) return;
  started = true;
  setImmediate(() => process.stdin.emit("data", Buffer.from('@"slow.txt"\\r')));
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "cancel-preparation-provider",
  "--model", "cancel-preparation-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "cancel-preparation-provider-fixture",
    factory(rigyn) {
      rigyn.registerProvider("cancel-preparation-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "cancel-preparation-model",
          name: "Cancel Preparation Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Prompt preparation fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Prompt preparation fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
  assert.deepEqual(records.slice(0, 3), [
    "prepare:started",
    "abort:Cancelled by user",
    "prepare:released",
  ]);
  assert.doesNotMatch(records.join("\n"), /^prompt:/mu);
  assert.equal(stderr, "");
});

test("interactive CLI owns login cancellation alongside the active prompt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-active-login-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
let steer;
const setSteering = TuiController.prototype.setSteering;
TuiController.prototype.setSteering = function(handler) {
  if (handler !== undefined) steer = handler;
  return setSteering.call(this, handler);
};
let releasePrompt;
const promptGate = new Promise((resolve) => { releasePrompt = resolve; });
AgentSession.prototype.prompt = async function(text) {
  record("prompt:" + text);
  setImmediate(() => {
    steer?.("/login active-login-provider");
  });
  await promptGate;
  record("prompt:settled");
};
const abort = AgentSession.prototype.abort;
AgentSession.prototype.abort = async function(reason) {
  if (reason === "Cancelled by user") {
    record("prompt:aborted");
    releasePrompt();
  }
  return await abort.call(this, reason);
};

const notify = TuiController.prototype.notify;
let quitting = false;
const requestQuit = () => { if (quitting) steer?.("/quit"); };
TuiController.prototype.notify = function(message, kind) {
  if (String(message).startsWith("Another command is active")) {
    record("command:busy");
    if (quitting) setTimeout(requestQuit, 50);
  }
  return notify.call(this, message, kind);
};
const choose = TuiController.prototype.choose;
TuiController.prototype.choose = async function(title, options, signal) {
  if (String(title).startsWith("Connect ")) {
    return options.find((option) => option.label === "Use a subscription or provider account").value;
  }
  return await choose.call(this, title, options, signal);
};
let started = false;
const setStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  setStartup.apply(this, args);
  if (started) return;
  started = true;
  setImmediate(() => process.stdin.emit("data", Buffer.from("hold\\r")));
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "active-login-provider",
  "--model", "active-login-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "active-login-provider-fixture",
    factory(rigyn) {
      rigyn.registerProvider("active-login-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "active-login-model",
          name: "Active Login Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        oauth: {
          name: "Active login",
          async login(interaction) {
            record("login:started");
            setImmediate(() => {
              record("second-command:sent");
              steer?.("/session");
            });
            setTimeout(() => steer?.("/cancel"), 50);
            return await new Promise((resolve, reject) => {
              const fallback = setTimeout(() => {
                record("login:fallback");
                resolve({ access: "fallback-access", expires: Date.now() + 60_000 });
              }, 500);
              const cancelled = () => {
                clearTimeout(fallback);
                record("login:aborted");
                quitting = true;
                setTimeout(requestQuit, 50);
                reject(interaction.signal?.reason);
              };
              if (interaction.signal?.aborted === true) cancelled();
              else interaction.signal?.addEventListener("abort", cancelled, { once: true });
            });
          },
          async refreshToken(credential) { return credential; },
          getApiKey(credential) { return credential.access; },
        },
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Active login fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Active login fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
  assert.ok(records.includes("command:busy"), `second command was not rejected immediately: ${records.join(", ")}`);
  assert.ok(records.includes("login:aborted"), `login was not cancelled: ${records.join(", ")}`);
  assert.ok(records.includes("prompt:aborted"), `active prompt was not cancelled: ${records.join(", ")}`);
  assert.ok(!records.includes("login:fallback"), `login outlived cancellation: ${records.join(", ")}`);
  assert.equal(stderr, "");
});

test("interactive CLI preserves scoped model order and thinking in cached and edited cycle lists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-scoped-cycle-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    enabledModels: [
      "cycle-provider/gamma:low",
      "cycle-provider/beta:high",
      "cycle-provider/alpha:medium",
    ],
  })}\n`);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

let lastCycle = [];
let startedScopeEdit = false;
const record = (kind, value) => appendFileSync(
  ${JSON.stringify(observed)},
  JSON.stringify({ kind, value }) + "\\n",
);
const originalSetModelCycleItems = TuiController.prototype.setModelCycleItems;
TuiController.prototype.setModelCycleItems = function(items) {
  lastCycle = (items ?? []).map((item) => item.value);
  originalSetModelCycleItems.call(this, items);
  if (!startedScopeEdit && lastCycle.length > 0) {
    startedScopeEdit = true;
    record("cached", lastCycle);
  }
};
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  setImmediate(() => process.stdin.emit("data", Buffer.from("/scoped-models\\r")));
};
TuiController.prototype.chooseScopedModels = async function(_items, options) {
  const selection = {
    mode: "models",
    patterns: [
      "cycle-provider/beta:high",
      "cycle-provider/alpha:medium",
      "cycle-provider/gamma:low",
    ],
  };
  options.onChange?.(selection);
  record("preview", lastCycle);
  await options.onSave?.(selection);
  record("saved", lastCycle);
  setImmediate(() => process.stdin.emit("data", Buffer.from("/quit\\r")));
  return selection;
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "cycle-provider",
  "--model", "gamma",
  "--thinking", "low",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "cycle-provider-fixture",
    factory(rigyn) {
      rigyn.registerProvider("cycle-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: ["alpha", "beta", "gamma"].map((id) => ({
          id,
          name: id,
          reasoning: true,
          thinkingLevelMap: { max: null },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        })),
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Command exited with ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records, [
    {
      kind: "cached",
      value: [
        { provider: "cycle-provider", model: "gamma", reasoningEffort: "low" },
        { provider: "cycle-provider", model: "beta", reasoningEffort: "high" },
        { provider: "cycle-provider", model: "alpha", reasoningEffort: "medium" },
      ],
    },
    {
      kind: "preview",
      value: [
        { provider: "cycle-provider", model: "beta", reasoningEffort: "high" },
        { provider: "cycle-provider", model: "alpha", reasoningEffort: "medium" },
        { provider: "cycle-provider", model: "gamma", reasoningEffort: "low" },
      ],
    },
    {
      kind: "saved",
      value: [
        { provider: "cycle-provider", model: "beta", reasoningEffort: "high" },
        { provider: "cycle-provider", model: "alpha", reasoningEffort: "medium" },
        { provider: "cycle-provider", model: "gamma", reasoningEffort: "low" },
      ],
    },
  ]);
});

test("interactive CLI keeps the latest overlapping model selection and its thinking level", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-latest-model-selection-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.json");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    enabledModels: ["selection-provider/first:low", "selection-provider/second:high"],
    keybindings: { "app.model.cycleBackward": "alt+b" },
  })}\n`);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

let releaseFirst;
const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
const originalResolveModel = AgentSession.prototype.resolveModel;
AgentSession.prototype.resolveModel = async function(reference, options) {
  if (reference.includes("first")) await firstRelease;
  return await originalResolveModel.call(this, reference, options);
};
const selected = [];
const originalSetModel = AgentSession.prototype.setModel;
AgentSession.prototype.setModel = async function(model, source) {
  const result = await originalSetModel.call(this, model, source);
  const id = this.model?.id;
  if (id === "first" || id === "second") {
    selected.push(id);
    if (id === "second") {
      releaseFirst();
      setTimeout(() => {
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
        model: this.model?.id,
        thinkingLevel: this.thinkingLevel,
        selected,
      }));
      process.stdin.emit("data", Buffer.from("/quit\\r"));
      }, 100);
    }
  }
  return result;
};

let startedSelection = false;
const originalSetModelCycleItems = TuiController.prototype.setModelCycleItems;
TuiController.prototype.setModelCycleItems = function(items) {
  originalSetModelCycleItems.call(this, items);
  if (!startedSelection && items?.some((item) => item.value?.model === "first")) {
    startedSelection = true;
    setTimeout(() => process.stdin.emit("data", Buffer.from([16])), 20);
  }
};
const originalResolve = AgentSession.prototype.resolveModel;
AgentSession.prototype.resolveModel = async function(reference, options) {
  if (reference.includes("first")) {
    setImmediate(() => process.stdin.emit("data", Buffer.from("\\u001bb")));
  }
  return await originalResolve.call(this, reference, options);
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "selection-provider",
  "--model", "outside",
  "--thinking", "medium",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "selection-provider-fixture",
    factory(rigyn) {
      rigyn.registerProvider("selection-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: ["outside", "first", "second"].map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        })),
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Latest model selection fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Latest model selection fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), {
    model: "second",
    thinkingLevel: "high",
    selected: ["second"],
  });
  assert.equal(stderr, "");
});

test("installed RPC model cycling uses the configured ordered scope and thinking", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-rpc-model-cycle-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    enabledModels: ["cycle-provider/second:high", "cycle-provider/first:low"],
  })}\n`);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "cycle-provider",
  "--model", "outside",
  "--thinking", "medium",
], {
  extensionFactories: [{
    name: "rpc-cycle-provider-fixture",
    factory(rigyn) {
      rigyn.registerProvider("cycle-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: ["outside", "first", "second"].map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        })),
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, RIGYN_HOME: agentDir, RIGYN_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  let pendingStdout = "";
  let resolveResponse!: (response: {
    id?: string;
    type?: string;
    command?: string;
    data?: { model?: { id?: string }; thinkingLevel?: string; isScoped?: boolean };
  }) => void;
  let rejectResponse!: (error: Error) => void;
  const responsePromise = new Promise<{
    id?: string;
    type?: string;
    command?: string;
    data?: { model?: { id?: string }; thinkingLevel?: string; isScoped?: boolean };
  }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    pendingStdout += chunk;
    while (true) {
      const newline = pendingStdout.indexOf("\n");
      if (newline < 0) break;
      const line = pendingStdout.slice(0, newline).replace(/\r$/u, "");
      pendingStdout = pendingStdout.slice(newline + 1);
      try {
        const response = JSON.parse(line) as {
          id?: string;
          type?: string;
          command?: string;
          data?: { model?: { id?: string }; thinkingLevel?: string; isScoped?: boolean };
        };
        if (response.id === "cycle" && response.type === "response" && response.command === "cycle_model") {
          resolveResponse(response);
        }
      } catch (error) {
        rejectResponse(new Error(`RPC cycle fixture emitted invalid JSON ${JSON.stringify(line)}`, { cause: error }));
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const terminalPromise = new Promise<
    { type: "error"; error: Error } | { type: "close"; code: number | null; signal: NodeJS.Signals | null }
  >((resolveTerminal) => {
    child.once("error", (error) => resolveTerminal({ type: "error", error }));
    child.once("close", (code, signal) => resolveTerminal({ type: "close", code, signal }));
  });
  let timeoutHandle!: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        `RPC cycle fixture timed out\nstdout:\n${stdout}${pendingStdout === "" ? "" : `\nincomplete stdout:\n${pendingStdout}`}\nstderr:\n${stderr}`,
      ));
    }, 30_000);
  });
  child.stdin.once("error", (error) => {
    rejectResponse(new Error(`RPC cycle fixture stdin failed\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error }));
  });
  let response;
  try {
    child.stdin.write(`${JSON.stringify({ id: "cycle", type: "cycle_model" })}\n`);
    response = await Promise.race([
      responsePromise,
      terminalPromise.then((terminal): never => {
        if (terminal.type === "error") throw terminal.error;
        throw new Error(
          `RPC cycle fixture closed before its response with ${terminal.code ?? terminal.signal}\n`
          + `stdout:\n${stdout}${pendingStdout === "" ? "" : `\nincomplete stdout:\n${pendingStdout}`}\nstderr:\n${stderr}`,
        );
      }),
      timeoutPromise,
    ]);
    child.stdin.end();
    const terminal = await Promise.race([terminalPromise, timeoutPromise]);
    if (terminal.type === "error") throw terminal.error;
    if (terminal.code !== 0) {
      throw new Error(`RPC cycle fixture exited with ${terminal.code ?? terminal.signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
  assert.deepEqual(response?.data, {
    model: {
      id: "second",
      name: "second",
      api: "openai-responses",
      provider: "cycle-provider",
      baseUrl: "https://example.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 1000,
    },
    thinkingLevel: "high",
    isScoped: true,
  });
  assert.equal(stderr, "");
});

test("headless startup clamps inherited thinking, applies model suffixes, and honors explicit thinking", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-thinking-clamp-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.txt");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    defaultThinkingLevel: "max",
  })}\n`);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--print",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-thinking",
  "--model", process.env.RIGYN_TEST_MODEL ?? "xhigh-only",
  ...(process.env.RIGYN_TEST_THINKING === undefined
    ? []
    : ["--thinking", process.env.RIGYN_TEST_THINKING]),
  "hello",
], {
  extensionFactories: [{
    name: "inline-thinking-provider",
    factory(rigyn) {
      rigyn.registerProvider("inline-thinking", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "xhigh-only",
          name: "Xhigh-only model",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }, {
          id: "max-and-xhigh",
          name: "Max and xhigh model",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: "xhigh",
            max: "max",
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* (model, _context, options) {
          writeFileSync(${JSON.stringify(observed)}, String(options?.reasoning));
          yield { type: "response_start", model: model.id };
          yield { type: "text_delta", part: 0, text: "clamped" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "clamped\n");
  assert.equal(await readFile(observed, "utf8"), "xhigh");

  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    defaultThinkingLevel: "max",
  })}\n`);
  const inline = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      RIGYN_TEST_MODEL: "max-and-xhigh:xhigh",
    },
    timeout: 30_000,
  });
  assert.equal(inline.stderr, "");
  assert.equal(inline.stdout, "clamped\n");
  assert.equal(await readFile(observed, "utf8"), "xhigh");

  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    defaultThinkingLevel: "max",
  })}\n`);
  const explicit = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
      RIGYN_TEST_MODEL: "max-and-xhigh:xhigh",
      RIGYN_TEST_THINKING: "max",
    },
    timeout: 30_000,
  });
  assert.equal(explicit.stderr, "");
  assert.equal(explicit.stdout, "clamped\n");
  assert.equal(await readFile(observed, "utf8"), "max");
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function replacementFactory(marker: string): string {
  return `{
    name: "inline-owner-replacement",
    factory(rigyn) {
      rigyn.registerProvider("inline-owner", {
        name: "Inline Owner",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      rigyn.on("session_start", (event) => {
        appendFileSync(${JSON.stringify(marker)}, \`start:\${event.reason}\\n\`);
      });
      rigyn.registerCommand("replace-runtime", {
        async handler(_args, context) {
          const result = await context.newSession({
            async withSession(replacement) {
              await replacement.sendMessage({
                customType: "owner-replacement",
                content: "replacement ready",
                display: true,
              });
            },
          });
          if (result.cancelled) throw new Error("runtime replacement was cancelled");
        },
      });
    },
  }`;
}

test("main activates supplied extension factories and exposes their models to the invocation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-inline-extension-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--list-models", "inline-main",
], {
  extensionFactories: [{
    name: "inline-main-factory",
    factory(rigyn) {
      rigyn.registerProvider("inline-main", {
        name: "Inline Main",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /^inline-main\/inline-model\t/u);
  assert.equal(result.stderr, "");
});

test("extension inspection commands include supplied extension factories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-inline-inspection-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "extensions", "commands",
  "--json",
  "--workspace", ${JSON.stringify(workspace)},
], {
  extensionFactories: [{
    name: "inline-inspection-factory",
    factory(rigyn) {
      rigyn.registerCommand("inline-inspection", {
        description: "Inline command",
        async handler() {},
      });
    },
  }],
});
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  const report = JSON.parse(result.stdout) as { runtime: Array<{ name: string }> };
  assert.deepEqual(report.runtime.map((entry) => entry.name), ["inline-inspection"]);
  assert.equal(result.stderr, "");
});

test("RPC mode retains supplied factories in its session runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-inline-rpc-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const trustMarker = join(root, "rpc-trust.txt");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await writeFile(join(workspace, ".rigyn", "config.json"), "{}\n");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "inline-rpc-factory",
    factory(rigyn) {
      rigyn.on("project_trust", () => {
        appendFileSync(${JSON.stringify(trustMarker)}, "1");
        return { trusted: "yes" };
      });
      rigyn.registerCommand("inline-rpc", {
        description: "Inline RPC command",
        async handler() {},
      });
    },
  }],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC factory fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const responses = stdout.trim().split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; }
    catch { return []; }
  });
  const response = responses.find((entry) => entry.id === "commands") as {
    success?: boolean;
    data?: { commands?: Array<{ name: string }> };
  } | undefined;
  assert.equal(response?.success, true, stdout);
  assert.equal(response?.data?.commands?.some((entry) => entry.name === "inline-rpc"), true, stdout);
  assert.equal(await readFile(trustMarker, "utf8"), "1");
});

test("installed RPC mode rebinds extension commands through the session runtime owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-rpc-owner-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "session-starts.txt");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-owner",
  "--model", "inline-model",
], {
  extensionFactories: [${replacementFactory(marker)}],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: "replace", type: "prompt", message: "/replace-runtime" })}\n`);

  await waitFor(async () => {
    const starts = await readFile(marker, "utf8").catch(() => "");
    return starts.trim().split("\n").filter(Boolean).length >= 2
      && stdout.split("\n").some((line) => {
        try {
          const record = JSON.parse(line) as { id?: string; success?: boolean };
          return record.id === "replace" && record.success === true;
        } catch {
          return false;
        }
      });
  }, "RPC extension-owned session replacement");
  child.stdin.end();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC owner fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
    "start:startup",
    "start:new",
  ]);
});

test("installed text and JSON modes rebind extension commands through the session runtime owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-print-owner-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  for (const mode of ["text", "json"] as const) {
    const workspace = join(root, `workspace-${mode}`);
    const agentDir = join(root, `agent-${mode}`);
    const entrypoint = join(root, `entrypoint-${mode}.mjs`);
    const marker = join(root, `session-starts-${mode}.txt`);
    await mkdir(workspace);
    const modeArguments = mode === "text" ? ["--print"] : ["--mode", "json"];
    await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  ...${JSON.stringify(modeArguments)},
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-owner",
  "--model", "inline-model",
  "/replace-runtime",
], {
  extensionFactories: [${replacementFactory(marker)}],
});
`);
    const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        RIGYN_HOME: agentDir,
        RIGYN_OFFLINE: "1",
      },
      timeout: 30_000,
    });
    assert.equal(result.stderr, "", `${mode}: ${result.stderr}`);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
      "start:startup",
      "start:new",
    ]);
    if (mode === "json") {
      const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
        type?: string;
        entry?: { customType?: string };
      });
      assert.equal(records[0]?.type, "session");
      assert.equal(
        records.some((record) =>
          record.type === "entry_appended" && record.entry?.customType === "owner-replacement"),
        true,
      );
    } else assert.equal(result.stdout, "");
  }
});

test("installed JSON mode emits the public session event contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-json-events-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "json",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-json",
  "--model", "inline-model",
  "hello",
], {
  extensionFactories: [{
    name: "inline-json-provider",
    factory(rigyn) {
      rigyn.registerProvider("inline-json", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* () {
          yield { type: "response_start", model: "inline-model" };
          yield { type: "text_delta", part: 0, text: "hello back" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
    },
  }],
});
`);

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  assert.equal(result.stderr, "");
  const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type?: string });
  const types = records.map((entry) => entry.type);
  assert.equal(types[0], "session");
  for (const expected of ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end", "agent_settled"]) {
    assert.equal(types.includes(expected), true, `missing ${expected}: ${types.join(", ")}`);
  }
  assert.equal(types.includes("run_started"), false);
  assert.equal(types.includes("message_appended"), false);
});

test("installed JSON mode keeps metadata and provider-failure stdout structured", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-json-provider-failure-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const extension = join(root, "provider.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(extension, `
export default function activate(rigyn) {
  console.log("extension startup notice");
  rigyn.registerProvider("json-failure", {
    api: "openai-responses",
    apiKey: "fixture-key",
    baseUrl: "https://example.invalid/v1",
    models: [{
      id: "inline-model",
      name: "Inline Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 1000,
    }],
    streamSimple: async function* () {
      yield { type: "response_start", model: "inline-model" };
      throw new Error("provider failure sentinel");
    },
  });
}
`);

  const listing = await executeWithClosedStdin(process.execPath, [
    "--import", "tsx", cliModule,
    "--mode", "json",
    "--workspace", workspace,
    "--offline",
    "--approve",
    "--extension", extension,
    "--list-models", "json-failure",
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  const listingLines = listing.stdout.trim().split("\n");
  assert.equal(listingLines.length, 1, listing.stdout);
  const listed = JSON.parse(listingLines[0]!) as Array<{ provider?: string; id?: string }>;
  assert.equal(listed.some((model) => model.provider === "json-failure" && model.id === "inline-model"), true);
  assert.match(listing.stderr, /extension startup notice/u);

  const child = spawn(process.execPath, [
    "--import", "tsx", cliModule,
    "--mode", "json",
    "--workspace", workspace,
    "--offline",
    "--no-session",
    "--approve",
    "--extension", extension,
    "--provider", "json-failure",
    "--model", "inline-model",
    "hello",
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`JSON failure fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 1, signal: null }, `${stdout}\n${stderr}`);
  const records = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
    type?: string;
    message?: { stopReason?: string; errorMessage?: string };
  });
  assert.equal(records.some((entry) =>
    entry.type === "message_end"
    && entry.message?.stopReason === "error"
    && entry.message.errorMessage === "provider failure sentinel"), true, stdout);
  assert.match(stderr, /extension startup notice/u);
  assert.doesNotMatch(stderr, /provider failure sentinel/u);
});

test("one-shot mode recovers accepted work before applying its requested model", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-recovery-order-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
import { SessionManager } from ${JSON.stringify(sessionManagerModule)};
import { sessionV4JsonHash } from ${JSON.stringify(sessionV4Module)};

const manager = SessionManager.create(${JSON.stringify(workspace)}, ${JSON.stringify(sessionDirectory)}, {
  id: "recovery-order",
});
manager.appendModelChange("inline-recovery", "inline-model");
manager.commitChanges([{
  type: "run_accepted",
  branchId: "main",
  operationId: "interrupted-operation",
  promptNodeId: "interrupted-prompt",
  sourceHeadId: manager.getLeafId(),
  acceptedAt: "2026-07-29T12:00:00.000Z",
  request: { prompt: "interrupted prompt" },
  selection: {
    provider: "inline-recovery",
    model: "inline-model",
    api: "openai-responses",
    thinkingLevel: "off",
    toolNames: [],
    toolsetFingerprint: sessionV4JsonHash([]),
  },
}]);
const sessionFile = manager.getSessionFile();
manager.closeV4Store();
if (sessionFile === undefined) throw new Error("persistent fixture did not create a session file");

await main([
  "--print",
  "--workspace", ${JSON.stringify(workspace)},
  "--session-dir", ${JSON.stringify(sessionDirectory)},
  "--session", sessionFile,
  "--offline",
  "--no-extensions",
  "--no-tools",
  "--approve",
  "--provider", "inline-recovery",
  "--model", "inline-model",
  "new prompt",
], {
  extensionFactories: [{
    name: "inline-recovery-provider",
    factory(rigyn) {
      rigyn.registerProvider("inline-recovery", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* () {
          yield { type: "response_start", model: "inline-model" };
          yield { type: "text_delta", part: 0, text: "recovered then answered" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
    },
  }],
});
`);

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "recovered then answered\n");
});

test("interactive startup, resume, and installed RPC keep explicit never-repeat recovery reachable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-interactive-recovery-order-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { SessionManager } from ${JSON.stringify(sessionManagerModule)};
import { sessionV4JsonHash, sessionV4ToolInputHash } from ${JSON.stringify(sessionV4Module)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const scenario = process.argv[2];
if (scenario !== "startup" && scenario !== "resume" && scenario !== "rpc") {
  throw new Error("invalid recovery scenario");
}
const record = (value) => appendFileSync(
  ${JSON.stringify(observed)},
  JSON.stringify({ scenario, ...value }) + "\\n",
);
const time = "2026-07-29T12:00:00.000Z";
const scenarioSessionDirectory = ${JSON.stringify(sessionDirectory)} + "-" + scenario;
const manager = SessionManager.create(${JSON.stringify(workspace)}, scenarioSessionDirectory, {
  id: "interactive-recovery-order-" + scenario,
});
manager.appendModelChange("inline-recovery", "saved-model");
const toolDefinition = {
  name: "unsafe_tool",
  description: "Never repeat this tool after an uncertain dispatch",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};
const selection = {
  provider: "inline-recovery",
  model: "saved-model",
  api: "openai-responses",
  thinkingLevel: "off",
  toolNames: [toolDefinition.name],
  toolsetFingerprint: sessionV4JsonHash([toolDefinition]),
};
const sourceHeadId = manager.getLeafId();
manager.commitChanges([{
  type: "run_accepted",
  branchId: "main",
  operationId: "interrupted-operation",
  promptNodeId: "interrupted-prompt",
  sourceHeadId,
  acceptedAt: time,
  request: { prompt: "interrupted prompt" },
  selection,
}]);
manager.appendMessage({
  id: "interrupted-prompt",
  role: "user",
  content: [{ type: "text", text: "interrupted prompt" }],
  createdAt: time,
}, {
  nodeId: "interrupted-prompt",
  operationId: "interrupted-operation",
  parentId: sourceHeadId,
});
manager.commitChanges([{
  type: "run_step_selected",
  operationId: "interrupted-operation",
  step: 0,
  selectedAt: time,
  selection,
}, {
  type: "run_attempt",
  operationId: "interrupted-operation",
  attemptId: "interrupted-attempt",
  step: 0,
  attempt: 1,
  task: "provider",
  startedAt: time,
}]);
manager.appendMessage({
  id: "interrupted-assistant",
  role: "assistant",
  content: [{ type: "tool_call", callId: "unsafe-call", name: "unsafe_tool", arguments: {} }],
  createdAt: time,
}, {
  nodeId: "interrupted-assistant",
  operationId: "interrupted-operation",
});
manager.commitChanges([{
  type: "tool_effect_prepared",
  effectId: "unsafe-effect",
  operationId: "interrupted-operation",
  invocationId: "unsafe-invocation",
  callId: "unsafe-call",
  toolName: "unsafe_tool",
  policy: "never_repeat",
  effectiveInput: {},
  inputHash: sessionV4ToolInputHash({}),
  resultNodeId: "unsafe-result",
  step: 0,
  index: 0,
  assistantNodeId: "interrupted-assistant",
  toolsetFingerprint: selection.toolsetFingerprint,
  preparedAt: time,
}, {
  type: "tool_effect_dispatched",
  effectId: "unsafe-effect",
  dispatchId: "unsafe-dispatch",
  dispatchedAt: time,
}]);
const sessionFile = manager.getSessionFile();
manager.closeV4Store();
if (sessionFile === undefined) throw new Error("persistent fixture did not create a session file");

const originalSetModel = AgentSession.prototype.setModel;
AgentSession.prototype.setModel = async function(model, source) {
  record({ type: "set_model", model: model.id, suspended: this.suspendedRun?.operationId ?? null });
  return await originalSetModel.call(this, model, source);
};
const originalRecover = AgentSession.prototype.recoverInterruptedRun;
AgentSession.prototype.recoverInterruptedRun = async function(options = {}) {
  record({
    type: "recover",
    suspended: this.suspendedRun?.operationId ?? null,
    resolutions: options.resolutions ?? [],
  });
  return await originalRecover.call(this, options);
};

let started = false;
let recoveryRequested = false;
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  if (started) return;
  started = true;
  const command = scenario === "startup" ? "/recover" : "/resume " + sessionFile;
  setImmediate(() => process.stdin.emit("data", Buffer.from(command + "\\r")));
};
const originalNotify = TuiController.prototype.notify;
TuiController.prototype.notify = function(message, kind) {
  record({ type: "notify", message: String(message), kind: kind ?? "status" });
  if (
    scenario === "resume"
    && !recoveryRequested
    && String(message).startsWith("Interrupted operation interrupted-operation needs a decision")
  ) {
    recoveryRequested = true;
    setImmediate(() => process.stdin.emit("data", Buffer.from("/recover\\r")));
  }
  if (String(message).startsWith("Recovered interrupted operation")) {
    setImmediate(() => process.stdin.emit("data", Buffer.from("continue safely\\r")));
  }
  return originalNotify.call(this, message, kind);
};

await main([
  "chat",
  ...(scenario === "rpc" ? ["--mode", "rpc"] : []),
  "--workspace", ${JSON.stringify(workspace)},
  "--session-dir", scenarioSessionDirectory,
  ...(scenario === "resume" ? ["--no-session"] : ["--session", sessionFile]),
  "--offline",
  "--no-extensions",
  "--approve",
  "--provider", "inline-recovery",
  "--model", "requested-model",
], {
  extensionFactories: [{
    name: "inline-recovery-provider",
    factory(rigyn) {
      rigyn.registerProvider("inline-recovery", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: ["saved-model", "requested-model"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        })),
        streamSimple: async function* (model) {
          record({ type: "provider", model: model.id });
          yield { type: "response_start", model: model.id };
          yield { type: "text_delta", part: 0, text: "continued after explicit recovery" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
          setImmediate(() => process.stdin.emit("data", Buffer.from("/quit\\r")));
        },
      });
      rigyn.registerTool({
        name: "unsafe_tool",
        label: "Unsafe tool",
        description: "Never repeat this tool after an uncertain dispatch",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        recovery: { mode: "never_repeat" },
        async execute() {
          record({ type: "unsafe_execute" });
          return { content: [{ type: "text", text: "must not execute" }] };
        },
      });
    },
  }],
});
`, "utf8");

  const errors: string[] = [];
  for (const scenario of ["startup", "resume"] as const) {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint, scenario], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        RIGYN_HOME: `${agentDir}-${scenario}`,
        RIGYN_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Interactive ${scenario} recovery fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
      }, 30_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolveExit();
        else reject(new Error(`Interactive ${scenario} recovery fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
      });
    });
    errors.push(stderr);
  }

  const rpc = spawn(process.execPath, ["--import", "tsx", entrypoint, "rpc"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: `${agentDir}-rpc`,
      RIGYN_OFFLINE: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (rpc.exitCode === null) rpc.kill("SIGKILL"); });
  let rpcStdout = "";
  let rpcStderr = "";
  rpc.stdout.setEncoding("utf8").on("data", (chunk: string) => { rpcStdout += chunk; });
  rpc.stderr.setEncoding("utf8").on("data", (chunk: string) => { rpcStderr += chunk; });
  rpc.stdin.write([
    JSON.stringify({
      id: "recover-rpc",
      type: "recover_interrupted_run",
      resolutions: [{ effectId: "unsafe-effect", outcome: "abandoned" }],
    }),
    JSON.stringify({ id: "prompt-rpc", type: "prompt", message: "continue safely" }),
    "",
  ].join("\n"));
  await waitFor(() => rpcStdout.split("\n").some((line) => {
    try { return (JSON.parse(line) as { type?: string }).type === "agent_end"; }
    catch { return false; }
  }), "RPC recovery prompt completion");
  rpc.stdin.end();
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      rpc.kill("SIGKILL");
      reject(new Error(`RPC recovery fixture timed out\nstdout:\n${rpcStdout.slice(-8_000)}\nstderr:\n${rpcStderr.slice(-8_000)}`));
    }, 30_000);
    rpc.once("error", reject);
    rpc.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`RPC recovery fixture exited with ${code ?? signal}\nstdout:\n${rpcStdout.slice(-8_000)}\nstderr:\n${rpcStderr.slice(-8_000)}`));
    });
  });
  errors.push(rpcStderr);
  const rpcResponses = rpcStdout.trim().split("\n").map((line) => JSON.parse(line) as {
    id?: string;
    success?: boolean;
    data?: { recovered?: boolean; operationId?: string };
  });
  assert.deepEqual(rpcResponses.find((entry) => entry.id === "recover-rpc"), {
    id: "recover-rpc",
    type: "response",
    command: "recover_interrupted_run",
    success: true,
    data: { recovered: true, operationId: "interrupted-operation", blocked: [] },
  });
  assert.equal(rpcResponses.find((entry) => entry.id === "prompt-rpc")?.success, true);

  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    scenario: "startup" | "resume" | "rpc";
    type: string;
    model?: string;
    suspended?: string | null;
    resolutions?: Array<{ effectId: string; outcome: string }>;
    message?: string;
  });
  for (const scenario of ["startup", "resume"] as const) {
    const scenarioRecords = records.filter((entry) => entry.scenario === scenario);
    const modelSelections = scenarioRecords.filter((entry) => entry.type === "set_model");
    assert.ok(modelSelections.length > 0, scenario);
    assert.equal(modelSelections.every((entry) =>
      entry.model === "requested-model" && entry.suspended === null), true, scenario);
    assert.equal(scenarioRecords.some((entry) =>
      entry.type === "recover"
      && entry.suspended === "interrupted-operation"
      && entry.resolutions?.some((resolution) =>
        resolution.effectId === "unsafe-effect" && resolution.outcome === "abandoned") === true), true, scenario);
    assert.equal(scenarioRecords.some((entry) =>
      entry.type === "notify" && entry.message?.includes("abandoned 1 blocked tool call without replay") === true), true, scenario);
    assert.equal(scenarioRecords.some((entry) => entry.type === "unsafe_execute"), false, scenario);
    assert.equal(scenarioRecords.filter((entry) =>
      entry.type === "provider" && entry.model === "requested-model").length, 1, scenario);
    const manualResolution = scenarioRecords.findIndex((entry) =>
      entry.type === "recover" && entry.resolutions?.length === 1);
    const selectedModel = scenarioRecords.findLastIndex((entry) => entry.type === "set_model");
    const continuedPrompt = scenarioRecords.findIndex((entry) => entry.type === "provider");
    assert.ok(manualResolution < selectedModel, scenario);
    assert.ok(selectedModel < continuedPrompt, scenario);
  }
  const rpcRecords = records.filter((entry) => entry.scenario === "rpc");
  const rpcRecovery = rpcRecords.findIndex((entry) =>
    entry.type === "recover"
    && entry.suspended === "interrupted-operation"
    && entry.resolutions?.some((resolution) =>
      resolution.effectId === "unsafe-effect" && resolution.outcome === "abandoned") === true);
  const rpcModelSelection = rpcRecords.findIndex((entry) => entry.type === "set_model");
  const rpcPrompt = rpcRecords.findIndex((entry) => entry.type === "provider");
  assert.ok(rpcRecovery >= 0);
  assert.ok(rpcModelSelection > rpcRecovery);
  assert.ok(rpcPrompt > rpcModelSelection);
  assert.equal(rpcRecords[rpcModelSelection]?.model, "requested-model");
  assert.equal(rpcRecords[rpcModelSelection]?.suspended, null);
  assert.equal(rpcRecords[rpcPrompt]?.model, "requested-model");
  assert.equal(rpcRecords.some((entry) => entry.type === "unsafe_execute"), false);
  assert.doesNotMatch(errors.join("\n"), /Call recoverInterruptedRun\(\)/u);
});

test("RPC startup observer failures are isolated after cleaning up the runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-rpc-startup-failure-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "inline-rpc-startup-failure",
    factory(rigyn) {
      rigyn.on("session_start", () => {
        throw new Error("rpc startup failure sentinel");
      });
    },
  }],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC startup failure fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("normal main invocations let supplied factories resolve project trust", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-inline-project-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "trust-calls.txt");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await writeFile(join(workspace, ".rigyn", "config.json"), "{}\n");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFile } from "node:fs/promises";
import { main } from ${JSON.stringify(mainModule)};

let trustCalls = 0;
await main([
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--list-models", "inline-trust-model",
], {
  extensionFactories: [{
    name: "inline-trust-factory",
    factory(rigyn) {
      rigyn.on("project_trust", (event) => {
        trustCalls += 1;
        if (event.cwd !== ${JSON.stringify(workspace)}) throw new Error("Unexpected trust workspace");
        return { trusted: "yes" };
      });
      rigyn.registerProvider("inline-trust-model", {
        name: "Inline Trust Model",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "trusted-model",
          name: "Trusted Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
await writeFile(${JSON.stringify(marker)}, String(trustCalls));
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /^inline-trust-model\/trusted-model\t/u);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(marker, "utf8"), "1");
});

test("project package and config commands share factory-driven trust resolution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-inline-project-package-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "trust-calls.txt");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(workspace, ".rigyn", "config.json"), "{}\n");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "inline-project-package",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\n");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFile } from "node:fs/promises";
import { main } from ${JSON.stringify(mainModule)};

let trustCalls = 0;
let disposals = 0;
const options = {
  extensionFactories: [{
    name: "inline-package-trust-factory",
    factory(rigyn) {
      rigyn.on("project_trust", () => {
        trustCalls += 1;
        return { trusted: "yes" };
      });
      rigyn.onDispose(() => { disposals += 1; });
    },
  }],
};
await main([
  "install", ${JSON.stringify(packageRoot)},
  "--local",
  "--workspace", ${JSON.stringify(workspace)},
  "--json",
], options);
await main([
  "config",
  "--workspace", ${JSON.stringify(workspace)},
  "--json",
], options);
await writeFile(${JSON.stringify(marker)}, \`\${trustCalls},\${disposals}\`);
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /"scope":"project"/u);
  assert.match(result.stdout, /inline-project-package/u);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(marker, "utf8"), "2,2");
});
