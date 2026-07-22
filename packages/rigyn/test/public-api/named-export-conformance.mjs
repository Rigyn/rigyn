import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { API, SymbolFlags, TypeFlags } from "typescript/unstable/sync";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inventoryPath = join(packageRoot, "release", "public-named-export-inventory.json");
const manifestPath = join(packageRoot, "package.json");
const consumerConfigPath = join(packageRoot, "test", "public-api", "tsconfig.json");

const SEMANTIC_FUNCTIONS = new Set([
  "createAgentSession",
  "createAgentSessionFromServices",
  "createAgentSessionRuntime",
  "createAgentSessionServices",
  "createEmbeddingHarness",
  "createEmbeddingHarnessFromRuntime",
  "createHarnessRuntime",
  "createInMemoryHarness",
  "createNativeUiHost",
  "createOpenRouterLoopback",
  "createUnsafeTerminalHost",
  "detectCapabilities",
  "detectTerminalCapabilities",
  "editTextExternally",
  "main",
  "probePlatformKeychain",
  "readClipboardImage",
  "readClipboardText",
  "readSecret",
  "runPrintMode",
  "runRpcMode",
]);

function packageSpecifier(entry) {
  return entry === "." ? "rigyn" : `rigyn/${entry}`;
}

function declarationExport(manifest, entry) {
  const key = entry === "." ? "." : `./${entry}`;
  const declaration = manifest.exports[key]?.types;
  assert.equal(typeof declaration, "string", `${key} must declare a TypeScript entry`);
  return resolve(packageRoot, declaration);
}

function isClass(value) {
  return typeof value === "function"
    && Function.prototype.toString.call(value).startsWith("class ");
}

async function runNode(script, input = "") {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: packageRoot,
    env: { ...process.env, RIGYN_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Public API child probe timed out: ${stderr}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal });
    });
  });
  return { ...result, stdout, stderr };
}

