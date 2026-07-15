import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseJsoncObject, TrustStore } from "../../src/config/index.js";
import { SessionStore } from "../../src/storage/store.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function waitForOutputAfter(read: () => string, offset: number, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!read().slice(offset).includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function waitForFileOutput(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} in ${path}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

interface ChatPaths {
  root: string;
  workspace: string;
  config: string;
  state: string;
}

function launchChat(
  paths: ChatPaths,
  extraArguments: string[],
  mode: string,
  environmentOverrides: NodeJS.ProcessEnv = {},
  explicitChat = false,
) {
  const command = [
    process.execPath,
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    ...(explicitChat ? ["chat"] : []),
    "--workspace",
    paths.workspace,
    ...extraArguments,
  ].map(shellQuote).join(" ");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  Object.assign(environment, {
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    RIGYN_TUI_MODE: mode,
    TERM: "xterm-256color",
    NO_COLOR: "1",
    ...environmentOverrides,
  });
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  return { child, read: () => rendered, ...paths };
}

async function startChat(
  extraArguments: string[] = [],
  prepare?: (paths: ChatPaths) => Promise<void>,
  mode = "accessible",
  environmentOverrides: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harness-chat-startup-"));
  const paths = {
    root,
    workspace: join(root, "workspace"),
    config: join(root, "config"),
    state: join(root, "state"),
  };
  await mkdir(paths.workspace);
  await mkdir(join(paths.config, "rigyn"), { recursive: true, mode: 0o700 });
  await prepare?.(paths);
  return launchChat(paths, extraArguments, mode, environmentOverrides);
}

function clipboardBmp(): Buffer {
  const data = Buffer.alloc(58);
  data.write("BM", 0, "ascii");
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(1, 18);
  data.writeInt32LE(1, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(4, 34);
  data[56] = 0xff;
  return data;
}

async function finishChat(session: Awaited<ReturnType<typeof startChat>>): Promise<number | null> {
  return new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      session.child.kill("SIGKILL");
      reject(new Error(`chat did not exit:\n${session.read()}`));
    }, 10_000);
    session.child.once("error", reject);
    session.child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeReloadRuntime(path: string, log: string, version: string): Promise<void> {
  await writeFile(path, `
    import { appendFile } from "node:fs/promises";
    const version = ${JSON.stringify(version)};
    const log = ${JSON.stringify(log)};
    export default function activate(api) {
      api.registerTool({
        name: "reload_echo",
        description: "Echo reload renderer input",
        inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
        execute(input) { return { content: version + " tool result " + input.text, isError: false }; },
      });
      api.registerToolRenderer("reload_echo", {
        renderCall(view) { return { lines: [{ spans: [{ text: version + " CUSTOM CALL " + (view.input?.text || ""), role: "accent" }] }] }; },
        renderResult(view) { return { lines: [{ spans: [{ text: version + " CUSTOM RESULT " + (view.result?.content || ""), role: "success" }] }] }; },
      });
      api.registerCommand({ name: "reload-demo", execute({ args }) { return { prompt: version + ":" + args }; } });
      api.registerCommand({ name: "self-reload", async execute(context) {
        await api.reload({ threadId: context.threadId, ...(context.branch === undefined ? {} : { branch: context.branch }) });
      } });
      api.registerCommand({ name: version === "v1" ? "old-only" : "new-only", execute() { return; } });
      api.registerProvider({
        id: "reload-offline",
        async *stream(request) {
          const prompt = request.messages.flatMap((message) => message.content)
            .filter((block) => block.type === "text").at(-1)?.text || "";
          yield { type: "response_start", model: request.model };
          if (prompt.includes("render-tool") && request.messages.at(-1)?.role !== "tool") {
            const callId = "reload-call-" + version + "-" + (prompt.includes("second") ? "second" : "first");
            yield { type: "tool_call_start", index: 0, id: callId, name: "reload_echo" };
            yield { type: "tool_call_delta", index: 0, jsonFragment: JSON.stringify({ text: prompt }) };
            yield { type: "tool_call_end", index: 0, id: callId, name: "reload_echo", rawArguments: JSON.stringify({ text: prompt }), arguments: { text: prompt } };
            yield { type: "response_end", reason: "tool_calls", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
            return;
          }
          yield { type: "text_delta", part: 0, text: version + " response " + prompt };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() { return []; },
      });
      api.ui.setStatus("version", "reload " + version + " status");
      api.ui.setWidget("version", "reload " + version + " widget");
      api.on("session_start", async (value) => appendFile(log, "start:" + version + ":" + (value.reason || "initial") + "\\n"));
      api.on("session_end", async (value) => appendFile(log, "end:" + version + ":" + (value.reason || "exit") + "\\n"));
      api.onDispose(async () => appendFile(log, "dispose:" + version + "\\n"));
    }
  `);
}

test("startup reports version, context, and the loaded keybindings", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ workspace, config }) => {
    await writeFile(join(workspace, "AGENTS.md"), "startup instructions\n");
    const directory = join(config, "rigyn");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "keybindings.json"), JSON.stringify({
      "app.model.select": "ctrl+k",
      "app.model.cycleForward": "alt+n",
      "app.tools.expand": "alt+t",
      "app.interrupt": "ctrl+x",
    }));
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  await waitForOutput(session.read, "Ctrl+X interrupt · Ctrl+C clear/exit twice · Ctrl+D exit");
  await waitForOutput(session.read, "commands · ! bash");
  assert.doesNotMatch(session.read(), /Alt\+T help/u);
  assert.doesNotMatch(session.read(), /\[Context\]/u);
  session.child.stdin.write("\u001bt");
  await waitForOutput(session.read, "[Context]");
  await waitForOutput(session.read, "./AGENTS.md");
  session.child.stdin.write("/exit\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("a full-screen action picker returns to chat instead of exiting the process", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat(["--offline"], undefined, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  const credentialKey = join(session.config, "rigyn", "credentials.key");
  assert.equal(await pathExists(credentialKey), false);
  session.child.stdin.write("/model\r");
  await waitForOutput(session.read, "Use /login to connect a provider");
  assert.equal(session.child.exitCode, null, session.read());
  let closeOffset = session.read().length;
  session.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(session.read, closeOffset, "no-model");
  session.child.stdin.write("/resume\r");
  await waitForOutput(session.read, "No sessions in this workspace");
  assert.equal(session.child.exitCode, null, session.read());
  closeOffset = session.read().length;
  session.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(session.read, closeOffset, "no-model");
  session.child.stdin.write("/session\r");
  await waitForOutput(session.read, "Messages: 0 user · 0 assistant · 0 tool");
  session.child.stdin.write("/exit\r");
  assert.equal(await finishChat(session), 0, session.read());
  assert.equal(await pathExists(credentialKey), false);
});

test("a lone idle Escape does not exit full-screen chat", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat(["--offline", "--no-session"], undefined, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("\u001b");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(session.child.exitCode, null, session.read());
  session.child.stdin.write("/session\r");
  await waitForOutput(session.read, "Messages: 0 user · 0 assistant · 0 tool");
  session.child.stdin.write("/exit\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("an extension overlay closes on the first Escape and chat remains usable", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([
    "--offline", "--no-session", "--no-extensions", "--extension", resolve("examples/custom-overlay.mjs"),
  ], undefined, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("/overlay-demo\r");
  await waitForOutput(session.read, "Custom overlay");
  session.child.stdin.write("\u001b");
  await waitForOutput(session.read, "Overlay cancelled.");
  assert.equal(session.child.exitCode, null, session.read());
  session.child.stdin.write("/session\r");
  await waitForOutput(session.read, "Messages: 0 user · 0 assistant · 0 tool");
  session.child.stdin.write("/exit\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("input submitted while runtime extensions are still loading is handled after startup", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "slow-startup");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "slow-startup",
      name: "Slow startup",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      export default function activate() {}
    `);
  });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("a bare prompt starts interactive chat and submits the prompt after startup", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-bare-prompt-"));
  const paths = {
    root,
    workspace: join(root, "workspace"),
    config: join(root, "config"),
    state: join(root, "state"),
  };
  await mkdir(paths.workspace);
  await writeFile(join(paths.workspace, "context file.md"), "fixture context\n");
  const extension = join(paths.config, "rigyn", "extensions", "bare-prompt");
  await mkdir(join(extension, "runtime"), { recursive: true, mode: 0o700 });
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "bare-prompt",
    name: "Bare prompt",
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(join(extension, "runtime", "index.mjs"), `
    export default function activate(api) {
      api.registerProvider({
        id: "bare-prompt",
        async *stream(request) {
          const prompt = request.messages.flatMap((message) => message.content)
            .filter((block) => block.type === "text").at(-1)?.text || "";
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "received:" + prompt };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() { return [{ id: "alpha", provider: "bare-prompt", input: ["text"], output: ["text"], supportsStreaming: true }]; },
      });
    }
  `);
  const session = launchChat(paths, [
    "@context file.md",
    "build the fixture",
    "verify it",
    "--provider", "bare-prompt",
    "--model", "alpha",
    "--no-session",
  ], "accessible", {}, false);
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  await waitForOutput(session.read, "received:@\"context file.md\"");
  await waitForOutput(session.read, "fixture context");
  await waitForOutput(session.read, "received:verify it");
  assert.equal(session.child.exitCode, null, session.read());
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("runtime input handlers can handle or transform interactive submissions before model expansion", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([
    "--provider", "input-offline", "--model", "input-model", "--no-session", "--fixture-mode", "strict",
  ], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "input-offline");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "input-offline",
      name: "Input offline",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      api.registerFlag({ name: "fixture-mode", type: "string", default: "normal" });
      api.on("session_start", () => api.ui.notify("extension flag " + api.getFlag("fixture-mode")));
      api.on("input", (event) => {
        if (event.text === "handled") {
          api.ui.notify("extension handled input");
          return { action: "handled" };
        }
        return { action: "transform", text: event.text + " transformed" };
      });
      api.registerProvider({
        id: "input-offline",
        async *stream(request) {
          const text = request.messages.flatMap((message) => message.content)
            .filter((block) => block.type === "text").at(-1)?.text || "";
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "provider saw " + text };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() { return []; },
      });
    };\n`);
  });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Ready");
  await waitForOutput(session.read, "extension flag strict");
  session.child.stdin.write("handled\n");
  await waitForOutput(session.read, "extension handled input");
  session.child.stdin.write("hello\n");
  await waitForOutput(session.read, "provider saw hello transformed");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("interactive --no-session keeps completed turns out of the durable database", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([
    "--provider", "ephemeral-chat", "--model", "ephemeral-model", "--no-session",
  ], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "ephemeral-chat");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "ephemeral-chat",
      name: "Ephemeral chat fixture",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default function activate(api) {
      api.registerProvider({
        id: "ephemeral-chat",
        async *stream(request) {
          const text = request.messages.flatMap((message) => message.content)
            .filter((block) => block.type === "text").at(-1)?.text || "";
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "ephemeral response " + text };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() { return []; },
      });
    }`);
  });
  t.after(async () => {
    if (session.child.exitCode === null) session.child.kill("SIGKILL");
    await rm(session.root, { recursive: true, force: true });
  });
  await waitForOutput(session.read, "Ready");
  session.child.stdin.write("ephemeral prompt\n");
  await waitForOutput(session.read, "ephemeral response ephemeral prompt");
  const database = join(session.state, "rigyn", "sessions.sqlite");
  assert.equal(await pathExists(database), false);
  const resumeOffset = session.read().length;
  session.child.stdin.write("/resume\n");
  await waitForOutputAfter(session.read, resumeOffset, "Session resume is unavailable in --no-session mode");
  assert.doesNotMatch(session.read().slice(resumeOffset), /Command failed:/u);
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
  assert.equal(await pathExists(database), false);
  assert.doesNotMatch(session.read(), /To resume this session:/u);
});

test("extension session entries render live and replay through the public runtime renderer", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const providerArguments = ["--provider", "session-renderer-offline", "--model", "session-renderer-v1"];
  const first = await startChat(providerArguments, async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "session-renderer-offline");
    await mkdir(join(extension, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "session-renderer-offline",
      name: "Session renderer offline",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default function activate(api) {
      api.session.registerRenderers(1, {
        renderState(entry) {
          return { lines: [{ spans: [{ text: "SESSION STATE " + entry.value.count, role: "accent" }] }] };
        },
        renderMessage(entry) {
          return { lines: [{ spans: [{ text: "SESSION MESSAGE " + entry.payload.count, role: "success" }] }] };
        },
      });
      api.on("session_start", async (event) => {
        const target = { threadId: event.threadId, ...(event.branch ? { branch: event.branch } : {}) };
        const previous = await api.session.readState({ ...target, schemaVersion: 1, key: "starts" });
        const count = (previous?.value?.count || 0) + 1;
        await api.session.appendState({ ...target, schemaVersion: 1, key: "starts", value: { count } });
        await api.session.appendMessage({
          ...target,
          schemaVersion: 1,
          kind: "started",
          payload: { count },
          modelContext: false,
          transcript: { text: "fallback session " + count },
        });
      });
      api.registerProvider({
        id: "session-renderer-offline",
        async *stream(request) {
          const text = request.messages.flatMap((message) => message.content)
            .filter((block) => block.type === "text").at(-1)?.text || "";
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "session provider " + text };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() { return [{ id: "session-renderer-v1", provider: "session-renderer-offline" }]; },
      });
    };
`);
  }, "full");
  t.after(async () => {
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
    await rm(first.root, { recursive: true, force: true });
  });
  await waitForOutput(first.read, "SESSION STATE 1");
  await waitForOutput(first.read, "SESSION MESSAGE 1");
  first.child.stdin.write("persist session\r");
  await waitForOutput(first.read, "session provider persist session");
  first.child.stdin.write("/exit\r");
  assert.equal(await finishChat(first), 0, first.read());

  const second = launchChat({
    root: first.root,
    workspace: first.workspace,
    config: first.config,
    state: first.state,
  }, ["--continue", ...providerArguments], "full");
  t.after(() => { if (second.child.exitCode === null) second.child.kill("SIGKILL"); });
  await waitForOutput(second.read, "SESSION STATE 1");
  await waitForOutput(second.read, "SESSION STATE 2");
  await waitForOutput(second.read, "SESSION MESSAGE 2");
  second.child.stdin.write("/exit\r");
  assert.equal(await finishChat(second), 0, second.read());
});

