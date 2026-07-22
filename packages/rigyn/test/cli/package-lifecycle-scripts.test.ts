import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function runCli(args: readonly string[], environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin/rigyn.ts", ...args], {
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
    }, 15_000);
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

async function writePackage(source: string, version: string): Promise<void> {
  await mkdir(join(source, "runtime"), { recursive: true });
  await writeFile(join(source, "package.json"), `${JSON.stringify({
    name: "rigyn-cli-lifecycle",
    version,
    type: "module",
    rigyn: { extensions: ["runtime/index.mjs"] },
    scripts: { install: "source-package-install-must-not-run-directly" },
    dependencies: { "fixture-dependency": version },
  }, null, 2)}\n`);
  await writeFile(join(source, "runtime", "index.mjs"), `
export default function activate(api) {
  const stream = async function* (model) {
    yield { type: "response_start", model: model.id };
    yield { type: "text_delta", part: 0, text: "invocation package ready" };
    yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
  };
  api.registerProvider({
    id: "cli-lifecycle-provider",
    name: "CLI lifecycle provider",
    auth: {
      apiKey: {
        name: "No authentication",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    getModels() {
      return [{
        id: "offline-model",
        name: "Offline model",
        api: "openai-responses",
        provider: "cli-lifecycle-provider",
        baseUrl: "https://offline.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      }];
    },
    stream,
    streamSimple: stream,
  });
}
`);
}

test("CLI lifecycle opt-in applies only to explicit install and update transactions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-package-cli-scripts-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const sourceDirectory = join(root, "source");
  const source = "npm:rigyn-cli-lifecycle";
  const agentDirectory = join(root, "agent");
  const stateRoot = join(root, "state");
  const capture = join(root, "npm-calls.jsonl");
  const lifecycleMarker = join(root, "dependency-lifecycle-ran");
  await mkdir(workspace, { recursive: true });
  await mkdir(sourceDirectory);
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await writePackage(sourceDirectory, "1.0.0");

  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [capture, marker, sourceDirectory, ...args] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(sourceDirectory, "package.json"), "utf8"));
if (args[0] === "view") {
  process.stdout.write(JSON.stringify(manifest.version));
  process.exit(0);
}
const prefixIndex = args.indexOf("--prefix");
if (args[0] !== "install" || prefixIndex < 0 || args[prefixIndex + 1] === undefined) {
  throw new Error("unexpected fake npm invocation: " + JSON.stringify(args));
}
const prefix = args[prefixIndex + 1];
await appendFile(capture, JSON.stringify({ args, cwd: process.cwd(), ignore: process.env.npm_config_ignore_scripts, bins: process.env.npm_config_bin_links }) + "\\n");
const enabled = args.includes("--ignore-scripts=false") && args.includes("--bin-links=true");
if (enabled) {
  await writeFile(marker, "ran");
  await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(prefix, "node_modules", ".bin", "fixture"), "managed package binary");
}
const destination = join(prefix, "node_modules", manifest.name);
await rm(destination, { recursive: true, force: true });
await mkdir(join(prefix, "node_modules"), { recursive: true });
await cp(sourceDirectory, destination, { recursive: true });
`);
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    npmCommand: [process.execPath, fakeNpm, capture, lifecycleMarker, sourceDirectory],
  }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CODING_AGENT_DIR: agentDirectory,
    XDG_STATE_HOME: stateRoot,
    RIGYN_CREDENTIAL_KEY: Buffer.alloc(32, 17).toString("base64url"),
  };
  delete environment.RIGYN_RECURSION_DEPTH;
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) delete environment[name];

  const installed = await runCli([
    "install", source, "--workspace", workspace, "--json",
  ], environment);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).source, source);
  await assert.rejects(access(lifecycleMarker), /ENOENT/u);

  await writePackage(sourceDirectory, "2.0.0");
  const updated = await runCli([
    "update", source, "--allow-scripts", "--workspace", workspace, "--json",
  ], environment);
  assert.equal(updated.code, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), { source, updated: true });
  assert.equal(await readFile(lifecycleMarker, "utf8"), "ran");

  const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[];
    cwd: string;
    ignore: string;
    bins: string;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.args.includes("--ignore-scripts=true"), true);
  assert.equal(calls[0]?.args.includes("--bin-links=false"), true);
  assert.equal(calls[0]?.ignore, "true");
  assert.equal(calls[0]?.bins, "false");
  assert.equal(calls[1]?.args.includes("--ignore-scripts=false"), true);
  assert.equal(calls[1]?.args.includes("--bin-links=true"), true);
  assert.equal(calls[1]?.ignore, "false");
  assert.equal(calls[1]?.bins, "true");
  assert.equal(calls.every((entry) => entry.args.some((argument) => argument.includes(".rigyn-package-stage-"))), true);
  const installedManifest = JSON.parse(await readFile(
    join(agentDirectory, "npm", "node_modules", "rigyn-cli-lifecycle", "package.json"),
    "utf8",
  )) as { version: string };
  assert.equal(installedManifest.version, "2.0.0");
});
