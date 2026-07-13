import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { loadRuntime } from "../../src/cli/runtime.js";

async function httpFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function withRuntimeEnvironment<T>(operation: (paths: {
  root: string;
  workspace: string;
  configHome: string;
  stateHome: string;
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-reload-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(configHome, "rigyn"), { recursive: true, mode: 0o700 });
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const previousCredentialKey = process.env.RIGYN_CREDENTIAL_KEY;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64url");
  try {
    return await operation({ root, workspace, configHome, stateHome });
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousCredentialKey === undefined) delete process.env.RIGYN_CREDENTIAL_KEY;
    else process.env.RIGYN_CREDENTIAL_KEY = previousCredentialKey;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeReloadExtension(configHome: string, log: string, version: string): Promise<string> {
  const directory = join(configHome, "rigyn", "extensions", "reload-test");
  await mkdir(join(directory, "runtime"), { recursive: true });
  await mkdir(join(directory, "prompts"), { recursive: true });
  await mkdir(join(directory, "skills", "reload-guide"), { recursive: true });
  await mkdir(join(directory, "themes"), { recursive: true });
  await writeFile(join(directory, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "reload-test",
    name: "Reload test",
    version: "1.0.0",
    contributions: {
      runtime: [{ path: "runtime/index.mjs" }],
    },
  }));
  await writeFile(join(directory, "prompts", "reload-prompt.md"), `${version} prompt {{input}}\n`);
  await writeFile(join(directory, "skills", "reload-guide", "SKILL.md"), `---\nname: reload-guide\ndescription: ${version} skill\n---\n\n${version} instructions\n`);
  await writeFile(join(directory, "themes", "reload.json"), JSON.stringify({
    schemaVersion: 1,
    name: "reload-theme",
    styles: { accent: { foreground: version === "v1" ? "#111111" : "#222222" } },
  }));
  await writeFile(join(directory, "runtime", "index.mjs"), `
    import { appendFile } from "node:fs/promises";
    const version = ${JSON.stringify(version)};
    const log = ${JSON.stringify(log)};
    export default function activate(api) {
      api.on("resources_discover", (event) => {
        if (event.workspace !== api.workspace || event.reason !== ${JSON.stringify(version === "v2" ? "reload" : "startup")}) {
          throw new Error("unexpected resource discovery lifecycle");
        }
        return { skillPaths: ["skills"], promptPaths: ["prompts"], themePaths: ["themes"] };
      });
      api.registerCommand({ name: "reload-probe", execute({ args }) { return version + ":" + args; } });
      api.registerProvider({ id: "reload-provider", async *stream() {}, async listModels() { return []; } });
      api.registerProviderAuth({
        provider: "reload-provider",
        displayName: version + " provider",
        methods: [{ kind: "api_key", label: version + " access key", detail: "Generation-scoped secure credential" }],
      });
      api.on("session_start", async (value) => appendFile(log, "start:" + version + ":" + (value.reason || "initial") + "\\n"));
      api.on("session_end", async (value) => appendFile(log, "end:" + version + ":" + (value.reason || "exit") + "\\n"));
      api.onDispose(async () => appendFile(log, "dispose:" + version + "\\n"));
    }
  `);
  return directory;
}

async function writeTransactionalExtension(configHome: string, version?: string): Promise<void> {
  const directory = join(configHome, "rigyn", "extensions", "transaction-test");
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(join(directory, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "transaction-test",
    name: "Transaction test",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(
    join(directory, "runtime", "index.mjs"),
    version === undefined
      ? "export default 42;\n"
      : `export default (api) => api.registerCommand({ name: "transaction-probe", execute() { return ${JSON.stringify(version)}; } });\n`,
  );
}

async function writeHelperExtension(
  configHome: string,
  extension: "mjs" | "js" | "mts" | "ts",
  version: string,
  includeEntry: boolean,
): Promise<void> {
  const id = `helper-${extension}`;
  const directory = join(configHome, "rigyn", "extensions", id);
  const runtime = join(directory, "runtime");
  await mkdir(runtime, { recursive: true });
  if (includeEntry) {
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      contributions: { runtime: [{ path: `runtime/index.${extension}` }] },
    }));
    await writeFile(join(runtime, `index.${extension}`), `
      import { version } from "./helper.${extension}";
      export default (api) => api.registerCommand({ name: ${JSON.stringify(id)}, execute() { return version; } });
    `);
  }
  await writeFile(join(runtime, `helper.${extension}`), `export const version = ${JSON.stringify(version)};\n`);
}

