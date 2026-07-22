import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { RIGYN_VERSION } from "../../src/version.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("CLI reload uses cached model hydration and restores editor input", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-reload-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const refreshLog = join(root, "refresh.log");
  const inputMarker = join(root, "input-restored");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const mainModule = pathToFileURL(resolve("src/cli/main.ts")).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

const model = {
  id: "cached-model",
  name: "Cached Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--approve",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "reload-network-probe",
    factory(rigyn) {
      rigyn.registerProvider("reload-network-probe", {
        api: "openai-completions",
        apiKey: "local-test",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [model],
        async refreshModels(options) {
          appendFileSync(${JSON.stringify(refreshLog)}, String(options.allowNetwork) + "\\n");
          return [model];
        },
      });
    },
  }],
});
`);

  const command = [process.execPath, "--import", "tsx", entrypoint].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      RIGYN_CODING_AGENT_DIR: agentDir,
      RIGYN_TUI_MODE: "full",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });

  await waitFor(() => rendered.includes(`Rigyn ${RIGYN_VERSION} · Ready`), `CLI did not become ready:\n${rendered}`);
  await waitFor(async () => existsSync(refreshLog) && (await readFile(refreshLog, "utf8")).includes("true"),
    `startup live model discovery did not run:\n${rendered}`);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
  await writeFile(refreshLog, "");

  child.stdin.write("/reload\r");
  await waitFor(() => rendered.includes("Reloaded keybindings, extensions, skills, prompts, themes, and context files"),
    `CLI reload did not finish:\n${rendered}`);
  await waitFor(() => existsSync(refreshLog), "reload model refresh was not observed");
  assert.deepEqual((await readFile(refreshLog, "utf8")).trim().split("\n").filter(Boolean), ["false"]);

  child.stdin.write("\u001b");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  child.stdin.write(`!touch ${inputMarker}\r`);
  await waitFor(() => existsSync(inputMarker), `editor input was not restored after reload:\n${rendered}`);
  child.stdin.write("/exit\r");
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit after reload:\n${rendered}`));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
});
