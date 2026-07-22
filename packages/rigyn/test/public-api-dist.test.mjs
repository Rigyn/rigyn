import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as api from "rigyn";
import * as embedding from "rigyn/embedding";
import * as interfaces from "rigyn/interfaces";
import * as sdk from "rigyn/sdk";
import * as testing from "rigyn/testing";
import * as tui from "rigyn/tui";

const execute = promisify(execFile);

function standaloneEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_TEST_WORKER_ID;
  return environment;
}

const LAYER_ENTRY_POINTS = {
  "rigyn/auth": "SecretRedactor",
  "rigyn/config": "SettingsManager",
  "rigyn/context": "deriveContextBudget",
  "rigyn/core": "HarnessError",
  "rigyn/embedding": "createInMemoryHarness",
  "rigyn/extensions": "defineTool",
  "rigyn/images": "sniffImageMediaType",
  "rigyn/interfaces": "RpcClient",
  "rigyn/modes": "runPrintMode",
  "rigyn/net": "createNetworkTransport",
  "rigyn/process": "DirectProcessRunner",
  "rigyn/prompts": "buildSystemPrompt",
  "rigyn/providers": "ModelRegistry",
  "rigyn/sdk": "createAgentSession",
  "rigyn/service": "AgentSession",
  "rigyn/storage": "SessionManager",
  "rigyn/testing": "createScriptedProvider",
  "rigyn/tools": "ToolRegistry",
  "rigyn/tui": "fuzzyScore",
};

test("built package root exposes the direct session architecture without retired service/store owners", () => {
  assert.equal(typeof api.AgentSession, "function");
  assert.equal(typeof api.SessionManager, "function");
  assert.equal(typeof api.defineTool, "function");
  assert.equal("RuntimeExtensionHost" in api, false);
  assert.equal("HarnessService" in api, false);
  assert.equal("SessionStore" in api, false);
  assert.equal("createRigynSdk" in sdk, false);

  const manager = api.SessionManager.inMemory(process.cwd(), { id: "dist-session" });
  manager.appendSessionInfo("Compiled session");
  assert.equal(manager.getSessionName(), "Compiled session");
});

test("built package root exposes the generic coding-agent facades", () => {
  for (const name of [
    "AgentSessionRuntime",
    "CONFIG_DIR_NAME",
    "CURRENT_SESSION_VERSION",
    "DefaultPackageManager",
    "DefaultResourceLoader",
    "KeybindingsManager",
    "ModelRegistry",
    "ModelRuntime",
    "ProjectTrustStore",
    "RpcClient",
    "SettingsManager",
    "buildContextEntries",
    "buildSessionContext",
    "createAgentSession",
    "createAgentSessionServices",
    "createBashTool",
    "createBashToolDefinition",
    "createCodingTools",
    "createEditTool",
    "createEditToolDefinition",
    "createEventBus",
    "createExtensionRuntime",
    "createFindTool",
    "createFindToolDefinition",
    "createGrepTool",
    "createGrepToolDefinition",
    "createLocalBashOperations",
    "createLsTool",
    "createLsToolDefinition",
    "createReadOnlyTools",
    "createReadTool",
    "createReadToolDefinition",
    "createSyntheticSourceInfo",
    "createWriteTool",
    "createWriteToolDefinition",
    "formatSkillsForPrompt",
    "generateDiffString",
    "generateUnifiedPatch",
    "getAgentDir",
    "getLatestCompactionEntry",
    "loadProjectContextFiles",
    "loadSkills",
    "loadSkillsFromDir",
    "migrateSessionEntries",
    "parseArgs",
    "parseFrontmatter",
    "parseSessionEntries",
    "renderDiff",
    "resizeImage",
    "sessionEntryToContextMessages",
    "truncateHead",
  ]) assert.ok(name in api, `rigyn is missing ${name}`);
});

