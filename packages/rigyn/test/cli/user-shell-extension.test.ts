import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, failure: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
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

test("user_bash replaces or handles shortcuts without breaking hidden transcript semantics", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-user-shell-extension-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const state = join(root, "state");
  const nested = join(workspace, "nested");
  const visibleMarker = join(workspace, "visible-original.txt");
  const hiddenMarker = join(workspace, "hidden-original.txt");
  const transformedOriginalMarker = join(workspace, "transform-original.txt");
  const transformedMarker = join(nested, "transformed.txt");
  const postLog = join(root, "user-shell-events.jsonl");
  const extension = join(agentDirectory, "extensions", "user-shell-interceptor");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(nested, { mode: 0o700 });
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(extension, "extensions"), { recursive: true, mode: 0o700 });
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "user-shell-interceptor",
    version: "1.0.0",
    type: "module",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(extension, "extensions", "index.mjs"), `import { appendFile, writeFile } from "node:fs/promises";
    export default function activate(rigyn) {
      rigyn.on("user_bash", async (event) => {
        if (event.command.includes("visible-original")) {
          const result = { output: "$ synthetic\\nintercepted visible\\nexit 0", exitCode: 0, cancelled: false, truncated: false };
          await appendFile(${JSON.stringify(postLog)}, JSON.stringify({ ...event, result }) + "\\n");
          return { result };
        }
        if (event.command.includes("hidden-original")) {
          const result = { output: "$ synthetic\\nintercepted hidden\\nexit 0", exitCode: 0, cancelled: false, truncated: false };
          await appendFile(${JSON.stringify(postLog)}, JSON.stringify({ ...event, hidden: event.excludeFromContext, result }) + "\\n");
          return { result };
        }
        if (event.command.includes("transform-original")) {
          return { operations: { async exec(_command, _cwd, options) {
            await writeFile(${JSON.stringify(transformedMarker)}, "transformed");
            options.onData(Buffer.from("transformed"));
            await appendFile(${JSON.stringify(postLog)}, JSON.stringify({ command: "printf transformed > transformed.txt", cwd: ${JSON.stringify(nested)}, hidden: true }) + "\\n");
            return { exitCode: 0 };
          } } };
        }
      });
      rigyn.registerProvider("user-shell-offline", {
        name: "User shell offline",
        api: "openai-chat-completions",
        baseUrl: "https://offline.invalid/v1",
        apiKey: "offline-test-key",
        async *streamSimple() {
          yield { type: "response_start", model: "user-shell-model" };
          yield { type: "text_delta", part: 0, text: "offline" };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "offline" } } };
        },
        models: [{
          id: "user-shell-model", name: "User shell model", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048
        }]
      });
    }
  `);

  const command = [
    process.execPath,
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "--workspace",
    workspace,
    "--provider",
    "user-shell-offline",
    "--model",
    "user-shell-model",
    "--no-session",
  ].map(shellQuote).join(" ");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CODING_AGENT_DIR: agentDirectory,
    XDG_STATE_HOME: state,
    RIGYN_TUI_MODE: "accessible",
    TERM: "xterm-256color",
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const submit = (value: string) => child.stdin.write(`${value}\r`);
  await waitFor(() => output.includes("rigyn 0.5.1 · ready"), () => output.slice(-16 * 1024));
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));

  submit(`!printf visible-original > ${shellQuote(visibleMarker)}`);
  await waitFor(async () => {
    try {
      return (await readFile(postLog, "utf8")).includes("intercepted visible");
    } catch {
      return false;
    }
  }, () => output.slice(-16 * 1024));
  assert.equal(await pathExists(visibleMarker), false);
  submit("/session");
  await waitFor(() => output.includes("Messages: 1 user"), () => output.slice(-16 * 1024));

  submit(`!!printf hidden-original > ${shellQuote(hiddenMarker)}`);
  await waitFor(async () => {
    try {
      return (await readFile(postLog, "utf8")).includes('"hidden":true');
    } catch {
      return false;
    }
  }, () => output.slice(-16 * 1024));
  assert.equal(await pathExists(hiddenMarker), false);
  const sessionOffset = output.length;
  submit("/session");
  await waitFor(() => output.slice(sessionOffset).includes("Messages: 1 user"), () => output.slice(-16 * 1024));
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));

  submit(`!!printf transform-original > ${shellQuote(transformedOriginalMarker)}`);
  await waitFor(async () => {
    try {
      return (await readFile(transformedMarker, "utf8")).trim() === "transformed";
    } catch {
      return false;
    }
  }, () => output.slice(-16 * 1024));
  assert.equal((await readFile(transformedMarker, "utf8")).trim(), "transformed");
  assert.equal(await pathExists(transformedOriginalMarker), false);
  await waitFor(async () => {
    try {
      return /"command":"printf transformed > transformed\.txt"/u.test(await readFile(postLog, "utf8"));
    } catch {
      return false;
    }
  }, () => output.slice(-16 * 1024));
  assert.match(await readFile(postLog, "utf8"), /"command":"printf transformed > transformed\.txt"/u);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));

  const exitCodePromise = new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`chat did not exit:\n${output}`));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  submit("/exit");
  const exitCode = await exitCodePromise;
  assert.equal(exitCode, 0, output);
});
