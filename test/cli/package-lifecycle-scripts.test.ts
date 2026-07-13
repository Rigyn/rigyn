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
  await writeFile(join(source, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "cli-lifecycle",
    name: "CLI lifecycle",
    version,
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }, null, 2)}\n`);
  await writeFile(join(source, "package.json"), `${JSON.stringify({
    name: "rigyn-cli-lifecycle",
    version,
    type: "module",
    scripts: { prepare: "source-package-prepare-must-not-run" },
    dependencies: { "fixture-dependency": version },
  }, null, 2)}\n`);
  await writeFile(join(source, "runtime", "index.mjs"), `
export default function activate(api) {
  api.registerProvider({
    id: "cli-lifecycle-provider",
    async *stream(request) {
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "invocation package ready" };
      yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
    },
    async listModels() { return []; },
  });
}
`);
}

test("CLI lifecycle opt-in reaches extensions install, update, and invocation-only packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-package-cli-scripts-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const source = join(root, "source");
  const configRoot = join(root, "config");
  const stateRoot = join(root, "state");
  const capture = join(root, "npm-calls.jsonl");
  const lifecycleMarker = join(root, "dependency-lifecycle-ran");
  await mkdir(workspace, { recursive: true });
  await mkdir(source);
  await mkdir(join(configRoot, "rigyn"), { recursive: true, mode: 0o700 });
  await writePackage(source, "1.0.0");

  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [capture, marker, ...args] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
await appendFile(capture, JSON.stringify({ args, cwd: process.cwd(), ignore: process.env.npm_config_ignore_scripts, bins: process.env.npm_config_bin_links }) + "\\n");
const enabled = args.includes("--ignore-scripts=false") && args.includes("--bin-links=true");
if (enabled) {
  await writeFile(marker, "ran");
  await mkdir(join(process.cwd(), "node_modules", ".bin"), { recursive: true });
  await writeFile(join(process.cwd(), "node_modules", ".bin", "fixture"), "staging only");
}
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  const dependency = join(process.cwd(), "node_modules", name);
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.mjs" }));
  await writeFile(join(dependency, "index.mjs"), "export const value = " + JSON.stringify(version) + ";\\n");
}
`);
  await writeFile(join(configRoot, "rigyn", "config.jsonc"), JSON.stringify({
    npmCommand: [process.execPath, fakeNpm, capture, lifecycleMarker],
  }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateRoot,
    RIGYN_CREDENTIAL_KEY: Buffer.alloc(32, 17).toString("base64url"),
  };
  delete environment.RIGYN_RECURSION_DEPTH;
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) delete environment[name];

  const deniedByDefault = await runCli([
    "use the invocation package without lifecycle permission",
    "--package", source,
    "--provider", "cli-lifecycle-provider",
    "--model", "offline-model",
    "--no-extensions",
    "--no-session",
    "--workspace", workspace,
    "--print",
  ], environment);
  assert.equal(deniedByDefault.code, 0, deniedByDefault.stderr);
  assert.equal(deniedByDefault.stdout, "invocation package ready\n");
  await assert.rejects(access(lifecycleMarker), /ENOENT/u);

  const installed = await runCli([
    "extensions", "install", source, "--allow-scripts", "--workspace", workspace, "--json",
  ], environment);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).version, "1.0.0");
  assert.equal(await readFile(lifecycleMarker, "utf8"), "ran");

  await writePackage(source, "2.0.0");
  const updated = await runCli([
    "update", "cli-lifecycle", "--allow-scripts", "--workspace", workspace, "--json",
  ], environment);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).version, "2.0.0");

  await rm(lifecycleMarker);
  const invoked = await runCli([
    "use the invocation package",
    "--package", source,
    "--allow-scripts",
    "--provider", "cli-lifecycle-provider",
    "--model", "offline-model",
    "--no-extensions",
    "--no-session",
    "--workspace", workspace,
    "--print",
  ], environment);
  assert.equal(invoked.code, 0, invoked.stderr);
  assert.equal(invoked.stdout, "invocation package ready\n");
  assert.equal(await readFile(lifecycleMarker, "utf8"), "ran");

  const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[];
    cwd: string;
    ignore: string;
    bins: string;
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[0]?.args.includes("--ignore-scripts=true"), true);
  assert.equal(calls[0]?.args.includes("--bin-links=false"), true);
  assert.equal(calls[0]?.ignore, "true");
  assert.equal(calls[0]?.bins, "false");
  assert.equal(calls.slice(1).every((entry) => entry.args.includes("--ignore-scripts=false")), true);
  assert.equal(calls.slice(1).every((entry) => entry.args.includes("--bin-links=true")), true);
  assert.equal(calls.slice(1).every((entry) => entry.ignore === "false" && entry.bins === "true"), true);
  assert.equal(calls.every((entry) => entry.cwd.includes(".rigyn-package-stage-")), true);
  await assert.rejects(access(join(configRoot, "rigyn", "extensions", "cli-lifecycle", "node_modules", ".bin")), /ENOENT/u);
});
