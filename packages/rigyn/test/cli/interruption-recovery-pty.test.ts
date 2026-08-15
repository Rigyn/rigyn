import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(check: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("shipping TUI recovers one local Esc before submitting continue", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-interrupt-recovery-pty-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const stateDirectory = join(root, "state");
  const entrypoint = join(root, "entrypoint.mjs");
  const toolReady = join(root, "tool-ready");
  const toolExecutions = join(root, "tool-executions.jsonl");
  const prompts = join(root, "prompts.jsonl");
  const recoveries = join(root, "recoveries.jsonl");
  const notifications = join(root, "notifications.jsonl");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const mainModule = new URL("../../src/cli/main.ts", import.meta.url).href;
  const sessionModule = new URL("../../src/service/agent-session.ts", import.meta.url).href;
  const controllerModule = new URL("../../src/tui/controller.ts", import.meta.url).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(sessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

const originalNotify = TuiController.prototype.notify;
TuiController.prototype.notify = function(message, kind = "status") {
  appendFileSync(${JSON.stringify(notifications)}, JSON.stringify({ message, kind }) + "\\n");
  return originalNotify.call(this, message, kind);
};

const originalPrompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function(text, options) {
  appendFileSync(${JSON.stringify(prompts)}, JSON.stringify({ sessionId: this.sessionId, text }) + "\\n");
  return await originalPrompt.call(this, text, options);
};
const originalRecover = AgentSession.prototype.recoverInterruptedRun;
AgentSession.prototype.recoverInterruptedRun = async function(options = {}) {
  appendFileSync(${JSON.stringify(recoveries)}, JSON.stringify({
    sessionId: this.sessionId,
    resolutions: options.resolutions ?? [],
  }) + "\\n");
  return await originalRecover.call(this, options);
};

let requests = 0;
await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "interrupt-fixture",
  "--model", "interrupt-model",
  "--approve",
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "interrupt-recovery-fixture",
    factory(rigyn) {
      rigyn.registerTool({
        name: "blocking_tool",
        label: "Blocking tool",
        description: "Waits until the operator interrupts it",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        async execute(_callId, _input, signal) {
          appendFileSync(${JSON.stringify(toolExecutions)}, "started\\n");
          await writeFile(${JSON.stringify(toolReady)}, "ready");
          await new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason ?? new Error("tool interrupted"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          return { content: [{ type: "text", text: "unreachable" }], details: {} };
        },
      });
      rigyn.registerProvider("interrupt-fixture", {
        name: "Interrupt fixture",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "interrupt-model",
          name: "Interrupt model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        }],
        async *streamSimple(model) {
          requests += 1;
          yield { type: "response_start", model: model.id };
          if (requests === 1) {
            yield { type: "tool_call_start", index: 0, id: "blocking-call", name: "blocking_tool" };
            yield {
              type: "tool_call_end",
              index: 0,
              id: "blocking-call",
              name: "blocking_tool",
              rawArguments: "{}",
              arguments: {},
            };
            yield {
              type: "response_end",
              reason: "tool_calls",
              state: { kind: "openai_responses", outputItems: [] },
            };
            return;
          }
          yield { type: "text_delta", part: 0, text: "continued safely" };
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

  const command = [process.execPath, "--import", "tsx", entrypoint].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDirectory,
      XDG_STATE_HOME: stateDirectory,
      RIGYN_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });

  await waitFor(() => output.includes("ready"), () => `TUI did not start:\n${output.slice(-16_000)}`);
  child.stdin.write("make docs\r");
  await waitFor(() => existsSync(toolReady), () => `tool did not start:\n${output.slice(-16_000)}`);
  child.stdin.write("\u001b");
  await waitFor(() => output.includes("Interrupted"), () => `run did not interrupt:\n${output.slice(-16_000)}`);
  child.stdin.write("continue\r");
  await waitFor(() => output.includes("continued safely"), () => `continue did not run:\n${output.slice(-16_000)}`);

  const promptRows = (await readFile(prompts, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const recoveryRows = (await readFile(recoveries, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const notificationRows = (await readFile(notifications, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(promptRows.map((row) => row.text), ["make docs", "continue"]);
  assert.equal(new Set(promptRows.map((row) => row.sessionId)).size, 1);
  assert.equal(recoveryRows.length, 1);
  assert.equal(recoveryRows[0].sessionId, promptRows[0].sessionId);
  assert.equal(recoveryRows[0].resolutions.length, 1);
  assert.equal(recoveryRows[0].resolutions[0].outcome, "abandoned");
  assert.equal((await readFile(toolExecutions, "utf8")).trim().split("\n").length, 1);
  assert.doesNotMatch(output, /Call recoverInterruptedRun\(\)/u);
  assert.equal(notificationRows.filter((row) => row.message.includes("Recovered interrupted operation")).length, 1);
  assert.equal(notificationRows.filter((row) => row.kind === "error").length, 0);

  const exit = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TUI did not exit:\n${output.slice(-16_000)}`)), 10_000);
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.write("/exit\r");
  assert.equal(await exit, 0, output);
});
