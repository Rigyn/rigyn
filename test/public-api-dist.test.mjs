import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as api from "rigyn";
import * as embedding from "rigyn/embedding";
import * as interfaces from "rigyn/interfaces";
import * as modes from "rigyn/modes";
import * as testing from "rigyn/testing";
import * as tui from "rigyn/tui";

const execute = promisify(execFile);

const LAYER_ENTRY_POINTS = {
  "rigyn/auth": "SecretRedactor",
  "rigyn/config": "parseJsoncObject",
  "rigyn/context": "deriveContextBudget",
  "rigyn/core": "HarnessError",
  "rigyn/embedding": "createInMemoryHarness",
  "rigyn/extensions": "ExtensionCatalog",
  "rigyn/images": "sniffImageMediaType",
  "rigyn/interfaces": "RpcClient",
  "rigyn/modes": "runPrintMode",
  "rigyn/net": "createNetworkTransport",
  "rigyn/process": "DirectProcessRunner",
  "rigyn/prompts": "buildSystemPrompt",
  "rigyn/providers": "ProviderRegistry",
  "rigyn/sdk": "createRigynSdk",
  "rigyn/service": "HarnessService",
  "rigyn/storage": "SessionStore",
  "rigyn/testing": "createScriptedProvider",
  "rigyn/tools": "ToolRegistry",
  "rigyn/tui": "fuzzyScore",
};