test("extension-only durable sessions survive Ctrl+D and resume by exact ID or latest", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const sessionId = "dogfood-extension-test";
  const first = await startChat(["--offline", "--session-id", sessionId], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "extension-only-session");
    await mkdir(join(extension, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "extension-only-session",
      name: "Extension-only session fixture",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default function activate(api) {
      const target = (context) => ({
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      });
      api.registerCommand({ name: "remember-extension-only", async execute(context) {
        const previous = await api.session.readState({
          ...target(context), schemaVersion: 1, key: "invocations",
        });
        const count = (previous?.value?.count || 0) + 1;
        await api.session.appendState({
          ...target(context), schemaVersion: 1, key: "invocations", value: { count },
        });
        context.ui.notify("EXTENSION STATE " + count);
      } });
      api.registerCommand({ name: "inspect-extension-only", async execute(context) {
        const current = await api.session.readState({
          ...target(context), schemaVersion: 1, key: "invocations",
        });
        context.ui.notify("EXTENSION STATE " + (current?.value?.count || 0));
      } });
    }`);
  }, "full");
  let second: ReturnType<typeof launchChat> | undefined;
  let third: ReturnType<typeof launchChat> | undefined;
  t.after(async () => {
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
    if (second?.child.exitCode === null) second.child.kill("SIGKILL");
    if (third?.child.exitCode === null) third.child.kill("SIGKILL");
    await rm(first.root, { recursive: true, force: true });
  });

  await waitForOutput(first.read, "Rigyn v0.1.4 · Ready");
  first.child.stdin.write("\u001b[200~/remember-extension-only\u001b[201~\r");
  await waitForOutput(first.read, "EXTENSION STATE 1");
  first.child.stdin.write("\u0004");
  assert.equal(await finishChat(first), 0, first.read());
  assert.match(first.read(), /To resume this session: rigyn --session dogfood-extension-test/u);

  second = launchChat({
    root: first.root,
    workspace: first.workspace,
    config: first.config,
    state: first.state,
  }, ["--offline", "--session", sessionId], "full");
  await waitForOutput(second.read, "Rigyn v0.1.4 · Ready");
  second.child.stdin.write("\u001b[200~/inspect-extension-only\u001b[201~\r");
  await waitForOutput(second.read, "EXTENSION STATE 1");
  second.child.stdin.write("\u0004");
  assert.equal(await finishChat(second), 0, second.read());

  third = launchChat({
    root: first.root,
    workspace: first.workspace,
    config: first.config,
    state: first.state,
  }, ["--offline", "--continue"], "full");
  await waitForOutput(third.read, "Rigyn v0.1.4 · Ready");
  third.child.stdin.write("\u001b[200~/inspect-extension-only\u001b[201~\r");
  await waitForOutput(third.read, "EXTENSION STATE 1");
  third.child.stdin.write("\u0004");
  assert.equal(await finishChat(third), 0, third.read());
});

test("clipboard BMP hotkey crosses the real chat prompt pipeline as provider-safe PNG", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const clipboardEnvironment: NodeJS.ProcessEnv = {};
  const source = clipboardBmp();
  const session = await startChat([
    "--provider", "clipboard-offline", "--model", "clipboard-v1", "--no-session",
  ], async ({ root, config }) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "wl-paste"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--list-types")) process.stdout.write("image/bmp\\n");
else process.stdout.write(Buffer.from(${JSON.stringify(source.toString("base64"))}, "base64"));
`, { mode: 0o700 });
    clipboardEnvironment.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    clipboardEnvironment.WAYLAND_DISPLAY = "wayland-test";
    clipboardEnvironment.XDG_RUNTIME_DIR = root;

    const extension = join(config, "rigyn", "extensions", "clipboard-offline");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "clipboard-offline",
      name: "Clipboard offline",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default function activate(api) {
      api.registerProvider({
        id: "clipboard-offline",
        async *stream(request) {
          const images = request.messages.flatMap((message) => message.content).filter((block) => block.type === "image");
          const selected = images.at(-1);
          const signature = selected?.data ? Buffer.from(selected.data, "base64").subarray(0, 4).toString("hex") : "none";
          const text = "clipboard-provider:" + images.length + ":" + (selected?.mediaType || "none") + ":" + signature;
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: text } } };
        },
        async listModels() {
          const supported = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
          return [{ id: "clipboard-v1", provider: "clipboard-offline", capabilities: { tools: supported, reasoning: supported, images: supported } }];
        },
      });
    };
`);
  }, "full", clipboardEnvironment);
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write(Buffer.from([22]));
  await waitForOutput(session.read, "Attached clipboard image 1x1 via wayland (1/8)");
  session.child.stdin.write("\u001b[200~inspect image\u001b[201~\r");
  await waitForOutput(session.read, "clipboard-provider:1:image/png:89504e47");
  assert.doesNotMatch(session.read(), new RegExp(source.toString("base64"), "u"));
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("commands submitted during a response defer in order and never become provider steering", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let providerLog = "";
  let extensionLog = "";
  let shellEventLog = "";
  let shellOutput = "";
  const session = await startChat(["--provider", "active-route", "--model", "alpha", "--no-session"], async ({ root, config }) => {
    providerLog = join(root, "provider.log");
    extensionLog = join(root, "extension.log");
    shellEventLog = join(root, "shell-event.log");
    shellOutput = join(root, "shell-output.txt");
    const extension = join(config, "rigyn", "extensions", "active-route");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "active-route",
      name: "Active route",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const providerLog = ${JSON.stringify(providerLog)};
      const extensionLog = ${JSON.stringify(extensionLog)};
      const shellEventLog = ${JSON.stringify(shellEventLog)};
      export default function activate(api) {
        api.registerCommand({ name: "mark", async execute() { await appendFile(extensionLog, "mark\\n"); api.ui.notify("deferred extension command ran"); } });
        api.on("event", async (event) => {
          if (event?.type === "user_shell") await appendFile(shellEventLog, "hidden:" + event.hidden + "\\n");
        });
        api.registerProvider({
          id: "active-route",
          async *stream(request) {
            const text = request.messages.filter((message) => message.role === "user")
              .flatMap((message) => message.content).filter((block) => block.type === "text").at(-1)?.text || "";
            await appendFile(providerLog, request.model + ":" + text + "\\n");
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "route-streaming" };
            await new Promise((resolve) => setTimeout(resolve, 700));
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() {
            const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
            return ["alpha", "beta"].map((id) => ({ id, provider: "active-route", capabilities: { tools: capability, reasoning: capability, images: capability } }));
          },
        });
      }
    `);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  const submit = (value: string) => session.child.stdin.write(`\u001b[200~${value}\u001b[201~\r`);
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  assert.doesNotMatch(session.read(), /no-model/u);
  submit("begin route");
  await waitForOutput(session.read, "route-streaming");
  submit("/model beta");
  submit("/mark");
  submit(`!!printf shell-deferred > ${shellQuote(shellOutput)}`);
  submit("/settings");

  await waitForOutput(session.read, "Model active-route/beta");
  await waitForOutput(session.read, "deferred extension command ran");
  await waitForOutput(session.read, "Auto-compact");
  assert.equal((await readFile(shellOutput, "utf8")).trim(), "shell-deferred");
  assert.equal((await readFile(extensionLog, "utf8")).trim(), "mark");
  assert.equal((await readFile(shellEventLog, "utf8")).trim(), "hidden:true");
  assert.deepEqual((await readFile(providerLog, "utf8")).trim().split("\n"), ["alpha:begin route"]);
  const closeOffset = session.read().length;
  session.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(session.read, closeOffset, "beta • thinking off");
  submit("/exit");
  assert.equal(await finishChat(session), 0, session.read());
});