function checkDeclarations(inventory, manifest) {
  const api = new API();
  const snapshot = api.updateSnapshot({ openProjects: [consumerConfigPath] });
  const project = snapshot.getProjects()[0];
  assert.ok(project, "the public consumer TypeScript project must load");
  const { checker, program } = project;
  let runtimeBindings = 0;
  let typeOnlyBindings = 0;

  for (const [entry, expected] of Object.entries(inventory.entries)) {
    const path = declarationExport(manifest, entry);
    const source = program.getSourceFile(path);
    assert.ok(source, `${path} must be part of the public consumer program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    assert.ok(moduleSymbol, `${entry} must resolve to a declaration module`);
    const exports = checker.getExportsOfModule(moduleSymbol);
    const actualNames = exports.map((symbol) => symbol.name).sort();
    const expectedNames = [...expected.runtime, ...expected.typeOnly].sort();
    assert.deepEqual(actualNames, expectedNames, `${entry} declaration exports changed`);

    const runtime = [];
    const typeOnly = [];
    for (const symbol of exports) {
      const resolved = (symbol.flags & SymbolFlags.Alias) === 0
        ? symbol
        : checker.getAliasedSymbol(symbol);
      assert.ok(resolved.declarations?.length, `${entry}:${symbol.name} must have a declaration`);
      if (expected.runtime.includes(symbol.name)) {
        const valueType = checker.getTypeOfSymbol(resolved);
        assert.equal((valueType.flags & TypeFlags.Any) === 0, true, `${entry}:${symbol.name} leaked any/error`);
        assert.notEqual(checker.typeToString(valueType).trim(), "", `${entry}:${symbol.name} has no value type`);
        runtime.push(symbol.name);
        runtimeBindings += 1;
      } else {
        const declaredType = checker.getDeclaredTypeOfSymbol(resolved);
        assert.equal((declaredType.flags & TypeFlags.Any) === 0, true, `${entry}:${symbol.name} leaked any/error`);
        assert.notEqual(checker.typeToString(declaredType).trim(), "", `${entry}:${symbol.name} has no declared type`);
        typeOnly.push(symbol.name);
        typeOnlyBindings += 1;
      }
    }
    assert.deepEqual(runtime.sort(), expected.runtime, `${entry} runtime/type classification changed`);
    assert.deepEqual(typeOnly.sort(), expected.typeOnly, `${entry} type-only classification changed`);
  }
  return { runtimeBindings, typeOnlyBindings };
}

async function probeSemanticFunctions(modules, temporaryRoot) {
  const root = modules.get(".");
  const auth = modules.get("auth");
  const config = modules.get("config");
  const embedding = modules.get("embedding");
  const interfaces = modules.get("interfaces");
  const images = modules.get("images");
  const modes = modules.get("modes");
  const providers = modules.get("providers");
  const service = modules.get("service");
  const storage = modules.get("storage");
  const testing = modules.get("testing");
  const tui = modules.get("tui");
  for (const value of [root, auth, config, embedding, images, interfaces, modes, providers, service, storage, testing, tui]) assert.ok(value);

  const version = await runNode('import { main } from "rigyn"; await main(["--version"]);');
  assert.deepEqual({ code: version.code, signal: version.signal }, { code: 0, signal: null });
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal(version.stderr, "");

  const rpcScript = `
    import { runRpcMode } from "rigyn/modes";
    const listeners = new Set();
    const session = {
      async bindExtensions() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      get model() { return undefined; },
      get modelRegistry() { return { find() {}, getAvailable() { return []; } }; },
      get thinkingLevel() { return "off"; },
      get isStreaming() { return false; },
      get isIdle() { return true; },
      get isCompacting() { return false; },
      get steeringMode() { return "all"; },
      get followUpMode() { return "all"; },
      get sessionFile() { return undefined; },
      get sessionId() { return "named-export-probe"; },
      get sessionName() { return undefined; },
      get autoCompactionEnabled() { return true; },
      get messages() { return []; },
      get pendingMessageCount() { return 0; },
    };
    const runtime = {
      session,
      setBeforeSessionInvalidate() {},
      setRebindSession() {},
      async dispose() {},
    };
    await runRpcMode(runtime);
  `;
  const rpc = await runNode(rpcScript, `${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  assert.deepEqual({ code: rpc.code, signal: rpc.signal }, { code: 0, signal: null });
  assert.equal(rpc.stderr, "");
  const rpcRecords = rpc.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rpcRecords[0]?.success, true);
  assert.equal(rpcRecords[0]?.data?.sessionId, "named-export-probe");

  const output = [];
  const printSession = {
    sessionManager: { getHeader() { return null; } },
    state: { messages: [] },
    async bindExtensions() {},
    subscribe() { return () => undefined; },
    async prompt() {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "print contract" }],
        stopReason: "stop",
      });
    },
  };
  const printResult = await modes.runPrintMode({
    session: printSession,
    setRebindSession() {},
    async dispose() {},
  }, {
    mode: "text",
    initialMessage: "probe",
    write: (text) => output.push(text),
  });
  assert.equal(printResult, 0);
  assert.deepEqual(output, ["print contract\n"]);

  const modelRuntime = await providers.ModelRuntime.create({
    models: providers.createModels(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const agentDir = join(temporaryRoot, "agent");
  const direct = await root.createAgentSession({
    cwd: temporaryRoot,
    agentDir,
    modelRuntime,
    settingsManager: config.SettingsManager.inMemory(),
    sessionManager: storage.SessionManager.inMemory(temporaryRoot, { id: "named-export-direct" }),
    noTools: "all",
  });
  assert.equal(direct.session.sessionId, "named-export-direct");
  await direct.session.close();

  const services = await service.createAgentSessionServices({
    cwd: temporaryRoot,
    agentDir,
    modelRuntime,
    settingsManager: config.SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  assert.equal(services.cwd, temporaryRoot);
  const composed = await service.createAgentSessionFromServices({
    services,
    sessionManager: storage.SessionManager.inMemory(temporaryRoot, { id: "named-export-composed" }),
    noTools: "all",
  });
  assert.equal(composed.session.sessionId, "named-export-composed");
  await composed.session.close();

  let runtimeClosed = 0;
  const runtimeManager = storage.SessionManager.inMemory(temporaryRoot, { id: "named-export-runtime" });
  const runtime = await service.createAgentSessionRuntime(async ({ cwd, agentDir: activeAgentDir, sessionManager }) => ({
    session: {
      sessionManager,
      get sessionFile() { return sessionManager.getSessionFile(); },
      async close() { runtimeClosed += 1; },
      createReplacedSessionContext() { return Object.freeze({}); },
    },
    services: {
      cwd,
      agentDir: activeAgentDir,
      async close() { runtimeClosed += 1; },
    },
  }), {
    cwd: temporaryRoot,
    agentDir,
    sessionManager: runtimeManager,
  });
  assert.equal(runtime.cwd, temporaryRoot);
  await runtime.dispose();
  assert.equal(runtimeClosed, 2);

  const publicRuntime = await root.createHarnessRuntime({
    workspace: temporaryRoot,
    ephemeral: true,
    projectTrusted: false,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  assert.equal(publicRuntime.workspace, temporaryRoot);
  await publicRuntime.close();

  const embeddingHarness = await embedding.createEmbeddingHarness({
    workspace: temporaryRoot,
    ephemeral: true,
    projectTrusted: false,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  assert.equal(embeddingHarness.session.cwd, temporaryRoot);
  await embeddingHarness.close();

  let wrappedClosed = false;
  const wrapped = embedding.createEmbeddingHarnessFromRuntime({
    session: {
      sessionId: "named-export-wrapped",
      cwd: temporaryRoot,
      model: undefined,
      isIdle: true,
    },
    async reload() { return { warnings: [] }; },
    async close() { wrappedClosed = true; },
  });
  assert.equal(wrapped.session.id, "named-export-wrapped");
  await wrapped.close();
  assert.equal(wrappedClosed, true);

  const scriptedFixture = testing.createScriptedProvider({
    id: "named-export-scripted",
    models: [{ id: "model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "embedding contract" }] }],
  });
  const observedAt = "2026-07-21T00:00:00.000Z";
  const scriptedModels = scriptedFixture.models.map((model) => ({
    ...model,
    compatibility: {
      ...model.compatibility,
      protocolFamily: {
        value: "openai-chat-completions",
        source: "configuration",
        observedAt,
      },
    },
  }));
  const scripted = {
    id: scriptedFixture.id,
    models: scriptedModels,
    async listModels(signal) { signal.throwIfAborted(); return structuredClone(scriptedModels); },
    stream: scriptedFixture.stream.bind(scriptedFixture),
  };
  const inMemory = await embedding.createInMemoryHarness({
    provider: scripted,
    model: "model",
    api: "openai-chat-completions",
    workspace: temporaryRoot,
  });
  assert.equal((await inMemory.session.run({ prompt: "probe" })).results.at(-1)?.finalText, "embedding contract");
  await inMemory.close();

  const editorFixture = join(packageRoot, "test", "fixtures", "external-editor.mjs");
  assert.equal(await tui.editTextExternally("initial", {
    command: `"${process.execPath}" "${editorFixture}"`,
    cwd: packageRoot,
    environment: { ...process.env },
  }), "edited by fixture\n");

  const keychainCalls = [];
  assert.equal(await auth.probePlatformKeychain({
    async get(...args) { keychainCalls.push(args); return undefined; },
    async set() { throw new Error("probe must not write"); },
    async delete() { throw new Error("probe must not delete"); },
  }), true);
  assert.equal(keychainCalls.length, 1);
  assert.deepEqual(
    [keychainCalls[0][0], keychainCalls[0][1], keychainCalls[0][3]],
    ["rigyn-keychain-probe-v1", "availability", false],
  );
  assert.equal(keychainCalls[0][2] instanceof AbortSignal, true);

  const loopbackCancellation = new Error("named export loopback cancellation");
  const loopback = await auth.createOpenRouterLoopback({ timeoutMs: 1_000 });
  assert.equal(loopback.authorizationUrl.protocol, "https:");
  loopback.cancel(loopbackCancellation);
  await assert.rejects(loopback.waitForKey(), (error) => error === loopbackCancellation);

  const clipboardImage = await images.readClipboardImage({ platform: "linux", environment: {}, osRelease: "" });
  assert.equal(clipboardImage.image, undefined);
  assert.equal(clipboardImage.diagnostics[0]?.outcome, "unavailable");
  assert.deepEqual(
    await images.readClipboardText({ platform: "linux", environment: {}, osRelease: "" }),
    {},
  );

  const capabilities = tui.detectCapabilities(() => false);
  assert.deepEqual(Object.keys(capabilities).sort(), ["hyperlinks", "images", "trueColor"]);
  const terminalCapabilities = tui.detectTerminalCapabilities(
    { isTTY: false },
    { isTTY: false, columns: 111, rows: 37 },
    { environment: { TERM: "xterm", LANG: "C.UTF-8" } },
  );
  assert.equal(terminalCapabilities.mode, "classic");
  assert.deepEqual(
    { columns: terminalCapabilities.columns, rows: terminalCapabilities.rows },
    { columns: 111, rows: 37 },
  );

  const nativeCalls = [];
  const controller = {
    assertNativeUiAvailable() { nativeCalls.push("available"); },
    insertClipboardText(value) { nativeCalls.push(`paste:${value}`); },
    writeUnsafeTerminal(value) { nativeCalls.push(`write:${value}`); },
    requestUnsafeTerminalRender() { nativeCalls.push("render"); },
    unsafeTerminalSize() { return { columns: 80, rows: 24 }; },
  };
  const generation = new AbortController();
  const native = tui.createNativeUiHost(controller, "named-export-native", generation.signal);
  native.pasteToEditor("text");
  assert.equal(native.extensionId, "named-export-native");
  native.dispose();
  assert.throws(() => native.pasteToEditor("stale"), /disposed/u);
  const unsafe = tui.createUnsafeTerminalHost(controller, "named-export-unsafe", generation.signal);
  unsafe.write("raw");
  unsafe.requestRender();
  assert.deepEqual(unsafe.size(), { columns: 80, rows: 24 });
  unsafe.dispose();
  assert.deepEqual(nativeCalls, [
    "available",
    "available",
    "paste:text",
    "available",
    "available",
    "write:raw",
    "available",
    "render",
    "available",
  ]);

  const cancellation = new Error("named export secret cancellation");
  await assert.rejects(
    interfaces.readSecret("Secret: ", AbortSignal.abort(cancellation)),
    (error) => error === cancellation,
  );
}

async function probeRuntimeBindings(inventory, modules) {
  const identities = new Map();
  const primitiveBindings = [];
  let runtimeBindings = 0;
  for (const [entry, expected] of Object.entries(inventory.entries)) {
    const namespace = modules.get(entry);
    assert.deepEqual(Object.keys(namespace).sort(), expected.runtime, `${entry} runtime exports changed`);
    for (const name of expected.runtime) {
      const value = namespace[name];
      assert.notEqual(value, undefined, `${entry}:${name} is undefined`);
      runtimeBindings += 1;
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        const bindings = identities.get(value) ?? [];
        bindings.push(`${entry}:${name}`);
        identities.set(value, bindings);
      } else {
        primitiveBindings.push({ entry, name, value });
      }
    }
  }

  let classes = 0;
  let errorClasses = 0;
  let functions = 0;
  let objects = 0;
  const functionNames = new Set();
  for (const [value, bindings] of identities) {
    const names = new Set(bindings.map((binding) => binding.slice(binding.indexOf(":") + 1)));
    if (isClass(value)) {
      classes += 1;
      const Derived = class extends value {};
      assert.equal(Object.getPrototypeOf(Derived.prototype), value.prototype, `${bindings[0]} cannot be subclassed`);
      if ([...names].some((name) => name.endsWith("Error"))) {
        const error = new value("named export probe");
        assert.equal(error instanceof value, true);
        assert.equal(error instanceof Error, true);
        errorClasses += 1;
      }
      continue;
    }
    if (typeof value === "function") {
      functions += 1;
      for (const name of names) functionNames.add(name);
      continue;
    }
    objects += 1;
    assert.notEqual(value, null);
    assert.ok(Object.getPrototypeOf(value) !== undefined || Object.isFrozen(value));
    if (Array.isArray(value)) {
      assert.equal(Number.isSafeInteger(value.length), true);
      if (value.length > 0) void value[0];
    } else if (value instanceof Set || value instanceof Map) {
      assert.equal(Number.isSafeInteger(value.size), true);
      void value.values().next();
    } else {
      for (const key of Reflect.ownKeys(value)) void Reflect.get(value, key);
    }
  }

  for (const { entry, name, value } of primitiveBindings) {
    if (typeof value === "number") {
      assert.equal(Number.isFinite(value), true, `${entry}:${name} must be finite`);
      assert.equal(value + 0, value);
    } else if (typeof value === "string") {
      assert.equal(Buffer.byteLength(value, "utf8") > 0, true, `${entry}:${name} must be nonempty`);
      assert.equal(`${value}`, value);
    } else if (typeof value === "boolean") {
      assert.equal(value === true || value === false, true);
    } else if (typeof value === "bigint") {
      assert.equal(value + 0n, value);
    } else if (typeof value === "symbol") {
      assert.equal(typeof value.description, "string");
    } else {
      assert.fail(`${entry}:${name} has unsupported runtime kind ${typeof value}`);
    }
  }
  for (const name of SEMANTIC_FUNCTIONS) {
    assert.equal(functionNames.has(name), true, `${name} must remain an exported function`);
  }
  return {
    runtimeBindings,
    uniqueRuntimeIdentities: identities.size + primitiveBindings.length,
    classes,
    errorClasses,
    functions,
    semanticFunctions: SEMANTIC_FUNCTIONS.size,
    objects,
    primitiveBindings: primitiveBindings.length,
  };
}

const startedAt = Date.now();
const temporaryRoot = await mkdtemp(join(tmpdir(), "rigyn-public-api-"));
try {
  process.env.HOME = temporaryRoot;
  process.env.XDG_CONFIG_HOME = join(temporaryRoot, "config");
  process.env.XDG_DATA_HOME = join(temporaryRoot, "data");
  process.env.XDG_CACHE_HOME = join(temporaryRoot, "cache");
  process.env.RIGYN_OFFLINE = "1";
  globalThis.fetch = async () => { throw new Error("Network is disabled during public export conformance"); };

  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(inventory.schemaVersion, 1);
  const entries = Object.keys(inventory.entries);
  const modules = new Map(await Promise.all(entries.map(async (entry) => [
    entry,
    await import(packageSpecifier(entry)),
  ])));

  const declarations = checkDeclarations(inventory, manifest);
  await probeSemanticFunctions(modules, temporaryRoot);
  const runtime = await probeRuntimeBindings(inventory, modules);
  assert.equal(runtime.runtimeBindings, declarations.runtimeBindings);
  const summary = {
    entrypoints: entries.length,
    ...declarations,
    ...runtime,
    totalBindings: declarations.runtimeBindings + declarations.typeOnlyBindings,
    durationMs: Date.now() - startedAt,
  };
  writeFileSync(1, `RIGYN_NAMED_EXPORT_CONFORMANCE ${JSON.stringify(summary)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
