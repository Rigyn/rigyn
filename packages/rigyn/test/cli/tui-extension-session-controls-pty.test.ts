import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "../../src/storage/session-manager.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { RIGYN_VERSION } from "../../src/version.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string | (() => string)): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(typeof message === "string" ? message : message());
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

interface Marker {
  type: "command" | "session_start" | "session_shutdown" | "with_session";
  operation?: "built-in-new" | "tree" | "wait" | "new" | "fork" | "switch" | "refresh";
  reason?: string;
  cancelled?: boolean;
  cancellable?: boolean;
  generation?: number;
  phase?: "started" | "aborted";
  sessionId?: string;
}

test("installed TUI keeps extension session controls owner-bound across replacement and refresh", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tui-extension-owner-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const targetSessions = join(root, "target-sessions");
  const entrypoint = join(root, "entrypoint.mjs");
  const markerPath = join(root, "lifecycle.jsonl");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const target = SessionManager.create(workspace, targetSessions);
  target.appendMessage({
    id: "switch-target-user",
    role: "user",
    content: [{ type: "text", text: "switch target" }],
    createdAt: "2026-07-25T00:00:00.000Z",
  });
  const targetPath = target.getSessionFile();
  assert.ok(targetPath);
  target.closeV4Store();

  const mainModule = new URL("../../dist/cli/main.js", import.meta.url).href;
  const sessionOperationsModule = new URL("../../dist/modes/interactive-session-operations.js", import.meta.url).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { InteractiveSessionOperations } from ${JSON.stringify(sessionOperationsModule)};

const mark = (value) => appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(value) + "\\n");
let generation = 0;
let blockBuiltInNew = true;