test("model command resolves canonical thinking shorthand and rejects ambiguous fuzzy choices", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let providerLog = "";
  const session = await startChat(["--provider", "model-shorthand", "--model", "alpha", "--no-session"], async ({ root, config }) => {
    providerLog = join(root, "model-shorthand.log");
    const extension = join(config, "rigyn", "extensions", "model-shorthand");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "model-shorthand",
      name: "Model shorthand",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(providerLog)};
      export default function activate(api) {
        api.registerProvider({
          id: "model-shorthand",
          async *stream(request) {
            await appendFile(log, request.model + ":" + (request.reasoningEffort || "default") + "\\n");
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "shorthand response" };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() {
            const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
            const compatibility = { reasoningEfforts: { value: ["low", "high"], source: "provider", observedAt: "2026-01-01T00:00:00.000Z" } };
            return ["alpha", "beta", "coder-v1", "coder-v2"].map((id) => ({
              id, provider: "model-shorthand", capabilities: { tools: capability, reasoning: capability, images: capability }, compatibility,
            }));
          },
        });
      }
    `);
  });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("/model model-shorthand/beta:high\n");
  await waitForOutput(session.read, "Model model-shorthand/beta · thinking high");
  session.child.stdin.write("verify shorthand\n");
  await waitForOutput(session.read, "shorthand response");
  assert.equal((await readFile(providerLog, "utf8")).trim(), "beta:high");
  const offset = session.read().length;
  session.child.stdin.write("/model coder\n");
  await waitForOutputAfter(session.read, offset, "is ambiguous; choose one of: model-shorthand/coder-v1, model-shorthand/coder-v2");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("interactive model selection and cycling scope survive a process restart", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let providerLog = "";
  let configPath = "";
  const first = await startChat([
    "--provider", "selection-restart",
    "--model", "alpha",
  ], async ({ root, config }) => {
    providerLog = join(root, "selection-restart.log");
    configPath = join(config, "rigyn", "config.jsonc");
    await writeFile(configPath, "{\n  // Keep this operator note.\n}\n");
    const extension = join(config, "rigyn", "extensions", "selection-restart");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "selection-restart",
      name: "Selection restart",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(providerLog)};
      export default function activate(api) {
        api.registerProvider({
          id: "selection-restart",
          async *stream(request) {
            const prompt = request.messages.filter((message) => message.role === "user")
              .flatMap((message) => message.content).filter((block) => block.type === "text").at(-1)?.text || "";
            await appendFile(log, request.model + ":" + (request.reasoningEffort || "off") + ":" + prompt + "\\n");
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "restart model " + request.model + ":" + (request.reasoningEffort || "off") + ":" + prompt };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() {
            const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
            const compatibility = { reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt: "2026-01-01T00:00:00.000Z" } };
            return ["alpha", "beta"].map((id) => ({
              id,
              provider: "selection-restart",
              capabilities: { tools: capability, reasoning: capability, images: capability },
              compatibility,
            }));
          },
        });
      }
    `);
  }, "full");
  let second: ReturnType<typeof launchChat> | undefined;
  t.after(async () => {
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
    if (second?.child.exitCode === null) second.child.kill("SIGKILL");
    await rm(first.root, { recursive: true, force: true });
  });

  await waitForOutput(first.read, "Rigyn v0.1.4 · Ready");
  first.child.stdin.write("first turn\r");
  await waitForOutput(first.read, "restart model alpha:off:first turn");
  first.child.stdin.write("\u001b[200~/model selection-restart/beta:high\u001b[201~\r");
  await waitForOutput(first.read, "Model selection-restart/beta · thinking high");
  first.child.stdin.write("\u001b[200~/scoped-models selection-restart/alpha:low,selection-restart/beta:high\u001b[201~\r");
  await waitForOutput(first.read, "Model cycling: selection-restart/alpha:low, selection-restart/beta:high");
  const cycleOffset = first.read().length;
  first.child.stdin.write("\u0010");
  await waitForOutputAfter(first.read, cycleOffset, "Model selection-restart/alpha");
  first.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(first), 0, first.read());
  assert.match(first.read(), /To resume this session: rigyn --session /u);

  const database = join(first.state, "rigyn", "sessions.sqlite");
  let store = new SessionStore(database);
  const threadId = store.listThreads({ workspaceRoot: first.workspace })[0]?.threadId;
  assert.ok(threadId);
  assert.deepEqual(store.getModelSelection(threadId), {
    provider: "selection-restart",
    model: "alpha",
    reasoningEffort: "low",
  });
  assert.deepEqual(
    store.listEvents(threadId)
      .filter((entry) => entry.event.type === "model_selected")
      .slice(-2)
      .map((entry) => entry.event.type === "model_selected" ? entry.event.reasoningEffort : undefined),
    ["high", "low"],
  );
  store.close();
  const persistedConfigSource = await readFile(configPath, "utf8");
  assert.match(persistedConfigSource, /\/\/ Keep this operator note\./u);
  assert.deepEqual(parseJsoncObject(persistedConfigSource, configPath).scopedModels, [
    "selection-restart/alpha:low",
    "selection-restart/beta:high",
  ]);

  second = launchChat({
    root: first.root,
    workspace: first.workspace,
    config: first.config,
    state: first.state,
  }, ["--thread", threadId], "full");
  await waitForOutput(second.read, "Rigyn v0.1.4 · Ready");
  second.child.stdin.write("second turn\r");
  await waitForOutput(second.read, "restart model alpha:low:second turn");
  assert.deepEqual((await readFile(providerLog, "utf8")).trim().split("\n"), [
    "alpha:off:first turn",
    "alpha:low:second turn",
  ]);

  second.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutput(second.read, "Auto-compact");
  const settingsCloseOffset = second.read().length;
  second.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(second.read, settingsCloseOffset, "alpha • low");
  second.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(second), 0, second.read());

  store = new SessionStore(database);
  assert.deepEqual(store.getModelSelection(threadId), {
    provider: "selection-restart",
    model: "alpha",
    reasoningEffort: "low",
  });
  store.close();
});

test("same-workspace resume restores each session's model thinking level", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let providerLog = "";
  const session = await startChat(["--thread", "thinking-high"], async ({ root, workspace, config, state }) => {
    providerLog = join(root, "session-thinking.log");
    await writeFile(join(config, "rigyn", "config.jsonc"), JSON.stringify({
      defaultProvider: "session-thinking",
      defaultModel: "fixture-model",
      thinking: "off",
    }));
    const extension = join(config, "rigyn", "extensions", "session-thinking");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "session-thinking",
      name: "Session thinking",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(providerLog)};
      export default function activate(api) {
        api.registerProvider({
          id: "session-thinking",
          async *stream(request) {
            await appendFile(log, request.reasoningEffort + "\\n");
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "thinking " + request.reasoningEffort };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() {
            const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
            const compatibility = { reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt: "2026-01-01T00:00:00.000Z" } };
            return [{ id: "fixture-model", provider: "session-thinking", capabilities: { tools: capability, reasoning: capability, images: capability }, compatibility }];
          },
        });
      }
    `);
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const store = new SessionStore(join(stateDirectory, "sessions.sqlite"));
    for (const [threadId, level] of [["thinking-high", "high"], ["thinking-low", "low"]] as const) {
      store.createThread({ threadId, name: threadId, workspaceRoot: workspace });
      store.appendEvent({
        threadId,
        event: {
          type: "message_appended",
          message: {
            id: `${threadId}-message`,
            role: "user",
            createdAt: new Date(0).toISOString(),
            content: [{ type: "text", text: `${threadId} history` }],
          },
        },
      });
      store.appendEvent({
        threadId,
        event: { type: "model_selected", provider: "session-thinking", model: "fixture-model", reasoningEffort: level },
      });
    }
    store.close();
  }, "accessible");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("first\n");
  await waitForOutput(session.read, "thinking high");
  session.child.stdin.write("/resume thinking-low\n");
  await waitForOutput(session.read, "Resumed thinking-low");
  session.child.stdin.write("second\n");
  await waitForOutput(session.read, "thinking low");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
  assert.deepEqual((await readFile(providerLog, "utf8")).trim().split("\n"), ["high", "low"]);
});

test("--fork clones the complete saved path before chat startup and -n names the copy", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let database = "";
  const session = await startChat(["--fork", "source-session", "-n", "Copied session"], async ({ workspace, state }) => {
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    database = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(database);
    store.createThread({ threadId: "source-session", name: "Source session", workspaceRoot: workspace });
    store.appendEvent({
      threadId: "source-session",
      event: {
        type: "message_appended",
        message: {
          id: "source-user-message",
          role: "user",
          createdAt: new Date(0).toISOString(),
          content: [{ type: "text", text: "retain this complete path" }],
        },
      },
    });
    store.close();
  }, "accessible");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());

  const store = new SessionStore(database);
  const threads = store.listThreads({ workspaceRoot: session.workspace });
  const copied = threads.find((thread) => thread.threadId !== "source-session");
  assert.ok(copied);
  assert.equal(copied.name, "Copied session");
  assert.equal(copied.parentThreadId, "source-session");
  assert.deepEqual(
    store.listEvents(copied.threadId).flatMap((entry) => entry.event.type === "message_appended"
      ? entry.event.message.content.flatMap((block) => block.type === "text" ? [block.text] : [])
      : []),
    ["retain this complete path"],
  );
  store.close();
});

test("a gated input reducer hands late steering to the normal dispatcher without loss", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let gate = "";
  let providerLog = "";
  const session = await startChat(["--provider", "active-race", "--model", "race-v1", "--no-session"], async ({ root, config }) => {
    gate = join(root, "release-input");
    providerLog = join(root, "race-provider.log");
    const extension = join(config, "rigyn", "extensions", "active-race");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "active-race",
      name: "Active race",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { access, appendFile } from "node:fs/promises";
      const gate = ${JSON.stringify(gate)};
      const providerLog = ${JSON.stringify(providerLog)};
      let gated = false;
      export default function activate(api) {
        api.on("input", async (event) => {
          if (event.text !== "late steering" || gated) return { action: "continue" };
          gated = true;
          while (true) {
            try { await access(gate); break; }
            catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
          }
          return { action: "continue" };
        });
        api.registerProvider({
          id: "active-race",
          async *stream(request) {
            const text = request.messages.filter((message) => message.role === "user")
              .flatMap((message) => message.content).filter((block) => block.type === "text").at(-1)?.text || "";
            await appendFile(providerLog, text + "\\n");
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: text === "late steering" ? "race-replayed" : "race-streaming" };
            if (text !== "late steering") await new Promise((resolve) => setTimeout(resolve, 120));
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() { return []; },
        });
      }
    `);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  const submit = (value: string) => session.child.stdin.write(`\u001b[200~${value}\u001b[201~\r`);
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  submit("begin race");
  await waitForOutput(session.read, "race-streaming");
  submit("late steering");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
  await writeFile(gate, "release\n");
  await waitForOutput(session.read, "Response finished; moved input to the normal dispatcher");
  await waitForOutput(session.read, "race-replayed");
  assert.deepEqual((await readFile(providerLog, "utf8")).trim().split("\n"), ["begin race", "late steering"]);
  submit("/exit");
  assert.equal(await finishChat(session), 0, session.read());
});