async function writeConfiguredModel(configHome: string, version: string): Promise<void> {
  await writeFile(join(configHome, "rigyn", "config.jsonc"), JSON.stringify({
    models: [{
      provider: "reload-provider",
      id: "configured-model",
      displayName: `${version} configured model`,
      description: `${version} offline metadata`,
      contextTokens: version === "v1" ? 64_000 : 128_000,
      maxOutputTokens: 8_000,
      tools: true,
      reasoningEfforts: ["low", "high"],
    }],
  }));
}

function commandContext() {
  return {
    args: "value",
    threadId: "reload-thread",
    signal: new AbortController().signal,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      setHeader() {},
      setFooter() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setTitle() {},
      async getTheme() { return { name: "dark", available: ["dark"] }; },
      async setTheme(name: string) { return { name, available: [name] }; },
      async select<T>(_prompt: string, options: readonly { value: T }[]) { return options[0]!.value; },
      async confirm() { return true; },
      async input() { return undefined; },
      async editor() { return undefined; },
      setEditorText() {},
      getEditorText() { return ""; },
      async custom<T>(): Promise<T | undefined> { return undefined; },
      showOverlay(): never { throw new Error("not used"); },
    },
  };
}

test("runtime reload swaps resources in place and preserves stable session ownership", async () => {
  await withRuntimeEnvironment(async ({ root, workspace, configHome }) => {
    const log = join(root, "lifecycle.log");
    await writeReloadExtension(configHome, log, "v1");
    await writeConfiguredModel(configHome, "v1");
    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    const originalStore = runtime.store;
    const originalService = runtime.service;
    const thread = await runtime.service.createSession({ name: "reload session" });
    await runtime.runtimeExtensions.dispatch("session_start", { threadId: thread.threadId, workspace });
    assert.deepEqual(await runtime.runtimeExtensions.runCommand("reload-probe", commandContext()), {
      handled: true,
      prompt: "v1:value",
    }, JSON.stringify({ extensions: runtime.extensions.list(), diagnostics: runtime.runtimeExtensions.diagnostics() }));
    assert.equal(
      runtime.extensions.prompt("reload-prompt")?.template.trim(),
      "v1 prompt {{input}}",
      JSON.stringify(runtime.runtimeExtensions.diagnostics()),
    );
    assert.equal(runtime.service.skills.find((skill) => skill.name === "reload-guide")?.description, "v1 skill");
    assert.equal(runtime.extensions.theme("reload-theme")?.definition.styles.accent?.foreground, "#111111");
    assert.deepEqual(
      (await runtime.providers.listModels("reload-provider", new AbortController().signal, { refresh: false }))
        .map((model) => [model.id, model.displayName, model.description, model.contextTokens]),
      [["configured-model", "v1 configured model", "v1 offline metadata", 64_000]],
    );
    const oldHost = runtime.runtimeExtensions;
    const oldAuth = runtime.auth;
    const oldProviders = runtime.providers;
    const unregister = oldProviders.unregister.bind(oldProviders);
    let preservedReplacementCatalog = false;
    oldProviders.unregister = (id, adapter, options) => {
      if (id === "reload-provider" && options?.preservePersistedCatalog === true) {
        preservedReplacementCatalog = true;
      }
      return unregister(id, adapter, options);
    };
    assert.equal(oldAuth.methods("reload-provider").find((method) => method.kind === "api_key")?.label, "v1 access key");

    await writeReloadExtension(configHome, log, "v2");
    await writeConfiguredModel(configHome, "v2");
    let committed = false;
    const result = await runtime.reload({
      session: { threadId: thread.threadId },
      onCommit() { committed = true; },
    });

    assert.equal(committed, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(runtime.store, originalStore);
    assert.equal(runtime.service, originalService);
    assert.equal(runtime.store.getThread(thread.threadId).name, "reload session");
    assert.deepEqual(await runtime.runtimeExtensions.runCommand("reload-probe", commandContext()), {
      handled: true,
      prompt: "v2:value",
    });
    assert.equal(runtime.extensions.prompt("reload-prompt")?.template.trim(), "v2 prompt {{input}}");
    assert.equal(runtime.service.skills.find((skill) => skill.name === "reload-guide")?.description, "v2 skill");
    assert.equal(runtime.extensions.theme("reload-theme")?.definition.styles.accent?.foreground, "#222222");
    assert.notEqual(runtime.providers, oldProviders);
    assert.deepEqual(
      (await runtime.providers.listModels("reload-provider", new AbortController().signal, { refresh: false }))
        .map((model) => [model.id, model.displayName, model.description, model.contextTokens]),
      [["configured-model", "v2 configured model", "v2 offline metadata", 128_000]],
    );
    assert.notEqual(runtime.runtimeExtensions, oldHost);
    await assert.rejects(oldHost.runCommand("reload-probe", commandContext()), /host is closed/u);
    assert.equal(oldAuth.has("reload-provider"), false);
    assert.equal(preservedReplacementCatalog, true);
    assert.equal(runtime.providers.has("reload-provider"), true);
    assert.equal(runtime.auth.methods("reload-provider").find((method) => method.kind === "api_key")?.label, "v2 access key");

    await runtime.close();
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "start:v1:initial",
      "end:v1:reload",
      "dispose:v1",
      "start:v2:reload",
      "dispose:v2",
    ]);
  });
});