test("built package import defers the native image backend", async () => {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const script = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "sharp") throw new Error("Rigyn eagerly loaded Sharp");
        return nextResolve(specifier, context);
      },
    });
    await import(${JSON.stringify(entry)});
    (await import("node:fs")).writeFileSync(1, "native image backend deferred\\n");
  `;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    env: standaloneEnvironment(),
  });
  assert.equal(result.stdout, "native image backend deferred\n");
  assert.equal(result.stderr, "");
});

test("built RPC executable export boots through the public CLI contract", async () => {
  const entry = fileURLToPath(new URL("../dist/rpc-entry.js", import.meta.url));
  const result = await execute(process.execPath, [entry, "--version"], {
    env: standaloneEnvironment(),
  });
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal(result.stderr, "");
});

test("built testing and embedding subpaths complete an offline direct session", async () => {
  const provider = testing.createScriptedProvider({
    id: "dist-embedding",
    models: [{ id: "dist-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "embedded dist works" }] }],
  });
  await using harness = await embedding.createInMemoryHarness({
    provider,
    model: "dist-model",
    api: "openai-chat-completions",
  });
  const run = await harness.session.run({ prompt: "offline" });
  assert.equal(run.results.at(-1)?.finalText, "embedded dist works");
});

test("built print mode owns the runtime and supports an embedded output sink", async () => {
  const output = [];
  const session = {
    sessionManager: { getHeader() { return null; } },
    state: { messages: [] },
    async bindExtensions() {},
    subscribe() { return () => {}; },
    async prompt() {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "print dist works" }],
        stopReason: "stop",
      });
    },
  };
  const runtime = { session, setRebindSession() {}, async dispose() {} };
  const result = await (await import("rigyn/modes")).runPrintMode(runtime, {
    mode: "text",
    initialMessage: "probe",
    write: (text) => output.push(text),
  });
  assert.equal(result, 0);
  assert.deepEqual(output, ["print dist works\n"]);
});

test("built interfaces serialize and parse the direct JSONL protocol", async () => {
  assert.deepEqual(interfaces.parseRpcInput('{"id":"dist","type":"get_state"}'), {
    id: "dist",
    type: "get_state",
  });
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await new interfaces.RpcWriter(output).send({
    id: "dist",
    type: "response",
    command: "get_state",
    success: true,
  });
  assert.equal(
    Buffer.concat(chunks).toString("utf8"),
    '{"id":"dist","type":"response","command":"get_state","success":true}\n',
  );
});

test("built TUI subpath exposes semantic component builders", () => {
  const view = tui.uiPanel(tui.uiStack([
    tui.uiText("ready", { role: "success" }),
    tui.uiMarkdown("**public** component", { role: "muted" }),
  ], { gap: 1 }), { title: "Status" });
  const block = view.render({
    width: 24,
    height: 8,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  });
  assert.equal(block.lines.some((line) => line.spans.some((span) => span.role === "success")), true);
});

test("built package exposes each documented Node.js layer as an ESM subpath", async () => {
  for (const [specifier, representativeExport] of Object.entries(LAYER_ENTRY_POINTS)) {
    const layer = await import(specifier);
    assert.ok(representativeExport in layer, `${specifier} is missing ${representativeExport}`);
  }
});

test("every built named export has declaration and runtime conformance evidence", async () => {
  const probe = fileURLToPath(new URL("public-api/named-export-conformance.mjs", import.meta.url));
  const result = await execute(process.execPath, [probe], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: standaloneEnvironment(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const marker = "RIGYN_NAMED_EXPORT_CONFORMANCE ";
  const line = result.stdout.split("\n").find((value) => value.startsWith(marker));
  assert.ok(line, `missing named-export summary in: ${result.stdout}`);
  const summary = JSON.parse(line.slice(marker.length));
  const inventory = JSON.parse(await readFile(
    new URL("../release/public-named-export-inventory.json", import.meta.url),
    "utf8",
  ));
  const entries = Object.values(inventory.entries);
  const runtimeBindings = entries.reduce((count, entry) => count + entry.runtime.length, 0);
  const typeOnlyBindings = entries.reduce((count, entry) => count + entry.typeOnly.length, 0);
  assert.deepEqual({
    entrypoints: summary.entrypoints,
    runtimeBindings: summary.runtimeBindings,
    typeOnlyBindings: summary.typeOnlyBindings,
    totalBindings: summary.totalBindings,
    semanticFunctions: summary.semanticFunctions,
  }, {
    entrypoints: entries.length,
    runtimeBindings,
    typeOnlyBindings,
    totalBindings: runtimeBindings + typeOnlyBindings,
    semanticFunctions: 21,
  });
  assert.equal(result.stderr, "");
});