test("exact name and import commands prompt instead of falling through to the model", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let importPath = "";
  const session = await startChat([], async ({ root, workspace }) => {
    importPath = join(root, "session with spaces.jsonl");
    const source = new SessionStore(join(root, "source.sqlite"));
    try {
      const thread = source.createThread({
        threadId: "quoted-import-source",
        name: "quoted import",
        workspaceRoot: workspace,
      });
      await writeFile(importPath, source.exportThread(thread.threadId));
    } finally {
      source.close();
    }
  });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("/name\n");
  await waitForOutput(session.read, "Session name");
  session.child.stdin.write("Prompted name\n");
  await waitForOutput(session.read, "Named session Prompted name");
  session.child.stdin.write("/import\n");
  await waitForOutput(session.read, "Import JSONL path");
  session.child.stdin.write(`"${importPath}"\n`);
  await waitForOutput(session.read, "Imported");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("interactive export accepts --redact before a quoted Markdown path", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let outputPath = "";
  const session = await startChat(["--continue"], async ({ root, workspace, state }) => {
    outputPath = join(root, "share copy.md");
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const store = new SessionStore(join(stateDirectory, "sessions.sqlite"));
    try {
      const thread = store.createThread({ threadId: "interactive-private-thread-id", workspaceRoot: workspace });
      store.appendEvent({
        threadId: thread.threadId,
        event: {
          type: "message_appended",
          message: {
            id: "interactive-private-message-id",
            role: "user",
            createdAt: "2040-05-06T07:08:09.123Z",
            content: [{ type: "text", text: `Inspect ${workspace}/secret.ts with sk-proj-ABCDEFGHIJKLMNOP123456` }],
          },
        },
      });
    } finally {
      store.close();
    }
  });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "· Ready");
  session.child.stdin.write(`/export --redact "${outputPath}"\n`);
  await waitForFileOutput(outputPath, "Redacted share copy; review before publishing.");
  const share = await readFile(outputPath, "utf8");
  assert.match(share, /Inspect \[WORKSPACE\]\/secret\.ts with \[REDACTED\]/u);
  assert.doesNotMatch(share, /interactive-private-(?:thread|message)-id|2040-05-06|sk-proj-/u);
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("fresh chat starts model-less instead of forcing a setup wizard", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const session = await startChat();
  await waitForOutput(session.read, "Start: /login connects a provider");
  assert.doesNotMatch(session.read(), /Choose your first provider/u);
  session.child.stdin.write("hello\n");
  await waitForOutput(session.read, "No model selected. Run /login to connect a provider");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("an empty model picker explains /login and cancellation returns to chat", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], undefined, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write(Buffer.from([12]));
  await waitForOutput(session.read, "No available models. Use /login to connect a provider.");
  assert.doesNotMatch(session.read(), /Only showing models from configured providers/u);
  const cancellationOffset = session.read().length;
  session.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(session.read, cancellationOffset, "no-model");
  session.child.stdin.write("\u001b[200~/session\u001b[201~\r");
  await waitForOutputAfter(session.read, cancellationOffset, "Messages: 0 user · 0 assistant · 0 tool");
  assert.doesNotMatch(session.read().slice(cancellationOffset), /Selection cancelled/u);
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("environment auth does not expose unverified built-in models and the empty picker keeps chat alive", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], undefined, "full", { OPENAI_API_KEY: "sk-test" });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "No model connected");
  assert.equal(session.child.exitCode, null);

  session.child.stdin.write(Buffer.from([12]));
  await waitForOutput(session.read, "No available models. Use /login to connect a provider.");
  const cancellationOffset = session.read().length;
  session.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(session.read, cancellationOffset, "no-model");

  session.child.stdin.write("\u001b[200~/session\u001b[201~\r");
  await waitForOutput(session.read, "Messages: 0 user · 0 assistant · 0 tool");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("built-in ChatGPT subscription login is visible before authentication and offers browser or headless OAuth", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat();
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("/login\n");
  await waitForOutput(session.read, "Use a subscription");
  assert.doesNotMatch(session.read(), /ChatGPT, Claude, Copilot/u);
  session.child.stdin.write("\r");
  await waitForOutput(session.read, "Select subscription provider");
  await waitForOutput(session.read, "ChatGPT Plus/Pro (Codex Subscription)");
  await waitForOutput(session.read, "unconfigured");
  const methodsOffset = session.read().length;
  session.child.stdin.write("ChatGPT\n");
  await waitForOutputAfter(session.read, methodsOffset, "Connect openai-codex");
  await waitForOutputAfter(session.read, methodsOffset, "Browser login (default)");
  await waitForOutputAfter(session.read, methodsOffset, "Device code login (headless)");
  session.child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => session.child.once("exit", () => resolveExit()));
});

test("session command renders a human report instead of raw storage JSON", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const session = await startChat();
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("/session\n");
  await waitForOutput(session.read, "Messages: 0 user · 0 assistant · 0 tool");
  await waitForOutput(session.read, "Runs: 0 total · 0 completed");
  assert.doesNotMatch(session.read(), /"threadId"|"branches"/u);
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("scoped-model selector preserves the current scope when no catalog is available", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ config }) => {
    const directory = join(config, "rigyn");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.jsonc"), JSON.stringify({
      providers: { ollama: { kind: "ollama", host: "http://127.0.0.1:1" } },
    }));
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("\u001b[200~/scoped-models\u001b[201~\r");
  await waitForOutput(session.read, "No model catalog is available");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("missing provider credentials produce concise login guidance and leave chat usable", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat(["--provider", "openai", "--model", "gpt-5"]);
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Ready");
  session.child.stdin.write("hello\n");
  await waitForOutput(session.read, "openai is not connected. Run /login openai.");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("a provider failure is rendered once and the next command remains usable", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([
    "--provider", "failure-offline", "--model", "failure-v1", "--no-session",
  ], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "failure-offline");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "failure-offline",
      name: "Failure offline",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => api.registerProvider({
      id: "failure-offline",
      async *stream(request) {
        yield { type: "response_start", model: request.model };
        throw new Error("fixture network unavailable");
      },
      async listModels() { return []; },
    });\n`);
  }, "accessible");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  const failureOffset = session.read().length;
  session.child.stdin.write("fail once\n");
  await waitForOutputAfter(session.read, failureOffset, "fixture network unavailable");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 75));
  assert.doesNotMatch(session.read().slice(failureOffset), /Run failed:.*fixture network unavailable/u);
  session.child.stdin.write("/session\n");
  await waitForOutputAfter(session.read, failureOffset, "Runs: 1 total");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("a removed extension provider in saved defaults falls back to model-less chat", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const session = await startChat([], async ({ config }) => {
    const directory = join(config, "rigyn");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.jsonc"), JSON.stringify({
      defaultProvider: "removed-extension-provider",
      defaultModel: "removed-model",
    }));
  });
  await waitForOutput(session.read, "Start: /login connects a provider");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("an explicit provider does not inherit a model saved for another provider", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const session = await startChat(["--provider", "openai"], async ({ config }) => {
    const directory = join(config, "rigyn");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.jsonc"), JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "claude-saved-model",
    }));
  });
  await waitForOutput(session.read, "Start: /login connects a provider");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});

test("interactive extension sessions transition on /new and end in ephemeral mode", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  let lifecycleLog = "";
  const session = await startChat(["--no-session"], async ({ root, config }) => {
    lifecycleLog = join(root, "lifecycle.jsonl");
    const extension = join(config, "rigyn", "extensions", "lifecycle-test");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "lifecycle-test",
      name: "Lifecycle test",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(lifecycleLog)};
      export default function activate(api) {
        api.on("session_start", async (value) => appendFile(log, JSON.stringify({ event: "start", threadId: value.threadId }) + "\\n"));
        api.on("session_end", async (value) => appendFile(log, JSON.stringify({ event: "end", threadId: value.threadId }) + "\\n"));
      }
    `);
  });
  await waitForOutput(session.read, "Start: /login connects a provider");
  session.child.stdin.write("/new\n");
  await waitForOutput(session.read, "Session ");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
  const events = (await readFile(lifecycleLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { event: string; threadId: string });
  assert.deepEqual(events.map((entry) => entry.event), ["start", "end", "start", "end"]);
  assert.equal(events[0]?.threadId, events[1]?.threadId);
  assert.equal(events[2]?.threadId, events[3]?.threadId);
  assert.notEqual(events[0]?.threadId, events[2]?.threadId);
});

test("session-start extensions can register live commands and UI without reload", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "late-session");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "late-session",
      name: "Late session",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      let registered = false;
      api.on("session_start", () => {
        if (registered) return;
        registered = true;
        api.registerCommand({ name: "late-session", execute({ ui }) { ui.notify("late session command ran"); } });
        api.ui.setStatus("ready", "late session ready");
      });
    };\n`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "late session ready");
  session.child.stdin.write("\u001b[200~/late-session\u001b[201~\r");
  await waitForOutput(session.read, "late session command ran");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("runtime commands can own a bounded interactive component", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "component-command");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "component-command",
      name: "Component command",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      api.registerCommand({
        name: "component-command",
        async execute({ ui }) {
          const passive = ui.showOverlay(() => ({
            render() {
              return { lines: [{ spans: [{ text: "Passive extension overlay", role: "success" }], fill: true }] };
            },
          }), {
            overlayOptions: { anchor: "top-left", width: 30, maxHeight: 4, nonCapturing: true },
          });
          const value = await ui.custom((host) => ({
            render() {
              return { lines: [{ spans: [{ text: "Interactive extension component", role: "accent" }], fill: true }] };
            },
            handleKey(event) {
              if (event.key !== "text" || !event.text) return false;
              host.close(event.text);
              return true;
            },
          }), {
            overlay: true,
            overlayOptions: { anchor: "center", width: 40, maxHeight: 8 },
          });
          passive.close();
          await passive.result;
          ui.notify("Component result: " + value);
        },
      });
    };\n`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("\u001b[200~/component-command\u001b[201~\r");
  await waitForOutput(session.read, "Passive extension overlay");
  await waitForOutput(session.read, "Interactive extension component");
  session.child.stdin.write("x");
  await waitForOutput(session.read, "Component result: x");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("runtime command diagnostics are visible and Escape cancels hung commands and shortcuts", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "action-cancellation");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "action-cancellation",
      name: "Action cancellation",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      const waitForCancel = (context, label) => {
        context.ui.notify(label + " started");
        return new Promise((_, reject) => {
          const cancel = () => {
            context.ui.notify(label + " cancelled");
            reject(context.signal.reason || new Error(label + " cancelled"));
          };
          if (context.signal.aborted) cancel();
          else context.signal.addEventListener("abort", cancel, { once: true });
        });
      };
      api.registerCommand({ name: "broken-action", execute() { throw new Error("command boom"); } });
      api.registerCommand({ name: "hang-action", execute(context) { return waitForCancel(context, "hang command"); } });
      api.registerCommand({ name: "after-action", execute({ ui }) { ui.notify("after command ran"); } });
      api.registerShortcut({ shortcut: "ctrl+n", execute(context) { return waitForCancel(context, "hang shortcut"); } });
    };\n`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");

  session.child.stdin.write("\u001b[200~/broken-action\u001b[201~\r");
  await waitForOutput(session.read, "Runtime command handler failed");

  session.child.stdin.write("\u001b[200~/hang-action\u001b[201~\r");
  await waitForOutput(session.read, "hang command started");
  session.child.stdin.write("\u001b");
  await waitForOutput(session.read, "hang command cancelled");
  session.child.stdin.write("\u001b[200~/after-action\u001b[201~\r");
  await waitForOutput(session.read, "after command ran");

  const shortcutOffset = session.read().length;
  session.child.stdin.write("\u000e");
  await waitForOutputAfter(session.read, shortcutOffset, "hang shortcut started");
  session.child.stdin.write("\u001b");
  await waitForOutputAfter(session.read, shortcutOffset, "hang shortcut cancelled");
  const afterOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/after-action\u001b[201~\r");
  await waitForOutputAfter(session.read, afterOffset, "after command ran");

  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("Escape cancels awaited runtime event observers for agent runs and user shell events", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let cancellationLog = "";
  const session = await startChat([
    "--provider", "event-cancel", "--model", "event-cancel-model", "--no-session",
  ], async ({ root, config }) => {
    cancellationLog = join(root, "event-cancellation.log");
    const extension = join(config, "rigyn", "extensions", "event-cancel");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "event-cancel",
      name: "Event cancellation",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `import { appendFile } from "node:fs/promises";
    export default function activate(api) {
      let runBlocked = false;
      let shellBlocked = false;
      const wait = (context, label) => {
        context.ui.notify(label + " waiting");
        return new Promise((_, reject) => {
          const cancel = () => {
            appendFile(${JSON.stringify(cancellationLog)}, label + " cancelled\\n").then(
              () => reject(context.signal.reason || new Error(label + " cancelled")),
              reject,
            );
          };
          if (context.signal.aborted) cancel();
          else context.signal.addEventListener("abort", cancel, { once: true });
        });
      };
      api.on("event", (value, context) => {
        const type = value.event?.type || value.type;
        if (type === "run_started" && !runBlocked) {
          runBlocked = true;
          return wait(context, "run event observer");
        }
        if (type === "user_shell" && !shellBlocked) {
          shellBlocked = true;
          return wait(context, "shell event observer");
        }
      });
      api.registerProvider({
        id: "event-cancel",
        async *stream(request) {
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "provider completed" };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() { return [{ id: "event-cancel-model" }]; },
      });
    };