InteractiveSessionOperations.prototype.navigateTree = async function(signal) {
  mark({ type: "command", operation: "tree", phase: "started", cancellable: signal instanceof AbortSignal });
  if (signal === undefined) return;
  await new Promise((resolveWait) => {
    const abort = () => {
      mark({ type: "command", operation: "tree", phase: "aborted" });
      resolveWait();
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "owner-fixture",
  "--model", "owner-model",
  "--approve",
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "owner-session-controls",
    factory(rigyn) {
      const activeGeneration = ++generation;
      rigyn.registerProvider("owner-fixture", {
        name: "Owner Fixture",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "owner-model",
          name: "Owner Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        }],
      });
      rigyn.on("session_start", (event) => {
        mark({ type: "session_start", reason: event.reason, generation: activeGeneration });
      });
      rigyn.on("session_shutdown", (event) => {
        mark({ type: "session_shutdown", reason: event.reason, generation: activeGeneration });
      });
      rigyn.on("session_before_switch", (event, context) => {
        if (event.reason !== "new" || !blockBuiltInNew) return;
        blockBuiltInNew = false;
        mark({ type: "command", operation: "built-in-new", phase: "started", generation: activeGeneration });
        const markAborted = () => {
          mark({ type: "command", operation: "built-in-new", phase: "aborted", generation: activeGeneration });
        };
        if (context.signal?.aborted === true) markAborted();
        else context.signal?.addEventListener("abort", markAborted, { once: true });
        return new Promise(() => {});
      });
      rigyn.registerCommand("owner-wait", {
        async handler(_args, command) {
          mark({ type: "command", operation: "wait", phase: "started", generation: activeGeneration });
          await new Promise((resolveWait, reject) => {
            const abort = () => {
              mark({ type: "command", operation: "wait", phase: "aborted", generation: activeGeneration });
              reject(command.signal.reason ?? new Error("owner wait cancelled"));
            };
            if (command.signal.aborted) abort();
            else command.signal.addEventListener("abort", abort, { once: true });
          });
        },
      });
      rigyn.registerCommand("owner-new", {
        async handler(_args, command) {
          const result = await command.newSession({
            async setup(session) {
              session.appendMessage({
                role: "user",
                content: [{ type: "text", text: "seeded for extension fork" }],
                timestamp: Date.now(),
              });
            },
            async withSession(next) {
              mark({ type: "with_session", operation: "new", sessionId: next.sessionManager.getSessionId() });
            },
          });
          mark({ type: "command", operation: "new", cancelled: result.cancelled });
        },
      });
      rigyn.registerCommand("owner-fork", {
        async handler(_args, command) {
          const entry = command.sessionManager.getEntries().find(
            (candidate) => candidate.type === "message" && candidate.message.role === "user",
          );
          if (entry === undefined) throw new Error("seeded fork entry is missing");
          const result = await command.fork(entry.id, {
            position: "at",
            async withSession(next) {
              mark({ type: "with_session", operation: "fork", sessionId: next.sessionManager.getSessionId() });
            },
          });
          mark({ type: "command", operation: "fork", cancelled: result.cancelled });
        },
      });
      rigyn.registerCommand("owner-switch", {
        async handler(_args, command) {
          const result = await command.switchSession(${JSON.stringify(targetPath)}, {
            async withSession(next) {
              mark({ type: "with_session", operation: "switch", sessionId: next.sessionManager.getSessionId() });
            },
          });
          mark({ type: "command", operation: "switch", cancelled: result.cancelled });
        },
      });
      rigyn.registerCommand("owner-refresh", {
        async handler(_args, command) {
          await command.refresh();
          mark({ type: "command", operation: "refresh" });
        },
      });
    },
  }],
});
`);

  const command = [process.execPath, entrypoint].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDir,
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const markers = async (): Promise<Marker[]> => {
    if (!existsSync(markerPath)) return [];
    return (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Marker);
  };
  const waitForCommand = async (operation: Marker["operation"], count = 1): Promise<void> => {
    await waitFor(async () =>
      (await markers()).filter((entry) => entry.type === "command" && entry.operation === operation).length >= count,
    () => `${operation} extension command did not finish:\n${rendered}`);
  };

  await waitFor(() => rendered.includes(`rigyn ${RIGYN_VERSION} · ready`), `CLI did not become ready:\n${rendered}`);
  child.stdin.write("/new\r");
  await waitFor(async () =>
    (await markers()).some((entry) =>
      entry.type === "command" && entry.operation === "built-in-new" && entry.phase === "started"),
  `built-in /new did not reach the cancellable owner guard:\n${rendered}`);
  child.stdin.write("\u001b");
  await waitFor(async () =>
    (await markers()).some((entry) =>
      entry.type === "command" && entry.operation === "built-in-new" && entry.phase === "aborted"),
  `Escape did not cancel the built-in session preflight:\n${rendered}`);
  child.stdin.write("/tree\r");
  await waitFor(async () =>
    (await markers()).some((entry) =>
      entry.type === "command" && entry.operation === "tree" && entry.phase === "started"),
  `built-in /tree did not start:\n${rendered}`);
  assert.equal(
    (await markers()).find((entry) => entry.type === "command" && entry.operation === "tree")?.cancellable,
    true,
    "built-in /tree must receive the shipping CLI operation signal",
  );
  child.stdin.write("\u001b");
  await waitFor(async () =>
    (await markers()).some((entry) =>
      entry.type === "command" && entry.operation === "tree" && entry.phase === "aborted"),
  `Escape did not cancel the built-in tree operation:\n${rendered}`);
  child.stdin.write("/owner-wait\r");
  await waitFor(async () =>
    (await markers()).some((entry) =>
      entry.type === "command" && entry.operation === "wait" && entry.phase === "started"),
  `blocking extension command did not start:\n${rendered}`);
  child.stdin.write("\u001b");
  await waitFor(async () =>
    (await markers()).some((entry) =>
      entry.type === "command" && entry.operation === "wait" && entry.phase === "aborted"),
  `Escape did not cancel the extension command preflight:\n${rendered}`);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
  child.stdin.write("/owner-new\r");
  await waitForCommand("new");
  child.stdin.write("/owner-fork\r");
  await waitForCommand("fork");
  child.stdin.write("/owner-switch\r");
  await waitForCommand("switch");
  const refreshOutputStart = rendered.length;
  child.stdin.write("/owner-refresh\r");
  await waitForCommand("refresh");
  await waitFor(
    () => {
      const output = stripAnsi(rendered.slice(refreshOutputStart));
      return output.includes("Refreshed keyboard mappings") && output.includes("instruction files");
    },
    `extension refresh did not use the built-in transactional UI flow:\n${rendered}`,
  );
  child.stdin.write("/owner-new\r");
  await waitForCommand("new", 2);
  child.stdin.write("/exit\r");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit after extension session controls:\n${rendered}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
  assert.equal(exit.signal, null, rendered);
  assert.equal(exit.code, 0, rendered);

  const records = await markers();
  assert.deepEqual(
    records.filter((entry) => entry.type === "session_start").map((entry) => ({
      reason: entry.reason,
      generation: entry.generation,
    })),
    [
      { reason: "startup", generation: 1 },
      { reason: "new", generation: 2 },
      { reason: "fork", generation: 3 },
      { reason: "resume", generation: 4 },
      { reason: "refresh", generation: 5 },
      { reason: "new", generation: 6 },
    ],
  );
  assert.deepEqual(
    records.filter((entry) => entry.type === "session_shutdown").map((entry) => ({
      reason: entry.reason,
      generation: entry.generation,
    })),
    [
      { reason: "new", generation: 1 },
      { reason: "fork", generation: 2 },
      { reason: "resume", generation: 3 },
      { reason: "refresh", generation: 4 },
      { reason: "new", generation: 5 },
      { reason: "quit", generation: 6 },
    ],
  );
  assert.deepEqual(
    records.filter((entry) => entry.type === "command" && entry.phase === undefined).map((entry) => ({
      operation: entry.operation,
      ...(entry.cancelled === undefined ? {} : { cancelled: entry.cancelled }),
    })),
    [
      { operation: "new", cancelled: false },
      { operation: "fork", cancelled: false },
      { operation: "switch", cancelled: false },
      { operation: "refresh" },
      { operation: "new", cancelled: false },
    ],
  );
  assert.deepEqual(records.filter((entry) => entry.type === "with_session").map((entry) => entry.operation), [
    "new",
    "fork",
    "switch",
    "new",
  ]);
  assert.deepEqual(
    records.filter((entry) => entry.type === "command" && entry.operation === "wait").map((entry) => ({
      phase: entry.phase,
      generation: entry.generation,
    })),
    [
      { phase: "started", generation: 1 },
      { phase: "aborted", generation: 1 },
    ],
  );
  assert.equal(records.filter((entry) => entry.type === "session_start" && entry.reason === "refresh").length, 1);
});
