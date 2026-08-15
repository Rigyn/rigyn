import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { stripAnsi } from "../../src/tui/unicode.js";
import { RIGYN_VERSION } from "../../src/version.js";

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

test("built CLI refresh preserves streamed transcript order, the editor draft, and cached hydration", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-main-refresh-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const refreshLog = join(root, "refresh.log");
  const refreshProbe = join(root, "refresh-probe.jsonl");
  const themeProbe = join(root, "theme-probe.log");
  const modelPickerLog = join(root, "model-picker.log");
  const modelRefreshGate = join(root, "model-refresh-gate");
  const inputMarker = join(root, "input-restored");
  const streamCompleteMarker = join(root, "stream-complete");
  await mkdir(workspace);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ theme: "mono" }));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const mainModule = pathToFileURL(resolve("dist/cli/main.js")).href;
  const controllerModule = pathToFileURL(resolve("dist/tui/controller.js")).href;
  await writeFile(entrypoint, `
import { appendFileSync, existsSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

let refreshActive = false;
const setInputBlocked = TuiController.prototype.setInputBlocked;
TuiController.prototype.setInputBlocked = function(message, label) {
  setInputBlocked.call(this, message, label);
  if (message !== undefined && label === "refresh") {
    refreshActive = true;
    this.setEditorText("preserved refresh draft");
  } else if (message === undefined && refreshActive) {
    appendFileSync(${JSON.stringify(refreshProbe)}, JSON.stringify({
      kind: "unblocked",
      draft: this.getEditorText(),
    }) + "\\n");
    refreshActive = false;
  }
};
const replaceTranscript = TuiController.prototype.replaceTranscript;
TuiController.prototype.replaceTranscript = function(events, scope, options) {
  if (refreshActive) {
    appendFileSync(${JSON.stringify(refreshProbe)}, JSON.stringify({
      kind: "replace",
      preserveExisting: options?.preserveExisting === true,
    }) + "\\n");
  }
  return replaceTranscript.call(this, events, scope, options);
};
const setTheme = TuiController.prototype.setTheme;
TuiController.prototype.setTheme = function(name) {
  setTheme.call(this, name);
  appendFileSync(${JSON.stringify(themeProbe)}, name + "\\n");
};
const openPicker = TuiController.prototype.openPicker;
const pickerInput = new AbortController();
TuiController.prototype.openPicker = function(kind, ...args) {
  if (kind === "model") {
    appendFileSync(${JSON.stringify(modelPickerLog)}, "open\\n");
    this.setNormalizedKeyObserver("refresh-pty-model-picker", (event) => {
      if (event.key === "escape") appendFileSync(${JSON.stringify(modelPickerLog)}, "escape\\n");
    }, pickerInput.signal);
  }
  return openPicker.call(this, kind, ...args);
};

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
  "--provider", "refresh-network-probe",
  "--model", "cached-model",
  "--approve",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "refresh-network-probe",
    factory(rigyn) {
      rigyn.registerProvider("refresh-network-probe", {
        api: "openai-chat-completions",
        apiKey: "local-test",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [model],
        async *streamSimple(selectedModel, _context, options) {
          options?.signal?.throwIfAborted();
          yield { type: "response_start", model: selectedModel.id };
          yield { type: "text_delta", part: 0, text: "refresh-stream-row-first\\n" };
          await new Promise((resolve) => setTimeout(resolve, 1000));
          options?.signal?.throwIfAborted();
          yield { type: "text_delta", part: 0, text: "refresh-stream-row-second" };
          appendFileSync(${JSON.stringify(streamCompleteMarker)}, "complete");
          yield {
            type: "response_end",
            reason: "stop",
            state: {
              kind: "chat_completions",
              assistantMessage: {
                role: "assistant",
                content: "refresh-stream-row-first\\nrefresh-stream-row-second",
              },
            },
          };
        },
        async refreshModels(options) {
          appendFileSync(${JSON.stringify(refreshLog)}, String(options.allowNetwork) + "\\n");
          if (existsSync(${JSON.stringify(modelRefreshGate)})) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            appendFileSync(${JSON.stringify(modelPickerLog)}, "refresh-complete\\n");
          }
          return [model];
        },
      });
    },
  }],
});
`);

  const command = [process.execPath, entrypoint].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
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

  await waitFor(() => rendered.includes(`rigyn ${RIGYN_VERSION} · ready`), `CLI did not become ready:\n${rendered}`);
  await waitFor(async () => existsSync(refreshLog) && (await readFile(refreshLog, "utf8")).includes("true"),
    `startup live model discovery did not run:\n${rendered}`);
  const firstStreamRow = "refresh-stream-row-first";
  const secondStreamRow = "refresh-stream-row-second";
  child.stdin.write("stream the response\r");
  await waitFor(() => rendered.includes(firstStreamRow), `live assistant output was not rendered:\n${rendered}`);
  assert.equal(existsSync(streamCompleteMarker), false, "the first row must be visible before the stream completes");
  await writeFile(modelPickerLog, "");
  child.stdin.write("/model\r");
  await waitFor(async () => (await readFile(modelPickerLog, "utf8")).includes("open"),
    `model command did not open while the assistant was streaming:\n${rendered}`);
  assert.equal(existsSync(streamCompleteMarker), false, "the model command must open before the stream completes");
  child.stdin.write("\u001b");
  await waitFor(async () => (await readFile(modelPickerLog, "utf8")).includes("escape"),
    `active model picker did not decode Escape:\n${rendered}`);
  await waitFor(() => existsSync(streamCompleteMarker), `assistant stream fixture did not finish:\n${rendered}`);
  await waitFor(() => rendered.includes(secondStreamRow), `completed assistant transcript was not rendered:\n${rendered}`);
  assert.ok(rendered.indexOf(firstStreamRow) < rendered.indexOf(secondStreamRow), rendered);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000));
  await writeFile(refreshLog, "");
  await writeFile(join(agentDir, "config.json"), "{}");

  const refreshOutputStart = rendered.length;
  child.stdin.write("/refresh\r");
  await waitFor(
    () => {
      const output = stripAnsi(rendered.slice(refreshOutputStart));
      return output.includes("Refreshed keyboard mappings") && output.includes("instruction files");
    },
    () => `CLI refresh did not finish:\n${rendered}`,
  );
  await waitFor(async () =>
    existsSync(refreshProbe) && (await readFile(refreshProbe, "utf8")).includes('"kind":"unblocked"'),
    "refresh transcript and restored draft probe was not observed");
  const probes = (await readFile(refreshProbe, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    kind: "replace" | "unblocked";
    preserveExisting?: boolean;
    draft?: string;
  });
  assert.equal(probes.find((probe) => probe.kind === "replace")?.preserveExisting, true);
  assert.equal(probes.find((probe) => probe.kind === "unblocked")?.draft, "preserved refresh draft");
  await waitFor(() => rendered.slice(refreshOutputStart).includes("preserved refresh draft"),
    `editor draft was not restored visibly after refresh:\n${rendered}`);
  await waitFor(() => existsSync(refreshLog), "refresh model refresh was not observed");
  assert.deepEqual((await readFile(refreshLog, "utf8")).trim().split("\n").filter(Boolean), ["false"]);
  assert.equal((await readFile(themeProbe, "utf8")).trim().split("\n").at(-1), "signal");

  child.stdin.write(" remains editable");
  await waitFor(() => rendered.slice(refreshOutputStart).includes("preserved refresh draft remains editable"),
    `restored editor draft was not editable:\n${rendered}`);
  child.stdin.write("\u0003");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));

  await writeFile(refreshLog, "");
  await writeFile(modelPickerLog, "");
  await writeFile(modelRefreshGate, "");
  child.stdin.write("/model\r");
  await waitFor(async () => (await readFile(modelPickerLog, "utf8")).includes("open"),
    `model command did not open the picker immediately:\n${rendered}`);
  assert.doesNotMatch(await readFile(modelPickerLog, "utf8"), /refresh-complete/u);
  await waitFor(async () =>
    (await readFile(refreshLog, "utf8")).includes("false")
      && (await readFile(modelPickerLog, "utf8")).includes("refresh-complete"),
    `model command did not finish its local catalog refresh:\n${rendered}`);
  child.stdin.write("\u001b");
  await waitFor(async () => (await readFile(modelPickerLog, "utf8")).includes("escape"),
    `model picker did not decode Escape:\n${rendered}`);

  await rm(modelRefreshGate);
  await writeFile(modelPickerLog, "");
  child.stdin.write(Buffer.from([12]));
  await waitFor(async () => (await readFile(modelPickerLog, "utf8")).includes("open"),
    `model shortcut did not reopen the picker after Escape closed it:\n${rendered}`);
  child.stdin.write("\u001b");
  await waitFor(async () => (await readFile(modelPickerLog, "utf8")).includes("escape"),
    `model shortcut picker did not decode Escape:\n${rendered}`);

  child.stdin.write(`!touch ${inputMarker}\r`);
  await waitFor(() => existsSync(inputMarker),
    `editor input was not restored after closing the model shortcut picker:\n${rendered}`);
  child.stdin.write("/exit\r");
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit after refresh:\n${rendered}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
});