`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("start run\r");
  await waitForOutput(session.read, "run event observer waiting");
  session.child.stdin.write("\u001b");
  await waitForFileOutput(cancellationLog, "run event observer cancelled");
  await waitForOutput(session.read, "Cancelled:");

  session.child.stdin.write("!true\r");
  await waitForOutput(session.read, "shell event observer waiting");
  session.child.stdin.write("\u001b");
  await waitForFileOutput(cancellationLog, "shell event observer cancelled");

  session.child.stdin.write("/session\r");
  await waitForOutput(session.read, "Messages: 1 user");
  session.child.stdin.write("/resources\r");
  await waitForOutput(session.read, "Resource catalog");
  await waitForOutput(session.read, "Extensions: 1 · Active: 1");
  session.child.stdin.write("/exit\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("an extension-requested shutdown cancels an awaited run observer and exits", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let shutdownLog = "";
  const session = await startChat([
    "--provider", "shutdown-provider", "--model", "shutdown-model", "--no-session",
  ], async ({ root, config }) => {
    shutdownLog = join(root, "extension-shutdown.log");
    const extension = join(config, "rigyn", "extensions", "extension-shutdown");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "extension-shutdown",
      name: "Extension shutdown",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(shutdownLog)};
      export default function activate(api) {
        let requested = false;
        api.on("event", async (value, context) => {
          const type = value.event?.type || value.type;
          if (type !== "run_started" || requested) return;
          requested = true;
          await appendFile(log, "observer waiting\\n");
          context.ui.notify("shutdown observer waiting");
          const result = await api.requestShutdown({ reason: "extension shutdown regression" });
          if (!result.accepted) throw new Error("shutdown request was rejected");
          await new Promise((_, reject) => {
            const cancel = () => {
              appendFile(log, "observer aborted\\n").then(
                () => reject(context.signal.reason || new Error("observer aborted")),
                reject,
              );
            };
            if (context.signal.aborted) cancel();
            else context.signal.addEventListener("abort", cancel, { once: true });
          });
        });
        api.registerProvider({
          id: "shutdown-provider",
          async *stream(request) {
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "unexpected response" };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() { return [{ id: "shutdown-model" }]; },
        });
      }
    `);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("request shutdown\r");
  await waitForOutput(session.read, "shutdown observer waiting");
  await waitForFileOutput(shutdownLog, "observer waiting");
  assert.equal(await finishChat(session), 0, session.read());
  await waitForFileOutput(shutdownLog, "observer aborted");
});

test("Alt+Up restores a recovered image queue item for editing and sends every exact image once", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let requestLog = "";
  let databasePath = "";
  const embedded = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
  const remote = { type: "image" as const, mediaType: "image/jpeg", url: "https://images.example.test/recovered.jpg" };
  const session = await startChat([
    "--thread", "recovered-image-thread",
    "--provider", "recovered-image-provider",
    "--model", "recovered-image-model",
    "--all-tools",
  ], async ({ root, workspace, config, state }) => {
    requestLog = join(root, "recovered-request.jsonl");
    const extension = join(config, "rigyn", "extensions", "recovered-image-provider");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "recovered-image-provider",
      name: "Recovered image provider",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(requestLog)};
      export default function activate(api) {
        api.registerProvider({
          id: "recovered-image-provider",
          async *stream(request) {
            await appendFile(log, JSON.stringify(request.messages.at(-1)) + "\\n");
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "recovered images received" };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "recovered images received" } } };
          },
          async listModels() { return [{ id: "recovered-image-model" }]; },
        });
      }
    `);
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    databasePath = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(databasePath);
    store.createThread({ threadId: "recovered-image-thread", workspaceRoot: workspace });
    const queued = store.enqueueRunInput({
      threadId: "recovered-image-thread",
      branch: "main",
      mode: "follow_up",
      text: "recover me",
      images: [embedded, remote],
    });
    store.markRunInputRecoverable(queued.queueId, queued.threadId, queued.branch);
    store.close();
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Recovered 1 unsent queued message");
  session.child.stdin.write("\u001b[1;3A");
  await waitForOutput(session.read, "recovered 1 (embedded)");
  await waitForOutput(session.read, "recovered 2 (URL)");
  const leased = new SessionStore(databasePath);
  assert.equal(leased.database.prepare("SELECT state FROM run_input_queue").get()?.state, "leased");
  leased.close();
  session.child.stdin.write(" edited\r");
  await waitForOutput(session.read, "recovered images received");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());

  const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    content: Array<{ type: string; text?: string; data?: string; url?: string; mediaType?: string }>;
  });
  const user = requests[0]!;
  assert.deepEqual(user.content, [
    { type: "text", text: "recover me edited" },
    embedded,
    remote,
  ]);
  assert.equal(user.content.filter((block) => block.type === "image").length, 2);
  assert.equal(user.content.some((block) => block.type === "text" && block.text?.includes("[Attached image")), false);
  const acknowledged = new SessionStore(databasePath);
  assert.equal(acknowledged.database.prepare("SELECT count(*) AS count FROM run_input_queue").get()?.count, 0);
  acknowledged.close();
});

test("SIGKILL after Alt+Up returns the leased editor bundle to recovery on restart", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let databasePath = "";
  const first = await startChat(["--thread", "recovered-sigkill-thread"], async ({ workspace, state }) => {
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    databasePath = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(databasePath);
    store.createThread({ threadId: "recovered-sigkill-thread", workspaceRoot: workspace });
    store.appendEvent({
      threadId: "recovered-sigkill-thread",
      event: {
        type: "message_appended",
        message: {
          id: "sigkill-seed-message",
          role: "user",
          createdAt: new Date(0).toISOString(),
          content: [{ type: "text", text: "retain crash recovery fixture" }],
        },
      },
    });
    const queued = store.enqueueRunInput({
      threadId: "recovered-sigkill-thread",
      branch: "main",
      mode: "steer",
      text: "crash-safe editor draft",
      images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
    });
    store.markRunInputRecoverable(queued.queueId, queued.threadId, queued.branch);
    store.close();
  }, "full");
  t.after(() => { if (first.child.exitCode === null) first.child.kill("SIGKILL"); });
  await waitForOutput(first.read, "Recovered 1 unsent queued message");
  first.child.stdin.write("\u001b[1;3A");
  await waitForOutput(first.read, "recovered 1 (embedded)");
  const firstExit = finishChat(first);
  first.child.kill("SIGKILL");
  await firstExit;

  const second = launchChat(
    { root: first.root, workspace: first.workspace, config: first.config, state: first.state },
    ["--thread", "recovered-sigkill-thread"],
    "full",
  );
  t.after(() => { if (second.child.exitCode === null) second.child.kill("SIGKILL"); });
  await waitForOutput(second.read, "Recovered 1 unsent queued message");
  const store = new SessionStore(databasePath);
  assert.deepEqual(store.listRunInputs("recovered-sigkill-thread", "main", ["recoverable"]).map((entry) => ({
    mode: entry.mode,
    text: entry.text,
    images: entry.images,
  })), [{
    mode: "steer",
    text: "crash-safe editor draft",
    images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
  }]);
  store.close();
  const secondExit = finishChat(second);
  second.child.kill("SIGKILL");
  await secondExit;
});

test("full reload replaces extension commands and providers without replacing the session", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let runtimePath = "";
  let lifecycleLog = "";
  let reloadCancellationLog = "";
  let keybindingsPath = "";
  let configPath = "";
  const session = await startChat([
    "--thread", "reload-pty-thread",
    "--provider", "reload-offline",
    "--model", "reload-offline-v1",
    "--all-tools",
  ], async ({ root, workspace, config, state }) => {
    lifecycleLog = join(root, "reload-lifecycle.log");
    reloadCancellationLog = join(root, "reload-cancellation.log");
    const extension = join(config, "rigyn", "extensions", "reload-pty");
    keybindingsPath = join(config, "rigyn", "keybindings.json");
    configPath = join(config, "rigyn", "config.jsonc");
    runtimePath = join(extension, "runtime", "index.mjs");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "reload-pty",
      name: "Reload PTY",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeReloadRuntime(runtimePath, lifecycleLog, "v1");
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const store = new SessionStore(join(stateDirectory, "sessions.sqlite"));
    store.createThread({ threadId: "reload-pty-thread", name: "reload continuity", workspaceRoot: workspace });
    store.close();
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "reload v1 status");
  session.child.stdin.write("\u001b[200~/reload-demo first\u001b[201~\r");
  await waitForOutput(session.read, "v1 response v1:first");
  session.child.stdin.write("render-tool first\r");
  await waitForOutput(session.read, "v1 CUSTOM CALL render-tool first");
  await waitForOutput(session.read, "v1 CUSTOM RESULT v1 tool result render-tool first");

  await writeFile(runtimePath, `
    import { appendFile } from "node:fs/promises";
    export default async function activate(api) {
      await appendFile(${JSON.stringify(reloadCancellationLog)}, "started\\n");
      await new Promise((_, reject) => {
        const cancel = () => appendFile(${JSON.stringify(reloadCancellationLog)}, "cancelled\\n").then(
          () => reject(api.signal.reason || new Error("reload cancelled")),
          reject,
        );
        if (api.signal.aborted) cancel();
        else api.signal.addEventListener("abort", cancel, { once: true });
      });
    }
  `);
  session.child.stdin.write("\u001b[200~/reload\u001b[201~\r");
  await waitForOutput(session.read, "Reloading keybindings, extensions, skills, prompts, themes");
  await waitForFileOutput(reloadCancellationLog, "started");
  session.child.stdin.write("\u001b[27u");
  await waitForFileOutput(reloadCancellationLog, "cancelled");
  const rollbackOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/reload-demo retained\u001b[201~\r");
  await waitForOutputAfter(session.read, rollbackOffset, "v1 response v1:retained");

  await writeFile(runtimePath, `
    import { appendFile } from "node:fs/promises";
    export default async function activate(api) {
      await appendFile(${JSON.stringify(reloadCancellationLog)}, "self-started\\n");
      await new Promise((_, reject) => {
        const cancel = () => appendFile(${JSON.stringify(reloadCancellationLog)}, "self-cancelled\\n").then(
          () => reject(api.signal.reason || new Error("self reload cancelled")),
          reject,
        );
        if (api.signal.aborted) cancel();
        else api.signal.addEventListener("abort", cancel, { once: true });
      });
    }
  `);
  const selfReloadOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/self-reload\u001b[201~\r");
  await waitForOutputAfter(session.read, selfReloadOffset, "Reloading keybindings, extensions, skills, prompts, themes");
  await waitForFileOutput(reloadCancellationLog, "self-started");
  session.child.stdin.write("\u001b[27u");
  await waitForFileOutput(reloadCancellationLog, "self-cancelled");
  const selfRollbackOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/reload-demo still-retained\u001b[201~\r");
  await waitForOutputAfter(session.read, selfRollbackOffset, "v1 response v1:still-retained");

  await writeReloadRuntime(runtimePath, lifecycleLog, "v2");
  await writeFile(keybindingsPath, JSON.stringify({ "app.session.resume": ["alt+x"] }));
  session.child.stdin.write("\u001b[200~/self-reload\u001b[201~\r");
  await waitForOutput(session.read, "Reloaded keybindings, extensions, skills, prompts, themes");
  await waitForOutput(session.read, "reload v2 status");
  session.child.stdin.write("\u001b[200~/hotkeys\u001b[201~\r");
  await waitForOutput(session.read, "Sessions/transcript: Alt+X session picker");
  session.child.stdin.write("\u001bx");
  await waitForOutput(session.read, "Resume Session");
  session.child.stdin.write("\u001b[27u");
  session.child.stdin.write("\u001b[200~/reload-demo second\u001b[201~\r");
  await waitForOutput(session.read, "v2 response v2:second");
  session.child.stdin.write("render-tool second\r");
  await waitForOutput(session.read, "v2 CUSTOM CALL render-tool second");
  await waitForOutput(session.read, "v2 CUSTOM RESULT v2 tool result render-tool second");
  assert.doesNotMatch(session.read(), /v1 CUSTOM (?:CALL|RESULT).*render-tool second/u);
  await writeFile(configPath, "{ invalid reload config");
  session.child.stdin.write("\u001b[200~/reload\u001b[201~\r");
  await waitForOutput(session.read, "Command failed:");
  session.child.stdin.write("\u001b[200~/reload-demo rollback\u001b[201~\r");
  await waitForOutput(session.read, "v2 response v2:rollback");
  session.child.stdin.write("\u001b[200~/old-only\u001b[201~\r");
  await waitForOutput(session.read, "Unknown command: /old-only");
  session.child.stdin.write("\u001b[200~/new-only\u001b[201~\r");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
  assert.deepEqual((await readFile(lifecycleLog, "utf8")).trim().split("\n"), [
    "start:v1:initial",
    "end:v1:reload",
    "dispose:v1",
    "start:v2:reload",
    "end:v2:exit",
    "dispose:v2",
  ]);
});

test("scoped-model selector persists exact models and settings cancellation preserves them", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let configPath = "";
  const session = await startChat(["--provider", "scope-offline", "--model", "alpha"], async ({ config }) => {
    configPath = join(config, "rigyn", "config.jsonc");
    const extension = join(config, "rigyn", "extensions", "scope-offline");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "scope-offline",
      name: "Scope offline",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      api.registerProvider({
        id: "scope-offline",
        async *stream(request) {
          yield { type: "response_start", model: request.model };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() {
          const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
          return ["alpha", "beta"].map((id) => ({ id, provider: "scope-offline", capabilities: { tools: capability, reasoning: capability, images: capability } }));
        },
      });
    };\n`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  const closeOverlay = async (): Promise<void> => {
    const offset = session.read().length;
    session.child.stdin.write("\u001b[27u");
    await waitForOutputAfter(session.read, offset, "alpha • thinking off");
  };
  session.child.stdin.write("\u001b[200~/scoped-models\u001b[201~\r");
  await waitForOutput(session.read, "Scoped Models");
  session.child.stdin.write("beta\r");
  session.child.stdin.write(Buffer.from([19]));
  await waitForOutput(session.read, "Saved model cycling defaults");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).scopedModels, ["scope-offline/alpha"]);
  await closeOverlay();

  let settingsOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(session.read, settingsOffset, "Auto-compact");
  session.child.stdin.write("Steering mode\r");
  await waitForOutputAfter(session.read, settingsOffset, "Steering mode  all");
  await waitForFileOutput(configPath, '"steeringMode": "all"');
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).steeringMode, "all");
  await closeOverlay();

  settingsOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(session.read, settingsOffset, "Auto-compact");
  session.child.stdin.write("Follow-up mode\r");
  await waitForOutputAfter(session.read, settingsOffset, "Follow-up mode  all");
  await waitForFileOutput(configPath, '"followUpMode": "all"');
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).followUpMode, "all");
  await closeOverlay();

  settingsOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(session.read, settingsOffset, "Double-Escape action");
  session.child.stdin.write("Double-Escape action\r");
  await waitForOutputAfter(session.read, settingsOffset, "Double-Escape action  fork");
  await waitForFileOutput(configPath, '"doubleEscapeAction": "fork"');
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).doubleEscapeAction, "fork");
  await closeOverlay();

  settingsOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(session.read, settingsOffset, "ChatGPT transport");
  session.child.stdin.write("ChatGPT transport\r");
  await waitForOutputAfter(session.read, settingsOffset, "ChatGPT transport  websocket-cached");
  await waitForFileOutput(configPath, '"transport": "websocket-cached"');
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).providers["openai-codex"].transport, "websocket-cached");
  await closeOverlay();

  settingsOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(session.read, settingsOffset, "Provider retry attempts");
  session.child.stdin.write("Provider retry attempts\r");
  await waitForOutputAfter(session.read, settingsOffset, "Provider retry attempts  4");
  await waitForFileOutput(configPath, '"maxAttempts": 4');
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).providerRetry.maxAttempts, 4);
  await closeOverlay();

  settingsOffset = session.read().length;
  session.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(session.read, settingsOffset, "Project trust default");
  session.child.stdin.write("Project trust default\r");
  await waitForOutputAfter(session.read, settingsOffset, "Project trust default  always");
  await waitForFileOutput(configPath, '"defaultProjectTrust": "always"');
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).defaultProjectTrust, "always");
  await closeOverlay();
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).scopedModels, ["scope-offline/alpha"]);
});