test("built package root is an ESM consumer entry point", async (t) => {
  assert.deepEqual(Object.keys(api).sort(), [
    "DEFAULT_PREPROCESS_MAX_HEIGHT",
    "DEFAULT_PREPROCESS_MAX_WIDTH",
    "DEFAULT_PREPROCESS_OUTPUT_BYTES",
    "ExternalToolBackend",
    "FileModelCatalogStore",
    "HARNESS_RESOURCE_CATALOG_LIMITS",
    "HARNESS_RESOURCE_CATALOG_SCHEMA_VERSION",
    "HARNESS_SESSION_CATALOG_LIMITS",
    "HARNESS_SESSION_CATALOG_SCHEMA_VERSION",
    "HARNESS_TRANSCRIPT_LIMITS",
    "HARNESS_TRANSCRIPT_SCHEMA_VERSION",
    "HarnessError",
    "HarnessService",
    "MAX_NORMALIZED_USAGE_RAW_BYTES",
    "MAX_PREPROCESS_INPUT_BYTES",
    "MODEL_REASONING_EFFORTS",
    "MistralConversationsAdapter",
    "ModelReferenceResolutionError",
    "PROJECT_PACKAGE_DECLARATION",
    "PROJECT_PACKAGE_INSTALL_ROOT",
    "PROJECT_PACKAGE_LOCK",
    "ProjectPackageManager",
    "ProviderRegistry",
    "RIGYN_VERSION",
    "SESSION_EXPORT_FORMAT",
    "SESSION_EXPORT_SCHEMA_VERSION",
    "SecretRedactor",
    "SessionStore",
    "WorkspaceBoundary",
    "analyzeCacheEffectiveness",
    "applyMaintainedModelMetadata",
    "applyUsagePricing",
    "buildHarnessResourceCatalog",
    "calculateUsageCost",
    "createHarnessRuntime",
    "createNetworkTransport",
    "discoverSkills",
    "discoverSkillsDetailed",
    "extensionGalleryInstallSource",
    "imageCoordinateHint",
    "isNormalizedUsage",
    "loadSkill",
    "mergeUsagePricingContext",
    "minimalClipboardEnvironment",
    "modelReasoningEfforts",
    "modelReferenceFailureMessage",
    "normalizeModelReasoningEffort",
    "normalizedContextTokens",
    "normalizedTotalTokens",
    "parseExtensionGalleryIndex",
    "parseHarnessResourceCatalog",
    "parseHarnessSessionPage",
    "parseHarnessTranscriptPage",
    "parseModelReasoningReference",
    "parseProjectPackageDeclaration",
    "parseProjectPackageLock",
    "preprocessImage",
    "projectPackageDeclarationSha256",
    "readClipboardImage",
    "runClipboardCommand",
    "sessionExportEnvelope",
    "sessionExportEvent",
    "sessionExportFormatRecord",
    "sessionExportMessage",
    "sharedUserSkillRoots",
    "sharedWorkspaceSkillRoots",
    "sniffImageMediaType",
    "withUsagePricing",
  ]);

  const workspace = await mkdtemp(join(tmpdir(), "rigyn-dist-api-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const provider = {
    id: "dist-offline",
    async *stream(request, signal) {
      signal.throwIfAborted();
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "compiled import works" };
      yield {
        type: "response_end",
        reason: "stop",
        state: {
          kind: "chat_completions",
          assistantMessage: { role: "assistant", content: "compiled import works" },
        },
      };
    },
    async listModels(signal) {
      signal.throwIfAborted();
      const capability = {
        value: "unknown",
        source: "configuration",
        observedAt: "2026-01-01T00:00:00.000Z",
      };
      return [{
        id: "dist-offline-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const store = new api.SessionStore(":memory:");
  const service = new api.HarnessService({
    store,
    workspace,
    providers: new api.ProviderRegistry([provider]),
  });
  try {
    await service.initialize({ skills: [] });
    const run = await service.run({
      prompt: "compiled package root",
      provider: provider.id,
      model: "dist-offline-v1",
      noBuiltinTools: true,
    });
    assert.equal(run.results.at(-1)?.finalText, "compiled import works");
  } finally {
    await service.close("dist_public_api_test");
    store.close();
  }
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
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script]);
  assert.equal(result.stdout, "native image backend deferred\n");
  assert.equal(result.stderr, "");
});

test("built testing subpath exposes the deterministic provider without changing the root API", async () => {
  assert.deepEqual(Object.keys(testing).sort(), [
    "SCRIPTED_PROVIDER_LIMITS",
    "ScriptedProvider",
    "createScriptedProvider",
  ]);
  const provider = testing.createScriptedProvider({
    id: "dist-scripted",
    models: [{ id: "dist-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "testing subpath works" }] }],
  });
  const events = [];
  for await (const event of provider.stream({
    provider: provider.id,
    model: "dist-model",
    messages: [{
      id: "dist-message",
      role: "user",
      content: [{ type: "text", text: "offline" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    tools: [],
    sessionId: "dist-session",
  }, new AbortController().signal)) events.push(event);
  assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "testing subpath works");
  assert.equal(events.at(-1)?.type, "response_end");
});

test("built embedding subpath owns a narrow deterministic in-memory run", async () => {
  assert.deepEqual(Object.keys(embedding).sort(), [
    "createEmbeddingHarness",
    "createEmbeddingHarnessFromRuntime",
    "createInMemoryHarness",
  ]);
  const provider = testing.createScriptedProvider({
    id: "dist-embedding",
    models: [{ id: "dist-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "embedded dist works" }] }],
  });
  await using harness = await embedding.createInMemoryHarness({
    provider,
    model: "dist-model",
  });
  for (const property of ["auth", "credentials", "providers", "service", "store"]) {
    assert.equal(property in harness, false);
  }
  const run = await harness.run({ prompt: "offline" });
  assert.equal(run.results.at(-1)?.finalText, "embedded dist works");
});

test("built modes subpath exposes ready-made borrowed-owner adapters", () => {
  assert.deepEqual(Object.keys(modes).sort(), [
    "InteractiveMode",
    "OWNED_INTERACTIVE_COMMANDS",
    "RpcMode",
    "createRpcMode",
    "runInteractiveMode",
    "runOwnedInteractiveMode",
    "runPrintMode",
    "runRpcMode",
  ]);
});

test("built TUI subpath exposes bounded semantic component builders", () => {
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

  assert.equal(block.lines[0].spans.map((span) => span.text).join("").startsWith("┌"), true);
  assert.equal(block.cursor, undefined);
  assert.equal(block.lines.some((line) => line.spans.some((span) => span.role === "success")), true);
});

test("built package exposes each documented Node.js layer as an ESM subpath", async () => {
  for (const [specifier, representativeExport] of Object.entries(LAYER_ENTRY_POINTS)) {
    const layer = await import(specifier);
    assert.ok(
      representativeExport in layer,
      `${specifier} is missing ${representativeExport}`,
    );
  }
});

test("built interfaces subpath runs the correlated RPC client", async () => {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const client = new interfaces.RpcClient({ input: responses, output: requests });
  const iterator = interfaces.decodeRpcLines(requests)[Symbol.asyncIterator]();
  const pending = client.request("health");
  const line = await iterator.next();
  const request = JSON.parse(line.value);
  responses.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: { status: "ok", version: "dist", uptimeSeconds: 0, clients: 1, activeRuns: 0 },
  })}\n`);
  assert.equal((await pending).version, "dist");
  await client.close();
});

test("built interfaces subpath launches its own RPC CLI without a command shim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-dist-rpc-"));
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  delete environment.RIGYN_RECURSION_DEPTH;
  const spawned = interfaces.spawnRigynRpcClient({
    args: ["--workspace", root],
    env: environment,
    stderr: "pipe",
    killTimeoutMs: 2_000,
  });
  t.after(async () => {
    await spawned.client.close("test cleanup");
    await rm(root, { recursive: true, force: true });
  });

  const entry = fileURLToPath(new URL("../dist/bin/rigyn.js", import.meta.url));
  assert.equal(spawned.child.spawnfile, process.execPath);
  assert.deepEqual(spawned.child.spawnargs.slice(1), [entry, "rpc", "--workspace", root]);
  assert.equal((await spawned.client.request("health")).status, "ok");
  await spawned.client.request("shutdown");
  await spawned.client.close("test complete");
});

test("packaged embedding example is a runnable public-runtime entry point", async () => {
  const example = fileURLToPath(new URL("../examples/embedding-runtime.mjs", import.meta.url));
  const result = await execute(process.execPath, [example, "--help"]);
  assert.equal(result.stdout, "node examples/embedding-runtime.mjs <provider> <model> <prompt>\n");
  assert.equal(result.stderr, "");
});

test("packaged in-memory embedding examples run without credentials or config", async () => {
  const memory = fileURLToPath(new URL("../examples/embedding-in-memory.mjs", import.meta.url));
  const memoryResult = await execute(process.execPath, [memory, "packed"]);
  assert.equal(memoryResult.stdout, "offline: packed\n");
  assert.equal(memoryResult.stderr, "");

  const cancellation = fileURLToPath(new URL("../examples/embedding-cancellation.mjs", import.meta.url));
  const cancellationResult = await execute(process.execPath, [cancellation]);
  assert.equal(cancellationResult.stdout, "cancelled\n");
  assert.equal(cancellationResult.stderr, "");
});
