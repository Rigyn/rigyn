import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { loadRuntime, type LoadedRuntime } from "../../src/cli/runtime.js";
import type { EmbeddingModelSelection, EmbeddingSessionRunOptions } from "../../src/embedding/index.js";
import {
  OWNED_INTERACTIVE_COMMANDS,
  createOwnedInteractiveModeHost,
} from "../../src/modes/owned-interactive.js";
import type {
  InteractiveModeHostContext,
  InteractiveModeOwner,
  ModeSession,
} from "../../src/modes/index.js";
import type { HarnessRun } from "../../src/service/harness.js";
import { TuiController } from "../../src/tui/controller.js";

class RuntimeSession implements ModeSession {
  readonly threadId: string;
  readonly branch: string;
  readonly #runtime: LoadedRuntime;
  #selection: EmbeddingModelSelection | undefined;

  constructor(runtime: LoadedRuntime, threadId: string, branch: string) {
    this.#runtime = runtime;
    this.threadId = threadId;
    this.branch = branch;
  }

  async run(_options: EmbeddingSessionRunOptions): Promise<HarnessRun> {
    throw new Error("run is outside this interaction-host test");
  }

  steer(): void {}
  followUp(): void {}
  abort(): void {}
  getModel(): EmbeddingModelSelection | undefined { return this.#selection; }
  async setModel(selection: EmbeddingModelSelection): Promise<EmbeddingModelSelection> {
    this.#selection = { ...selection };
    return { ...selection };
  }
  async setName(name?: string): Promise<void> {
    await this.#runtime.service.setSessionName({ threadId: this.threadId, branch: this.branch, ...(name === undefined ? {} : { name }) });
  }
}

class RuntimeOwner implements InteractiveModeOwner {
  readonly #runtime: LoadedRuntime;
  constructor(runtime: LoadedRuntime) { this.#runtime = runtime; }

  async createSession(options = {}): Promise<ModeSession> {
    const thread = await this.#runtime.service.createSession(options);
    return new RuntimeSession(this.#runtime, thread.threadId, thread.defaultBranch);
  }

  async openSession(options: { threadId: string; branch?: string }): Promise<ModeSession> {
    const thread = this.#runtime.store.bindThreadWorkspace(options.threadId, this.#runtime.workspace);
    return new RuntimeSession(this.#runtime, thread.threadId, options.branch ?? thread.defaultBranch);
  }

  async listSessions(options = {}) { return await this.#runtime.service.listSessions(options); }
  async resourceCatalog(signal?: AbortSignal) { return await this.#runtime.service.resourceCatalog(signal); }
  async reload(options = {}) { return await this.#runtime.reload(options); }
}

test("owned interaction host repaints bounded history and semantically binds advertised resources", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-owned-mode-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const extension = join(root, "extension.mjs");
  await writeFile(extension, `export default (api) => api.registerCommand({
    name: "embedded-echo",
    description: "Test embedded routing",
    execute(context) {
      context.ui.notify("extension dialog reached");
      return "expanded:" + context.args;
    },
  });\n`, "utf8");
  await mkdir(join(root, ".rigyn"), { recursive: true });
  const runtime = await loadRuntime({
    workspace: root,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionPaths: [extension],
    extensionRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  context.after(async () => await runtime.close());

  const owner = new RuntimeOwner(runtime);
  let current = await owner.createSession({ name: "first" });
  runtime.store.appendEvent({
    threadId: current.threadId,
    branch: current.branch,
    event: {
      type: "message_appended",
      message: {
        id: "saved-assistant",
        createdAt: "2026-01-01T00:00:00.000Z",
        role: "assistant",
        content: [{ type: "text", text: "durable history" }],
      },
    },
  });

  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false, environment: {} });
  terminal.start();
  const lifecycle = new AbortController();
  let delegatedActions = 0;
  const host = createOwnedInteractiveModeHost(runtime, owner, {
    historyEvents: 32,
    historyBytes: 64 * 1024,
    delegatedCommands: {
      context: () => ({ action: "submit", text: "delegated context" }),
    },
    delegatedActions: {
      paste_image: () => { delegatedActions += 1; },
    },
  });
  let hostContext: InteractiveModeHostContext;
  hostContext = {
    terminal,
    signal: lifecycle.signal,
    session: () => current,
    replaceSession: async (session) => {
      current = session;
      await host.repaint(hostContext);
    },
    submit: async (text, images = []) => (await host.route(text, images, hostContext)).action === "handled",
    close: () => lifecycle.abort(new Error("closed")),
  };
  const detach = await host.attach(hostContext);
  context.after(async () => {
    await detach?.();
    terminal.close();
  });

  await host.repaint(hostContext);
  assert.match(Buffer.concat(chunks).toString("utf8"), /durable history/u);
  const expanded = await host.route("/embedded-echo value", [], hostContext);
  assert.deepEqual(expanded, { action: "submit", text: "expanded:value", images: [] });
  assert.match(Buffer.concat(chunks).toString("utf8"), /extension dialog reached/u);

  await host.action?.({
    type: "select",
    picker: "model",
    item: {
      id: "test/model",
      label: "test/model",
      value: { provider: "test", model: "model", reasoningEfforts: ["low", "high"] },
    },
  }, hostContext);
  assert.deepEqual(current.getModel(), { provider: "test", model: "model" });
  await host.action?.({ type: "cycle_thinking" }, hostContext);
  assert.deepEqual(current.getModel(), { provider: "test", model: "model", reasoningEffort: "low" });

  const second = await owner.createSession({ name: "second" });
  await host.route(`/resume ${second.threadId}`, [], hostContext);
  assert.equal(current.threadId, second.threadId);
  const info = await host.route("/session", [], hostContext);
  assert.deepEqual(info, { action: "handled" });
  assert.deepEqual(await host.route("/context", [], hostContext), {
    action: "submit",
    text: "delegated context",
    images: [],
  });
  await host.action?.({ type: "command", item: { id: "session", label: "/session", value: "/session" } }, hostContext);
  await host.action?.({ type: "paste_image" }, hostContext);
  assert.equal(delegatedActions, 1);

  const disposable = await owner.createSession({ name: "temporary" });
  const disposableItem = {
    id: disposable.threadId,
    label: "temporary",
    value: { threadId: disposable.threadId, branch: disposable.branch },
  };
  await host.action?.({
    type: "session_rename",
    item: disposableItem,
    name: "renamed",
    scope: "current",
    query: "",
  }, hostContext);
  assert.equal(runtime.store.getThread(disposable.threadId).name, "renamed");
  await host.action?.({
    type: "session_delete",
    item: disposableItem,
    scope: "current",
    query: "",
  }, hostContext);
  assert.throws(() => runtime.store.getThread(disposable.threadId), /Unknown thread/u);
  await host.route("/reload", [], hostContext);
  assert.equal((await host.route("/embedded-echo after-reload", [], hostContext)).action, "submit");

  assert.equal(new Set(OWNED_INTERACTIVE_COMMANDS.map((command) => command.name)).size, OWNED_INTERACTIVE_COMMANDS.length);
});