test("settings apply auto-compaction and outbound-image choices immediately and after restart", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let configPath = "";
  let providerLog = "";
  let imagePath = "";
  const argumentsValue = ["--provider", "settings-live", "--model", "fixture", "--no-session"];
  const first = await startChat(argumentsValue, async ({ root, workspace, config }) => {
    configPath = join(config, "rigyn", "config.jsonc");
    providerLog = join(root, "settings-live.log");
    imagePath = join(workspace, "fixture.bmp");
    await writeFile(imagePath, clipboardBmp());
    const extension = join(config, "rigyn", "extensions", "settings-live");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "settings-live",
      name: "Settings live",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const log = ${JSON.stringify(providerLog)};
      export default (api) => api.registerProvider({
        id: "settings-live",
        async *stream(request) {
          const blocks = request.messages.flatMap((message) => message.content);
          const text = blocks.filter((block) => block.type === "text").at(-1)?.text || "";
          await appendFile(log, "images=" + blocks.filter((block) => block.type === "image").length + ":" + text + "\\n");
          yield { type: "response_start", model: request.model };
          if (text.includes("overflow")) {
            yield { type: "response_end", reason: "context_limit", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
            return;
          }
          yield { type: "text_delta", part: 0, text: "settings-live-response" };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "settings-live-response" } } };
        },
        async listModels() {
          const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
          return [{ id: "fixture", provider: "settings-live", capabilities: { tools: capability, reasoning: capability, images: capability } }];
        },
      });
    `);
  }, "full");
  t.after(() => { if (first.child.exitCode === null) first.child.kill("SIGKILL"); });
  await waitForOutput(first.read, "Rigyn v0.1.4 · Ready");

  first.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutput(first.read, "Auto-compact");
  first.child.stdin.write("Auto-compact\r");
  await waitForOutput(first.read, "Auto-compact  false");
  await waitForFileOutput(configPath, '"autoCompaction": false');
  const autoCompactCloseOffset = first.read().length;
  first.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(first.read, autoCompactCloseOffset, "fixture • thinking off");

  const outboundOffset = first.read().length;
  first.child.stdin.write("\u001b[200~/settings\u001b[201~\r");
  await waitForOutputAfter(first.read, outboundOffset, "Auto-compact");
  first.child.stdin.write("Block images\r");
  await waitForOutputAfter(first.read, outboundOffset, "Block images  true");
  await waitForFileOutput(configPath, '"outboundImages": "block"');
  const outboundCloseOffset = first.read().length;
  first.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(first.read, outboundCloseOffset, "fixture • thinking off");

  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.autoCompaction, false);
  assert.equal(persisted.outboundImages, "block");

  const overflowOffset = first.read().length;
  first.child.stdin.write("\u001b[200~overflow now\u001b[201~\r");
  await waitForOutputAfter(first.read, overflowOffset, "automatic compaction is disabled");
  const imageOffset = first.read().length;
  first.child.stdin.write(`\u001b[200~inspect @"${imagePath}"\u001b[201~\r`);
  await waitForOutputAfter(first.read, imageOffset, "settings-live-response");
  assert.match(await readFile(providerLog, "utf8"), /images=0:\[Image omitted: image\/png\]/u);

  first.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(first), 0, first.read());

  const second = launchChat({
    root: first.root,
    workspace: first.workspace,
    config: first.config,
    state: first.state,
  }, argumentsValue, "full");
  t.after(() => { if (second.child.exitCode === null) second.child.kill("SIGKILL"); });
  await waitForOutput(second.read, "Rigyn v0.1.4 · Ready");
  const restartOffset = second.read().length;
  second.child.stdin.write("\u001b[200~overflow after restart\u001b[201~\r");
  await waitForOutputAfter(second.read, restartOffset, "automatic compaction is disabled");
  second.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(second), 0, second.read());
});

test("scoped-model reorder persists cycle order and drives forward and backward cycling", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let configPath = "";
  const session = await startChat(["--provider", "scope-order", "--model", "alpha"], async ({ config }) => {
    const directory = join(config, "rigyn");
    configPath = join(directory, "config.jsonc");
    const extension = join(directory, "extensions", "scope-order");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      scopedModels: ["scope-order/alpha", "scope-order/beta", "scope-order/gamma"],
    }));
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "scope-order",
      name: "Scope order",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      api.registerProvider({
        id: "scope-order",
        async *stream(request) {
          yield { type: "response_start", model: request.model };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() {
          const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
          return ["alpha", "beta", "gamma"].map((id) => ({ id, provider: "scope-order", capabilities: { tools: capability, reasoning: capability, images: capability } }));
        },
      });
    };\n`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("\u001b[200~/scoped-models\u001b[201~\r");
  await waitForOutput(session.read, "Alt+↑/Alt+↓ reorder");
  session.child.stdin.write("beta");
  session.child.stdin.write("\u001b[1;3A");
  await waitForOutput(session.read, "Moved scope-order/beta up");
  session.child.stdin.write(Buffer.from([19]));
  await waitForOutput(session.read, "Saved model cycling defaults");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).scopedModels, [
    "scope-order/beta", "scope-order/alpha", "scope-order/gamma",
  ]);
  const closeOffset = session.read().length;
  session.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(session.read, closeOffset, "alpha • thinking off");

  let offset = session.read().length;
  session.child.stdin.write(Buffer.from([16]));
  await waitForOutputAfter(session.read, offset, "Model scope-order/gamma");
  offset = session.read().length;
  session.child.stdin.write("\u001b[112;6u");
  await waitForOutputAfter(session.read, offset, "Model scope-order/alpha");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("accessible scoped-model configuration retains the text fallback", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let configPath = "";
  const session = await startChat([], async ({ config }) => {
    configPath = join(config, "rigyn", "config.jsonc");
  });
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Start: /login connects a provider");
  session.child.stdin.write("/scoped-models\n");
  await waitForOutput(session.read, "Model patterns (comma separated; empty/all = all, none = none)");
  session.child.stdin.write("none\n");
  await waitForOutput(session.read, "Model cycling has no enabled models");
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).scopedModels, ["!none"]);
});

