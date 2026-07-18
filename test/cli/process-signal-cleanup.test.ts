import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const REPOSITORY = resolve(".");
const PTY_AVAILABLE = process.platform === "linux"
  && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {}
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForOutput(read: () => string, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read()}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Rigyn signal-cleanup subprocess timed out"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

async function linuxChildPids(pid: number): Promise<number[]> {
  const contents = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
  return contents.trim() === "" ? [] : contents.trim().split(/\s+/u).map(Number);
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function signalFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-process-signal-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const ready = join(root, "shell-ready");
  const childPid = join(root, "grandchild.pid");
  const survived = join(root, "grandchild-survived");
  const disposed = join(root, "extension-disposed");
  const noncooperativeReady = join(root, "noncooperative-ready");
  await mkdir(workspace);
  await mkdir(configHome, { mode: 0o700 });
  await mkdir(stateHome, { mode: 0o700 });
  const grandchild = `
    const { writeFileSync } = require("node:fs");
    setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1200);
    setInterval(() => {}, 1000);
  `;
  const parent = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
    writeFileSync(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1000);
  `;
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(parent)}`;
  const extension = join(workspace, "signal-extension.mjs");
  await writeFile(extension, `
    import { writeFile } from "node:fs/promises";
    export default function activate(api) {
      api.onDispose(async () => {
        if (process.env.HARNESS_TEST_BLOCK_DISPOSER === "1") await new Promise(() => {});
        await writeFile(${JSON.stringify(disposed)}, "disposed");
      });
      api.registerProvider({
        id: "signal-offline",
        async *stream(request, signal) {
          signal.throwIfAborted();
          yield { type: "response_start", model: request.model };
          const prompt = request.messages.flatMap((message) => message.content)
            .filter((block) => block.type === "text").map((block) => block.text).join("\\n");
          if (process.env.HARNESS_TEST_BLOCK_DISPOSER === "1" || prompt.includes("noncooperative")) {
            await writeFile(${JSON.stringify(noncooperativeReady)}, "ready");
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
          const hasToolResult = request.messages.some((message) => message.role === "tool");
          if (!hasToolResult) {
            const input = { command: ${JSON.stringify(command)} };
            yield { type: "tool_call_start", index: 0, id: "signal-shell", name: "bash" };
            yield { type: "tool_call_delta", index: 0, jsonFragment: JSON.stringify(input) };
            yield { type: "tool_call_end", index: 0, id: "signal-shell", name: "bash", rawArguments: JSON.stringify(input), arguments: input };
            yield { type: "response_end", reason: "tool_calls", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
            return;
          }
          yield { type: "text_delta", part: 0, text: "unexpected completion" };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() {
          const observedAt = "2026-01-01T00:00:00.000Z";
          const supported = { value: "supported", source: "provider", observedAt };
          const unsupported = { value: "unsupported", source: "provider", observedAt };
          return [{
            id: "signal-model",
            provider: "signal-offline",
            capabilities: { tools: supported, reasoning: unsupported, images: unsupported },
          }];
        },
      });
    }
  `);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    RIGYN_CREDENTIAL_KEY: Buffer.alloc(32, 23).toString("base64url"),
  };
  const children: ChildProcess[] = [];
  const ptyPids: string[] = [];
  const output = new Map<ChildProcess, string>();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const path of ptyPids) {
      try { process.kill(Number(await readFile(path, "utf8")), "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    configHome,
    extension,
    environment,
    ready,
    childPid,
    survived,
    disposed,
    noncooperativeReady,
    spawnHarness(args: string[], stdin: "ignore" | "pipe" = "ignore") {
      const child = spawn(process.execPath, ["--import", "tsx", "src/bin/rigyn.ts", ...args], {
        cwd: REPOSITORY,
        env: environment,
        stdio: [stdin, "pipe", "pipe"],
      });
      output.set(child, "");
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
        output.set(child, `${output.get(child) ?? ""}${chunk.toString("utf8")}`.slice(-16 * 1024));
      });
      children.push(child);
      return child;
    },
    spawnPtyHarness(args: string[], pidPath: string) {
      const invocation = [
        process.execPath,
        "--import",
        "tsx",
        "src/bin/rigyn.ts",
        ...args,
      ].map(shellQuote).join(" ");
      const command = `printf '%s\\n' "$$" > ${shellQuote(pidPath)}; exec ${invocation}`;
      const child = spawn("script", ["-qefc", command, "/dev/null"], {
        cwd: REPOSITORY,
        env: {
          ...environment,
          RIGYN_TUI_MODE: "accessible",
          TERM: "xterm-256color",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      output.set(child, "");
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
        output.set(child, `${output.get(child) ?? ""}${chunk.toString("utf8")}`.slice(-16 * 1024));
      });
      ptyPids.push(pidPath);
      children.push(child);
      return child;
    },
    output(child: ChildProcess) {
      return output.get(child) ?? "";
    },
  };
}

