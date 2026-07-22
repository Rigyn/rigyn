import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const mainModule = pathToFileURL(fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url))).href;

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
      RIGYN_CODING_AGENT_DIR: agentDir,
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
      RIGYN_CODING_AGENT_DIR: agentDir,
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
  await writeFile(join(workspace, ".rigyn", "settings.json"), "{}\n");
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
      RIGYN_CODING_AGENT_DIR: agentDir,
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
    child.once("exit", (code, signal) => {
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

test("RPC startup failures propagate after cleaning up the runtime", async (context) => {
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
      RIGYN_CODING_AGENT_DIR: agentDir,
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
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 1, signal: null }, stderr);
  assert.equal(stdout, "");
  assert.match(stderr, /rpc startup failure sentinel/u);
});

test("normal main invocations let supplied factories resolve project trust", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-inline-project-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "trust-calls.txt");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await writeFile(join(workspace, ".rigyn", "settings.json"), "{}\n");
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
      RIGYN_CODING_AGENT_DIR: agentDir,
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
  await writeFile(join(workspace, ".rigyn", "settings.json"), "{}\n");
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
      RIGYN_CODING_AGENT_DIR: agentDir,
      RIGYN_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /"scope":"project"/u);
  assert.match(result.stdout, /inline-project-package/u);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(marker, "utf8"), "2,2");
});