test("reload is deferred while a response is streaming and runs through the normal dispatcher", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([
    "--provider", "slow-offline",
    "--model", "slow-offline-model",
  ], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "slow-reload");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "slow-reload",
      name: "Slow reload",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { setTimeout as wait } from "node:timers/promises";
      export default function activate(api) {
        api.registerProvider({
          id: "slow-offline",
          async *stream(request) {
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "streaming started" };
            await wait(500, undefined, { signal: request.signal });
            yield { type: "text_delta", part: 0, text: " and finished" };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() { return []; },
        });
      }
    `);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Ready");
  session.child.stdin.write("\u001b[200~start\u001b[201~\r");
  await waitForOutput(session.read, "streaming started");
  session.child.stdin.write("\u001b[200~/reload\u001b[201~\r");
  await waitForOutput(session.read, "Deferred command until the response finishes");
  await waitForOutput(session.read, "and finished");
  await waitForOutput(session.read, "Reloaded keybindings, extensions, skills, prompts, themes");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("trust followed by reload activates project runtime resources without restarting chat", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ workspace }) => {
    const extension = join(workspace, ".rigyn", "extensions", "trusted-reload");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "trusted-reload",
      name: "Trusted reload",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      api.registerCommand({ name: "trusted-probe", execute({ ui }) { ui.notify("trusted project command active"); } });
      api.ui.setStatus("ready", "trusted project extension active");
    };\n`);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Project resources found");
  session.child.stdin.write("\u001b[B\u001b[B\u001b[B\u001b[B\r");
  await waitForOutput(session.read, "Start: /login connects a provider");
  assert.doesNotMatch(session.read(), /trusted project extension active/u);
  session.child.stdin.write("\u001b[200~/trust\u001b[201~\r");
  await waitForOutput(session.read, "Workspace trusted. Run /reload");
  session.child.stdin.write("\u001b[200~/reload\u001b[201~\r");
  await waitForOutput(session.read, "trusted project extension active");
  await waitForOutput(session.read, "Reloaded keybindings, extensions, skills, prompts, themes");
  session.child.stdin.write("\u001b[200~/trusted-probe\u001b[201~\r");
  await waitForOutput(session.read, "trusted project command active");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("startup project approval persists exact workspace trust", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([], async ({ workspace }) => {
    await mkdir(join(workspace, ".rigyn"), { recursive: true });
    await writeFile(join(workspace, ".rigyn", "config.jsonc"), "{}\n");
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Project resources found");
  session.child.stdin.write("\r");
  await waitForOutput(session.read, "Start: /login connects a provider");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
  assert.equal(
    await new TrustStore(join(session.config, "rigyn", "trusted-workspaces.json")).isTrusted(session.workspace),
    true,
  );
});

test("startup project decline persists across a fresh process", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const first = await startChat([], async ({ workspace }) => {
    await mkdir(join(workspace, ".rigyn"), { recursive: true });
    await writeFile(join(workspace, ".rigyn", "config.jsonc"), "{}\n");
  }, "full");
  t.after(() => {
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
  });

  await waitForOutput(first.read, "Project resources found");
  first.child.stdin.write("\u001b[B\u001b[B\u001b[B\r");
  await waitForOutput(first.read, "Start: /login connects a provider");
  first.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(first), 0, first.read());
  const store = new TrustStore(join(first.config, "rigyn", "trusted-workspaces.json"));
  assert.equal(await store.decision(first.workspace), false);

  const second = launchChat({
    root: first.root,
    workspace: first.workspace,
    config: first.config,
    state: first.state,
  }, [], "full");
  t.after(() => {
    if (second.child.exitCode === null) second.child.kill("SIGKILL");
  });
  await waitForOutput(second.read, "Start: /login connects a provider");
  assert.doesNotMatch(second.read(), /Project resources found/u);
  second.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(second), 0, second.read());
});