test("runtime reload refreshes relative helper modules when only helpers change", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const extensions = ["mjs", "js", "mts", "ts"] as const;
    for (const extension of extensions) await writeHelperExtension(configHome, extension, "v1", true);
    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    try {
      for (const extension of extensions) {
        assert.equal((await runtime.runtimeExtensions.runCommand(`helper-${extension}`, commandContext())).prompt, "v1");
      }
      for (const extension of extensions) await writeHelperExtension(configHome, extension, "v2", false);

      await runtime.reload();

      for (const extension of extensions) {
        assert.equal((await runtime.runtimeExtensions.runCommand(`helper-${extension}`, commandContext())).prompt, "v2");
      }
    } finally {
      await runtime.close();
    }
  });
});

test("reload activation failure rolls back while startup remains fault-isolated", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await writeTransactionalExtension(configHome);
    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    try {
      assert.match(
        runtime.runtimeExtensions.diagnostics().map((entry) => entry.message).join("\n"),
        /must export a default or named activate function/u,
      );

      await writeTransactionalExtension(configHome, "v1");
      await runtime.reload();
      const stableHost = runtime.runtimeExtensions;
      const stableSignal = runtime.generationSignal;
      assert.equal((await stableHost.runCommand("transaction-probe", commandContext())).prompt, "v1");

      await writeTransactionalExtension(configHome);
      await assert.rejects(runtime.reload(), /must export a default or named activate function/u);
      assert.equal(runtime.runtimeExtensions, stableHost);
      assert.equal(runtime.generationSignal, stableSignal);
      assert.equal(stableSignal.aborted, false);
      assert.equal((await stableHost.runCommand("transaction-probe", commandContext())).prompt, "v1");

      await writeTransactionalExtension(configHome, "v2");
      await runtime.reload();
      assert.notEqual(runtime.runtimeExtensions, stableHost);
      assert.equal((await runtime.runtimeExtensions.runCommand("transaction-probe", commandContext())).prompt, "v2");
    } finally {
      await runtime.close();
    }
  });
});

