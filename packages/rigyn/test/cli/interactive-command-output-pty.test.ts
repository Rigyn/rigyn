import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { RIGYN_VERSION } from "../../src/version.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, offset: number, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!read().slice(offset).includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("built CLI /help and /resources render interactive command and resource details", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-command-output-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const command = [
    process.execPath,
    resolve("dist/bin/rigyn.js"),
    "chat",
    "--workspace",
    workspace,
    "--offline",
    "--no-browser",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-session",
  ].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      RIGYN_HOME: agentDirectory,
      RIGYN_ACCESSIBLE: "1",
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
  const read = () => rendered;

  await waitForOutput(read, 0, `rigyn ${RIGYN_VERSION} · ready`);

  const helpOffset = read().length;
  child.stdin.write("/help\r");
  await waitForOutput(read, helpOffset, "/quit");
  const helpOutput = read().slice(helpOffset);
  assert.match(helpOutput, /Interactive commands:/u);
  assert.match(helpOutput, /\/settings/u);
  assert.match(helpOutput, /\/resources/u);
  assert.match(helpOutput, /\/quit/u);
  assert.doesNotMatch(helpOutput, /Usage: rigyn/u);

  const resourcesOffset = read().length;
  child.stdin.write("/resources\r");
  await waitForOutput(read, resourcesOffset, "Project packages (0)");
  const resourcesOutput = read().slice(resourcesOffset);
  assert.match(resourcesOutput, /Loaded resources/u);
  assert.match(resourcesOutput, /Extensions \(0\)/u);
  assert.match(resourcesOutput, /Commands \(0\)/u);
  assert.match(resourcesOutput, /Prompts \(0\)/u);
  assert.match(resourcesOutput, /Skills \(0\)/u);
  assert.match(resourcesOutput, /Themes \(0\)/u);
  assert.match(resourcesOutput, /Instruction files \(0\)/u);
  assert.match(resourcesOutput, /Project packages \(0\)/u);

  const exitCode = new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chat did not exit:\n${read().slice(-16 * 1024)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  child.stdin.write("/exit\r");
  assert.equal(await exitCode, 0, read());
});