test("interactive chat preserves conventional SIGINT, SIGHUP, and SIGTERM exit codes", {
  skip: !PTY_AVAILABLE,
}, async (t) => {
  const fixture = await signalFixture(t);
  const cases: Array<{ signal: "SIGINT" | "SIGHUP" | "SIGTERM"; code: number }> = [
    { signal: "SIGINT", code: 130 },
    { signal: "SIGHUP", code: 129 },
    { signal: "SIGTERM", code: 143 },
  ];
  for (const [index, selected] of cases.entries()) {
    const pidPath = join(fixture.root, `chat-${index}.pid`);
    const child = fixture.spawnPtyHarness([
      "chat",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--approve",
      "--workspace", fixture.workspace,
    ], pidPath);
    await waitForOutput(() => fixture.output(child), "Ready");
    await waitForFile(pidPath);
    assert.equal(process.kill(Number(await readFile(pidPath, "utf8")), selected.signal), true);
    assert.deepEqual(await waitForExit(child), { code: selected.code, signal: null }, fixture.output(child));
  }
});

test("interactive chat SIGTERM kills an active tool tree, disposes extensions, and exits 143", {
  skip: !PTY_AVAILABLE,
}, async (t) => {
  const fixture = await signalFixture(t);
  const pidPath = join(fixture.root, "active-chat.pid");
  const child = fixture.spawnPtyHarness([
    "chat",
    "--provider", "signal-offline",
    "--model", "signal-model",
    "--tools", "bash",
    "--extension", fixture.extension,
    "--no-extensions",
    "--no-session",
    "--approve",
    "--workspace", fixture.workspace,
  ], pidPath);
  await waitForOutput(() => fixture.output(child), "Ready");
  child.stdin!.write("start the shell fixture\r");
  await waitForFile(fixture.ready);
  assert.equal(process.kill(Number(await readFile(pidPath, "utf8")), "SIGTERM"), true);
  assert.deepEqual(await waitForExit(child), { code: 143, signal: null }, fixture.output(child));
  await waitForFile(fixture.disposed);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1400));
  await assert.rejects(access(fixture.survived));
  const pid = Number(await readFile(fixture.childPid, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
});

test("print SIGTERM cancels work, kills the detached process group, disposes extensions, and exits 143", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await signalFixture(t);
  const child = fixture.spawnHarness([
    "run",
    "start the shell fixture",
    "--provider", "signal-offline",
    "--model", "signal-model",
    "--tools", "bash",
    "--extension", fixture.extension,
    "--no-extensions",
    "--no-session",
    "--workspace", fixture.workspace,
    "--print",
  ]);
  await waitForFile(fixture.ready);
  assert.equal(child.kill("SIGTERM"), true);
  assert.deepEqual(await waitForExit(child), { code: 143, signal: null });
  await waitForFile(fixture.disposed);
  assert.equal(await readFile(fixture.disposed, "utf8"), "disposed");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1400));
  await assert.rejects(access(fixture.survived));
  const pid = Number(await readFile(fixture.childPid, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
});