test("runtime resource discovery deduplicates canonical paths and rejects escapes and symlinks", {
  skip: process.platform === "win32",
}, async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const extensions = join(configHome, "rigyn", "extensions");
    const directory = join(extensions, "resource-boundary");
    await mkdir(join(directory, "runtime"), { recursive: true });
    await mkdir(join(directory, "skills", "inside-guide"), { recursive: true });
    await mkdir(join(extensions, "outside-skills", "outside-guide"), { recursive: true });
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "resource-boundary",
      name: "Resource boundary",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(directory, "runtime", "index.mjs"), `export default (api) => {
      api.on("resources_discover", () => ({
        skillPaths: ["skills", "skills", "../outside-skills", "linked-skills"]
      }));
    };\n`);
    await writeFile(join(directory, "skills", "inside-guide", "SKILL.md"), "---\nname: inside-guide\ndescription: Inside package\n---\n\nInside.\n");
    await writeFile(join(extensions, "outside-skills", "outside-guide", "SKILL.md"), "---\nname: outside-guide\ndescription: Outside package\n---\n\nOutside.\n");
    await symlink("skills", join(directory, "linked-skills"));

    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    try {
      assert.deepEqual(runtime.service.skills.filter((skill) => skill.name === "inside-guide").map((skill) => skill.name), ["inside-guide"]);
      assert.equal(runtime.service.skills.some((skill) => skill.name === "outside-guide"), false);
      const diagnostics = runtime.runtimeExtensions.diagnostics().map((entry) => entry.message).join("\n");
      assert.match(diagnostics, /escapes workspace/u);
      assert.match(diagnostics, /symbolic link/u);
    } finally {
      await runtime.close();
    }
  });
});

test("session-start registrations reach the live runtime and are removed on close", async () => {
  await withRuntimeEnvironment(async ({ root, workspace, configHome }) => {
    const requests: string[] = [];
    const fixture = await httpFixture((request, response) => {
      const header = request.headers["x-api-key"];
      requests.push(Array.isArray(header) ? header.join(",") : header ?? "");
      response.end("ok");
    });
    const directory = join(configHome, "rigyn", "extensions", "late-runtime");
    const log = join(root, "late-runtime.log");
    await mkdir(join(directory, "runtime"), { recursive: true });
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "late-runtime",
      name: "Late runtime",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(directory, "runtime", "index.mjs"), `
      import { appendFile } from "node:fs/promises";
      let registered = false;
      export default function activate(api) {
        api.on("session_start", () => {
          if (registered) return;
          registered = true;
          api.registerTool({
            name: "late_echo",
            description: "Echo after session start",
            inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
            execute(input) { return { content: "late:" + input.text, isError: false }; },
          });
          api.registerCommand({ name: "late-command", execute() { return "late command prompt"; } });
          api.registerToolRenderer("late_echo", { renderCall: () => ({ lines: [] }) });
          api.registerProvider({
            id: "late-provider",
            async *stream(request, signal) {
              const authenticated = await api.auth.fetch("late-provider", ${JSON.stringify("__ORIGIN__")}, undefined, signal);
              if (!authenticated.ok || await authenticated.text() !== "ok") throw new Error("late provider credential unavailable");
              yield { type: "response_start", model: request.model };
              const result = request.messages.flatMap((message) => message.content).findLast((block) => block.type === "tool_result" && block.name === "late_echo");
              if (result === undefined) {
                yield { type: "tool_call_start", index: 0, id: "late-call", name: "late_echo" };
                yield { type: "tool_call_delta", index: 0, jsonFragment: "{\\\"text\\\":\\\"runtime\\\"}" };
                yield { type: "tool_call_end", index: 0, id: "late-call", name: "late_echo", rawArguments: "{\\\"text\\\":\\\"runtime\\\"}", arguments: { text: "runtime" } };
                yield { type: "response_end", reason: "tool_calls", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
                return;
              }
              yield { type: "text_delta", part: 0, text: result.content };
              yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
            },
            async listModels(signal) {
              const authenticated = await api.auth.fetch("late-provider", ${JSON.stringify("__ORIGIN__")}, undefined, signal);
              if (!authenticated.ok || await authenticated.text() !== "ok") throw new Error("late provider credential unavailable");
              const capability = { value: "supported", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" };
              return [{ id: "late-model", provider: "late-provider", capabilities: { tools: capability, reasoning: capability, images: capability } }];
            },
          });
          api.registerProviderAuth({
            provider: "late-provider",
            credentialId: "late-account",
            displayName: "Late Provider",
            methods: [{ kind: "api_key", label: "Late access key", detail: "Stored in the secure credential store" }],
            request: { origins: [${JSON.stringify("__ORIGIN__")}], apiKey: { header: "x-api-key" } },
          });
          api.ui.notify("late runtime ready");
          api.onDispose(() => appendFile(${JSON.stringify(log)}, "disposed\\n"));
        });
      }
    `.replaceAll("__ORIGIN__", fixture.origin));

    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    const ui: string[] = [];
    runtime.runtimeExtensions.setUiHandler((operation) => ui.push(operation.value));
    const thread = await runtime.service.createSession();
    await runtime.runtimeExtensions.dispatch("session_start", { threadId: thread.threadId, workspace });

    assert.equal(runtime.providers.has("late-provider"), true);
    assert.equal(runtime.auth.has("late-provider"), true);
    assert.equal((await runtime.auth.state("late-provider")).status, "available");
    assert.equal(runtime.auth.methods("late-provider").find((method) => method.kind === "api_key")?.label, "Late access key");
    await assert.rejects(runtime.providers.get("late-provider").listModels(new AbortController().signal), /credentials are unavailable/u);
    await runtime.credentials.write("late-account", { kind: "api_key", provider: "late-account", apiKey: "late-secret" });
    assert.deepEqual((await runtime.providers.get("late-provider").listModels(new AbortController().signal)).map((model) => model.id), ["late-model"]);
    assert.equal(defaultSecretRedactor.redact("late-secret"), "[REDACTED]");
    assert.deepEqual(runtime.runtimeExtensions.commands().map((command) => command.name), ["late-command"]);
    assert.deepEqual(runtime.runtimeExtensions.renderers().map((renderer) => renderer.key), ["late_echo"]);
    assert.deepEqual(ui, ["late runtime ready"]);
    const run = await runtime.service.run({
      threadId: thread.threadId,
      prompt: "run late tool",
      provider: "late-provider",
      model: "late-model",
      allowedTools: ["late_echo"],
    });
    assert.equal(run.results.at(-1)?.finalText, "late:runtime");
    assert.ok(requests.length >= 3);
    assert.equal(requests.every((value) => value === "late-secret"), true);
    await runtime.credentials.write("late-account", { kind: "api_key", provider: "late-account", apiKey: "late-secret-two" });
    await runtime.providers.get("late-provider").listModels(new AbortController().signal);
    assert.equal(requests.at(-1), "late-secret-two");
    await runtime.auth.logout("late-provider");
    await assert.rejects(
      runtime.providers.get("late-provider").listModels(new AbortController().signal),
      /credentials are unavailable/u,
    );

    await runtime.close();
    assert.equal(runtime.providers.has("late-provider"), false);
    assert.equal(runtime.auth.has("late-provider"), false);
    assert.equal((await readFile(log, "utf8")).trim(), "disposed");
    await fixture.close();
  });
});