test("full-TUI tree navigation folds, toggles paths, and selects a sibling branch", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let database = "";
  const session = await startChat(["--thread", "tree-sibling"], async ({ workspace, state }) => {
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    database = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(database);
    store.createThread({ threadId: "tree-sibling", workspaceRoot: workspace });
    const root = store.appendEvent({
      threadId: "tree-sibling",
      eventId: "tree-root",
      event: { type: "message_appended", message: { id: "root-message", role: "user", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Root prompt" }] } },
    });
    store.appendEvent({
      threadId: "tree-sibling",
      eventId: "tree-main",
      event: { type: "message_appended", message: { id: "main-message", role: "user", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Main prompt" }] } },
    });
    store.forkBranch({ threadId: "tree-sibling", newBranch: "sibling", atEventId: root.eventId });
    store.appendEvent({
      threadId: "tree-sibling",
      branch: "sibling",
      eventId: "tree-sibling-user",
      event: { type: "message_appended", message: { id: "sibling-message", role: "user", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Sibling prompt" }] } },
    });
    store.close();
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Start: /login connects a provider");
  session.child.stdin.write("\u001b[200~/tree\u001b[201~\r");
  await waitForOutput(session.read, "Session Tree · default · All paths");
  session.child.stdin.write("\u001b[A");
  session.child.stdin.write("\u001b[1;5D");
  await waitForOutput(session.read, "Folded tree-root");
  session.child.stdin.write("\u001b[1;5C");
  await waitForOutput(session.read, "Unfolded tree-root");
  session.child.stdin.write(Buffer.from([16]));
  await waitForOutput(session.read, "Showing the active path");
  session.child.stdin.write(Buffer.from([16]));
  await waitForOutput(session.read, "Showing every branch");
  session.child.stdin.write("\u001b[1;5C");
  await waitForOutput(session.read, "Endpoint: main");
  session.child.stdin.write("\u001b[1;5C");
  await waitForOutput(session.read, "Endpoint: sibling");
  session.child.stdin.write("\r");
  await waitForOutput(session.read, "Summarize abandoned branch?");
  session.child.stdin.write("\r");
  await waitForOutput(session.read, "Moved before tree-sibling-user");
  session.child.stdin.write("\r");
  await waitForOutput(session.read, "No model selected. Run /login to connect a provider");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
  const store = new SessionStore(database);
  const branch = store.listBranches("tree-sibling").find((entry) => entry.name.startsWith("tree-"));
  assert.equal(branch?.headEventId, "tree-root");
  store.close();
});

test("full-TUI tree navigation can attach an offline abandoned-branch summary", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let database = "";
  const session = await startChat(["--thread", "tree-summary-pty"], async ({ workspace, config, state }) => {
    const configDirectory = join(config, "rigyn");
    const extension = join(configDirectory, "extensions", "tree-summary-offline");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(configDirectory, "config.jsonc"), JSON.stringify({
      defaultProvider: "tree-summary-offline",
      defaultModel: "offline-model",
    }));
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "tree-summary-offline",
      name: "Tree summary offline",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
      api.registerProvider({
        id: "tree-summary-offline",
        async *stream(request) {
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "Offline summary retained the main branch decision." };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "Offline summary retained the main branch decision." } } };
        },
        async listModels() { return []; },
      });
    };\n`);
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    database = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(database);
    store.createThread({ threadId: "tree-summary-pty", workspaceRoot: workspace });
    const root = store.appendEvent({
      threadId: "tree-summary-pty",
      eventId: "pty-summary-root",
      event: { type: "message_appended", message: { id: "pty-root-message", role: "user", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Root prompt" }] } },
    });
    store.appendEvent({
      threadId: "tree-summary-pty",
      eventId: "pty-summary-main",
      event: { type: "message_appended", message: { id: "pty-main-message", role: "assistant", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Main branch decision" }] } },
    });
    store.forkBranch({ threadId: "tree-summary-pty", newBranch: "sibling", atEventId: root.eventId });
    store.appendEvent({
      threadId: "tree-summary-pty",
      branch: "sibling",
      eventId: "pty-summary-sibling",
      event: { type: "message_appended", message: { id: "pty-sibling-message", role: "user", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Sibling prompt" }] } },
    });
    store.close();
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "offline-model");
  await waitForOutput(session.read, "Rigyn v0.1.4 · Ready");
  session.child.stdin.write("\u001b[200~/tree\u001b[201~\r");
  await waitForOutput(session.read, "Session Tree · default · All paths");
  session.child.stdin.write("\u001b[1;5C");
  await waitForOutput(session.read, "Endpoint: sibling");
  session.child.stdin.write("\r");
  await waitForOutput(session.read, "Summarize abandoned branch?");
  session.child.stdin.write("\u001b[B\r");
  await waitForOutput(session.read, "Abandoned context was summarized");
  session.child.stdin.write(Buffer.from([21]));
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());

  const store = new SessionStore(database);
  const branch = store.listBranches("tree-summary-pty").find((entry) => entry.name.startsWith("tree-"));
  assert.ok(branch);
  const summary = store.listEvents("tree-summary-pty", branch.name).find((entry) => entry.event.type === "branch_summary_created");
  assert.equal(summary?.event.type, "branch_summary_created");
  if (summary?.event.type === "branch_summary_created") {
    assert.deepEqual(summary.event.sourceEventIds, ["pty-summary-main"]);
    const text = summary.event.summary.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    assert.match(text, /Offline summary retained the main branch decision/u);
  }
  store.close();
});

test("entry labels survive a full-TUI process restart and can be filtered, timestamped, and cleared", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let database = "";
  const first = await startChat(["--thread", "label-restart"], async ({ workspace, state }) => {
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    database = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(database);
    store.createThread({ threadId: "label-restart", workspaceRoot: workspace });
    store.appendEvent({
      threadId: "label-restart",
      eventId: "label-root",
      event: { type: "message_appended", message: { id: "label-root-message", role: "user", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Root prompt" }] } },
    });
    store.appendEvent({
      threadId: "label-restart",
      eventId: "label-leaf",
      event: { type: "message_appended", message: { id: "label-leaf-message", role: "assistant", createdAt: new Date(0).toISOString(), content: [{ type: "text", text: "Leaf answer" }] } },
    });
    store.close();
  }, "full");
  t.after(() => { if (first.child.exitCode === null) first.child.kill("SIGKILL"); });
  await waitForOutput(first.read, "Start: /login connects a provider");
  first.child.stdin.write("\u001b[200~/tree\u001b[201~\r");
  await waitForOutput(first.read, "Session Tree · default · All paths");
  first.child.stdin.write("\u001b[A");
  first.child.stdin.write("L");
  await waitForOutput(first.read, "Add entry label");
  first.child.stdin.write("restart bookmark\r");
  await waitForOutput(first.read, "Labeled label-root: restart bookmark");
  const firstCloseOffset = first.read().length;
  first.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(first.read, firstCloseOffset, "no-model");
  first.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(first), 0, first.read());

  const second = launchChat({ root: first.root, workspace: first.workspace, config: first.config, state: first.state }, ["--thread", "label-restart"], "full");
  t.after(() => { if (second.child.exitCode === null) second.child.kill("SIGKILL"); });
  await waitForOutput(second.read, "Start: /login connects a provider");
  second.child.stdin.write("\u001b[200~/tree\u001b[201~\r");
  await waitForOutput(second.read, "[restart bookmark] Root prompt");
  second.child.stdin.write(Buffer.from([12]));
  await waitForOutput(second.read, "Session Tree · labeled-only · All paths");
  second.child.stdin.write("T");
  await waitForOutput(second.read, "Label timestamps shown");
  second.child.stdin.write("L");
  await waitForOutput(second.read, "Edit entry label");
  second.child.stdin.write(Buffer.from([21]));
  second.child.stdin.write("\r");
  await waitForOutput(second.read, "Removed label from label-root");
  const secondCloseOffset = second.read().length;
  second.child.stdin.write("\u001b[27u");
  await waitForOutputAfter(second.read, secondCloseOffset, "no-model");
  second.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(second), 0, second.read());

  const reopened = new SessionStore(database);
  assert.deepEqual(reopened.listEntryLabels("label-restart"), []);
  reopened.close();
});

test("queued follow-ups can be restored with Alt+Up and Escape restores before cancellation", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const session = await startChat([
    "--provider", "queue-offline", "--model", "queue-offline-v1", "--no-session",
  ], async ({ config }) => {
    const extension = join(config, "rigyn", "extensions", "queue-offline");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "queue-offline",
      name: "Queue offline",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      export default function activate(api) {
        api.registerProvider({
          id: "queue-offline",
          async *stream(request, signal) {
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "streaming" };
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5000);
              const cancel = () => { clearTimeout(timer); reject(signal.reason); };
              if (signal.aborted) cancel();
              else signal.addEventListener("abort", cancel, { once: true });
            });
            yield { type: "text_delta", part: 0, text: " finished" };
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() { return []; },
        });
      }
    `);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Ready");
  session.child.stdin.write("\u001b[200~start run\u001b[201~\r");
  await waitForOutput(session.read, "streaming");
  session.child.stdin.write("\u001b[200~queued follow-up\u001b[201~\u001b\r");
  await waitForOutput(session.read, "Follow-up: queued follow-up");
  session.child.stdin.write("\u001b[1;3A");
  await waitForOutput(session.read, "Restored 1 queued message to the editor");
  session.child.stdin.write("\u001b\r");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  session.child.stdin.write("\u001b");
  await waitForOutput(session.read, "Cancelled: cancelled from terminal");
  session.child.stdin.write(Buffer.from([3]));
  session.child.stdin.write(Buffer.from([4]));
  assert.equal(await finishChat(session), 0, session.read());
});

test("Escape restores an active run's durable queue only after cancellation recovery completes", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let databasePath = "";
  let abortLog = "";
  const session = await startChat([
    "--thread", "cancel-queue-recovery",
    "--provider", "cancel-queue-provider",
    "--model", "cancel-queue-model",
  ], async ({ root, workspace, config, state }) => {
    databasePath = join(state, "rigyn", "sessions.sqlite");
    abortLog = join(root, "cancel-observed.log");
    await mkdir(join(state, "rigyn"), { recursive: true, mode: 0o700 });
    const store = new SessionStore(databasePath);
    store.createThread({ threadId: "cancel-queue-recovery", workspaceRoot: workspace });
    store.close();
    const extension = join(config, "rigyn", "extensions", "cancel-queue-provider");
    await mkdir(join(extension, "runtime"), { recursive: true });
    await writeFile(join(extension, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "cancel-queue-provider",
      name: "Cancel queue provider",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(extension, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      const abortLog = ${JSON.stringify(abortLog)};
      export default function activate(api) {
        api.registerProvider({
          id: "cancel-queue-provider",
          async *stream(request, signal) {
            yield { type: "response_start", model: request.model };
            yield { type: "text_delta", part: 0, text: "waiting for cancellation" };
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5000);
              const cancel = () => {
                clearTimeout(timer);
                void appendFile(abortLog, "abort observed\\n").then(() => {
                  setTimeout(() => reject(signal.reason), 300);
                }, reject);
              };
              if (signal.aborted) cancel();
              else signal.addEventListener("abort", cancel, { once: true });
            });
            yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
          },
          async listModels() { return []; },
        });
      }
    `);
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });

  await waitForOutput(session.read, "Ready");
  session.child.stdin.write("\u001b[200~start cancellable run\u001b[201~\r");
  await waitForOutput(session.read, "waiting for cancellation");
  session.child.stdin.write("\u001b[200~restore after cancel\u001b[201~\u001b\r");
  await waitForOutput(session.read, "Follow-up: restore after cancel");
  session.child.stdin.write("\u001b");

  const abortDeadline = Date.now() + 10_000;
  while (Date.now() < abortDeadline) {
    try {
      if ((await readFile(abortLog, "utf8")).includes("abort observed")) break;
    } catch {}
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.ok((await readFile(abortLog, "utf8")).includes("abort observed"));
  const cancelling = new SessionStore(databasePath);
  assert.deepEqual(cancelling.database.prepare("SELECT state, text FROM run_input_queue ORDER BY queue_sequence").all()
    .map((row) => ({ state: row.state, text: row.text })), [
    { state: "queued", text: "restore after cancel" },
  ]);
  cancelling.close();

  await waitForOutput(session.read, "Cancelled: cancelled from terminal");
  await waitForOutput(session.read, "Restored 1 queued message to the editor after cancellation");
  session.child.stdin.write(Buffer.from([21]));
  session.child.stdin.write(Buffer.from([4]));
  assert.equal(await finishChat(session), 0, session.read());
  const recovered = new SessionStore(databasePath);
  assert.deepEqual(recovered.database.prepare("SELECT state, text FROM run_input_queue ORDER BY queue_sequence").all()
    .map((row) => ({ state: row.state, text: row.text })), [
    { state: "recoverable", text: "restore after cancel" },
  ]);
  recovered.close();
});

test("session picker rename and delete actions mutate SQLite without leaving the picker", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let database = "";
  const session = await startChat(["--thread", "current-session"], async ({ workspace, state }) => {
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    database = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(database);
    for (const [threadId, name] of [
      ["rename-session", "rename-me"],
      ["delete-session", "delete-me"],
      ["current-session", "current-session"],
    ] as const) {
      store.createThread({ threadId, name, workspaceRoot: workspace });
      store.appendEvent({
        threadId,
        event: {
          type: "message_appended",
          message: {
            id: `${threadId}-message`,
            role: "user",
            createdAt: new Date(0).toISOString(),
            content: [{ type: "text", text: `${name} prompt` }],
          },
        },
      });
    }
    store.close();
  }, "full");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Start: /login connects a provider");

  session.child.stdin.write("\u001b[200~/resume\u001b[201~\r");
  await waitForOutput(session.read, "Resume Session");
  const renameOffset = session.read().length;
  session.child.stdin.write("\u001b[200~rename-me\u001b[201~\u0012\u0015\u001b[200~renamed-session\u001b[201~\r");
  const inspection = new SessionStore(database);
  t.after(() => inspection.close());
  const renameDeadline = Date.now() + 5_000;
  while (inspection.getThread("rename-session").name !== "renamed-session") {
    if (Date.now() >= renameDeadline) throw new Error(`Timed out waiting for session rename:\n${session.read()}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  await waitForOutputAfter(session.read, renameOffset, "Renamed session to renamed-session");

  const deleteSearchOffset = session.read().length;
  session.child.stdin.write("\u0015\u001b[200~delete-me\u001b[201~");
  await waitForOutputAfter(session.read, deleteSearchOffset, "> delete-me");
  assert.equal(inspection.getThread("delete-session").name, "delete-me");
  assert.equal(inspection.getThread("rename-session").name, "renamed-session");

  const deletePromptOffset = session.read().length;
  session.child.stdin.write("\u0004");
  await waitForOutputAfter(session.read, deletePromptOffset, "Delete “delete-me”?");
  session.child.stdin.write("\r");
  const deleteDeadline = Date.now() + 5_000;
  let deleted = false;
  while (!deleted) {
    try {
      inspection.getThread("delete-session");
    } catch (error) {
      if (error instanceof Error && /Unknown thread/u.test(error.message)) deleted = true;
      else throw error;
    }
    if (deleted) break;
    if (Date.now() >= deleteDeadline) throw new Error(`Timed out waiting for session deletion:\n${session.read()}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(inspection.getThread("rename-session").name, "renamed-session");
  assert.equal(inspection.getThread("current-session").name, "current-session");

  await waitForOutputAfter(session.read, deletePromptOffset, "Deleted session delete-me");
  session.child.stdin.write("\u001b[27u");
  session.child.stdin.write("\u001b[200~/exit\u001b[201~\r");
  assert.equal(await finishChat(session), 0, session.read());
});

test("typed resume accepts a unique partial name and rejects ambiguous matches in a real PTY", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let database = "";
  const session = await startChat(["--thread", "current-session"], async ({ workspace, state }) => {
    const stateDirectory = join(state, "rigyn");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    database = join(stateDirectory, "sessions.sqlite");
    const store = new SessionStore(database);
    for (const [threadId, name] of [
      ["current-session", "Current"],
      ["thread_parser_cleanup", "Parser cleanup"],
      ["thread_shared_one", "Shared work one"],
      ["thread_shared_two", "Shared work two"],
    ] as const) {
      store.createThread({ threadId, name, workspaceRoot: workspace });
      store.appendEvent({
        threadId,
        event: {
          type: "message_appended",
          message: {
            id: `${threadId}-message`,
            role: "user",
            createdAt: new Date(0).toISOString(),
            content: [{ type: "text", text: `${name} prompt` }],
          },
        },
      });
    }
    store.close();
  }, "accessible");
  t.after(() => { if (session.child.exitCode === null) session.child.kill("SIGKILL"); });
  await waitForOutput(session.read, "Ready");

  session.child.stdin.write("/resume parser clean\n");
  await waitForOutput(session.read, "Resumed thread_parser_cleanup");
  const beforeAmbiguous = session.read().length;
  session.child.stdin.write("/resume shared work\n");
  await waitForOutputAfter(session.read, beforeAmbiguous, "is ambiguous");

  const inspection = new SessionStore(database);
  assert.equal(inspection.listThreads().length, 4);
  inspection.close();
  session.child.stdin.write("/exit\n");
  assert.equal(await finishChat(session), 0, session.read());
});