test("RPC SIGHUP cancels work, kills the detached process group, disposes extensions, and exits 129", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await signalFixture(t);
  const child = fixture.spawnHarness([
    "rpc",
    "--extension", fixture.extension,
    "--no-extensions",
    "--workspace", fixture.workspace,
  ], "pipe");
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  child.stdin!.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "run.start",
    params: {
      prompt: "start the shell fixture",
      provider: "signal-offline",
      model: "signal-model",
      allowedTools: ["bash"],
    },
  })}\n`);
  await waitForFile(fixture.ready);
  assert.equal(child.kill("SIGHUP"), true);
  assert.deepEqual(await waitForExit(child), { code: 129, signal: null });
  await waitForFile(fixture.disposed);
  assert.equal(await readFile(fixture.disposed, "utf8"), "disposed");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1400));
  await assert.rejects(access(fixture.survived));
  const pid = Number(await readFile(fixture.childPid, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
});

test("RPC SIGTERM bounds a provider request that never observes cancellation", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await signalFixture(t);
  const child = fixture.spawnHarness([
    "rpc",
    "--extension", fixture.extension,
    "--no-extensions",
    "--workspace", fixture.workspace,
  ], "pipe");
  child.stdin!.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "run.start",
    params: {
      prompt: "start noncooperative provider",
      provider: "signal-offline",
      model: "signal-model",
      allowedTools: ["bash"],
    },
  })}\n`);
  try {
    await waitForFile(fixture.noncooperativeReady);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixture.output(child)}`);
  }
  assert.equal(child.kill("SIGTERM"), true);
  assert.deepEqual(await waitForExit(child), { code: 143, signal: null });
  await waitForFile(fixture.disposed);
});

test("Node 26 RPC startup does not create its stdin relay before runtime loading succeeds", {
  skip: process.platform !== "linux" || Number(process.versions.node.split(".", 1)[0]) < 26,
}, async (t) => {
  const fixture = await signalFixture(t);
  const activationStarted = join(fixture.root, "delayed-activation-started");
  const extension = join(fixture.workspace, "delayed-startup-extension.mjs");
  const blockedDatabaseParent = join(fixture.root, "blocked-database-parent");
  await writeFile(blockedDatabaseParent, "not a directory");
  const configDirectory = join(fixture.configHome, "rigyn");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(configDirectory, "config.jsonc"), `${JSON.stringify({
    databasePath: join(blockedDatabaseParent, "sessions.sqlite"),
  })}\n`, { mode: 0o600 });
  await writeFile(extension, `
    import { writeFileSync } from "node:fs";
    export default function activate() {
      writeFileSync(${JSON.stringify(activationStarted)}, "started");
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {}
    }
  `);
  const child = fixture.spawnHarness([
    "rpc",
    "--extension", extension,
    "--no-extensions",
    "--workspace", fixture.workspace,
  ], "pipe");
  await waitForFile(activationStarted);
  assert.deepEqual(await linuxChildPids(child.pid!), []);
  assert.deepEqual(await waitForExit(child), { code: 1, signal: null });
  assert.match(fixture.output(child), /Directory creation path has a symbolic or non-canonical existing ancestor/u);
});

test("Node 26 RPC stdin relay exits when its parent is killed", {
  skip: process.platform !== "linux" || Number(process.versions.node.split(".", 1)[0]) < 26,
}, async (t) => {
  const fixture = await signalFixture(t);
  const child = fixture.spawnHarness([
    "rpc",
    "--no-extensions",
    "--workspace", fixture.workspace,
  ], "pipe");
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  await waitForOutput(() => fixture.output(child), '"id":1');
  const descendants = await linuxChildPids(child.pid!);
  assert.equal(descendants.length, 1, `expected one RPC stdin relay, received ${descendants.join(", ")}`);
  assert.equal(child.kill("SIGKILL"), true);
  assert.deepEqual(await waitForExit(child), { code: null, signal: "SIGKILL" });
  await Promise.all(descendants.map(async (pid) => await waitForPidExit(pid)));
});

test("a repeated termination signal force-exits with the conventional status when disposal is broken", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await signalFixture(t);
  fixture.environment.HARNESS_TEST_BLOCK_DISPOSER = "1";
  const child = fixture.spawnHarness([
    "run",
    "start noncooperative provider",
    "--provider", "signal-offline",
    "--model", "signal-model",
    "--extension", fixture.extension,
    "--no-extensions",
    "--no-session",
    "--workspace", fixture.workspace,
    "--print",
  ]);
  try {
    await waitForFile(fixture.noncooperativeReady);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixture.output(child)}`);
  }
  assert.equal(child.kill("SIGTERM"), true);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(child.kill("SIGTERM"), true);
  assert.deepEqual(await waitForExit(child, 3_000), { code: 143, signal: null });
  await assert.rejects(access(fixture.disposed));
});

test("package install SIGTERM kills the detached npm process tree and exits 143", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await signalFixture(t);
  const fakeNpm = join(fixture.root, "fake-npm.cjs");
  const ready = join(fixture.root, "npm-ready");
  const npmPid = join(fixture.root, "npm.pid");
  const childPid = join(fixture.root, "npm-child.pid");
  const survived = join(fixture.root, "npm-child-survived");
  const grandchild = `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1200);
    setInterval(() => {}, 1000);
  `;
  await writeFile(fakeNpm, `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(npmPid)}, String(process.pid));
    writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
    writeFileSync(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1000);
  `);
  const configDirectory = join(fixture.configHome, "rigyn");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(configDirectory, "config.jsonc"), `${JSON.stringify({
    npmCommand: [process.execPath, fakeNpm],
  })}\n`, { mode: 0o600 });
  t.after(async () => {
    try { process.kill(-Number(await readFile(npmPid, "utf8")), "SIGKILL"); } catch {}
  });

  const harness = fixture.spawnHarness([
    "install",
    "npm:fixture-package@1.0.0",
    "--workspace", fixture.workspace,
  ]);
  await waitForFile(ready);
  assert.equal(harness.kill("SIGTERM"), true);
  assert.deepEqual(await waitForExit(harness), { code: 143, signal: null }, fixture.output(harness));
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1400));
  await assert.rejects(access(survived));
  for (const path of [npmPid, childPid]) {
    const pid = Number(await readFile(path, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  }
});