test("runtime provider auth cannot reuse another provider's credential binding", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const directory = join(configHome, "rigyn", "extensions", "credential-alias");
    await mkdir(join(directory, "runtime"), { recursive: true });
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "credential-alias",
      name: "Credential alias",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(directory, "runtime", "index.mjs"), `export default (api) => {
      api.registerProvider({
        id: "credential-alias-provider",
        async *stream() {},
        async listModels() { return []; },
      });
      api.registerProviderAuth({
        provider: "credential-alias-provider",
        credentialId: "openai",
        methods: [{ kind: "api_key" }],
      });
    };\n`);

    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    try {
      await runtime.credentials.write("openai", { kind: "api_key", provider: "openai", apiKey: "other-provider-secret" });
      assert.deepEqual(
        await runtime.providers.get("credential-alias-provider").listModels(new AbortController().signal),
        [],
      );
      assert.equal(runtime.auth.binding("credential-alias-provider").credentialId, "credential-alias-provider");
      assert.match(
        runtime.runtimeExtensions.diagnostics().map((entry) => entry.message).join("\n"),
        /credentialId.*another provider/u,
      );
    } finally {
      await runtime.close();
    }
  });
});

test("runtime provider auth resolves an offline ambient credential chain through the scoped API", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const requests: string[] = [];
    const fixture = await httpFixture((request, response) => {
      requests.push(request.headers.authorization ?? "");
      response.end("ok");
    });
    const previousAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const previousSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const previousSessionToken = process.env.AWS_SESSION_TOKEN;
    const accessKeyId = ["AKIA", "OFFLINEFIXTURE01"].join("");
    process.env.AWS_ACCESS_KEY_ID = accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = "ambient-secret-value";
    process.env.AWS_SESSION_TOKEN = "ambient-session-value";
    const directory = join(configHome, "rigyn", "extensions", "ambient-runtime");
    await mkdir(join(directory, "runtime"), { recursive: true });
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "ambient-runtime",
      name: "Ambient runtime",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(directory, "runtime", "index.mjs"), `export default (api) => {
      api.registerProvider({
        id: "ambient-provider",
        async *stream() {},
        async listModels(signal) {
          const response = await api.auth.fetch("ambient-provider", ${JSON.stringify("__ORIGIN__")}, undefined, signal);
          if (!response.ok || await response.text() !== "ok") {
            throw new Error("ambient credential unavailable");
          }
          return [];
        },
      });
      api.registerProviderAuth({
        provider: "ambient-provider",
        methods: [{ kind: "ambient", provider: "aws", label: "Workstation AWS identity", detail: "Default AWS credential chain" }],
        request: { origins: [${JSON.stringify("__ORIGIN__")}], awsSigV4: { region: "us-east-1", service: "execute-api" } },
      });
    };\n`.replaceAll("__ORIGIN__", fixture.origin));

    let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
    try {
      runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
      assert.equal(runtime.auth.methods("ambient-provider").find((method) => method.kind === "ambient")?.label, "Workstation AWS identity");
      assert.deepEqual(await runtime.providers.get("ambient-provider").listModels(new AbortController().signal), []);
      assert.match(requests[0] ?? "", new RegExp(`Credential=${accessKeyId}/`, "u"));
      assert.equal(defaultSecretRedactor.redact("ambient-secret-value ambient-session-value"), "[REDACTED] [REDACTED]");
    } finally {
      await runtime?.close();
      await fixture.close();
      if (previousAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = previousAccessKey;
      if (previousSecretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previousSecretKey;
      if (previousSessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
      else process.env.AWS_SESSION_TOKEN = previousSessionToken;
    }
  });
});

test("a pre-commit reload failure leaves the previous generation operational", async () => {
  await withRuntimeEnvironment(async ({ root, workspace, configHome }) => {
    const log = join(root, "rollback.log");
    await writeReloadExtension(configHome, log, "stable");
    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    try {
      const configDirectory = join(configHome, "rigyn");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "config.jsonc"), "{ invalid json");
      await assert.rejects(runtime.reload(), /config|JSON|line|column/iu);
      assert.deepEqual(await runtime.runtimeExtensions.runCommand("reload-probe", commandContext()), {
        handled: true,
        prompt: "stable:value",
      });
    } finally {
      await runtime.close();
    }
  });
});

test("database path changes are rejected without replacing the live generation", async () => {
  await withRuntimeEnvironment(async ({ root, workspace, configHome }) => {
    const log = join(root, "database.log");
    await writeReloadExtension(configHome, log, "database");
    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    try {
      const originalDatabase = runtime.databasePath;
      const configDirectory = join(configHome, "rigyn");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "config.jsonc"), JSON.stringify({ databasePath: join(root, "other.sqlite") }));
      await assert.rejects(runtime.reload(), /databasePath cannot change/u);
      assert.equal(runtime.databasePath, originalDatabase);
      assert.deepEqual(await runtime.runtimeExtensions.runCommand("reload-probe", commandContext()), {
        handled: true,
        prompt: "database:value",
      });
    } finally {
      await runtime.close();
    }
  });
});

test("runtime shutdown closes the stable store even when an extension disposer fails", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const directory = join(configHome, "rigyn", "extensions", "failing-disposer");
    await mkdir(join(directory, "runtime"), { recursive: true });
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "failing-disposer",
      name: "Failing disposer",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(directory, "runtime", "index.mjs"), `export default (api) => {
      api.onDispose(() => { throw new Error("disposer exploded"); });
    };\n`);
    const runtime = await loadRuntime({ workspace, extensions: true, extensionRuntime: true });
    await assert.rejects(runtime.close(), /disposer exploded/u);
    assert.throws(() => runtime.store.listThreads(), /closed|open|database/iu);
    await runtime.close();
  });
});
