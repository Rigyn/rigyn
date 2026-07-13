import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExtensionCatalog } from "../../src/extensions/loader.js";
import type { RuntimeExtensionHost } from "../../src/extensions/runtime.js";
import type { ExtensionBundle } from "../../src/extensions/types.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, QueueProvider, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

test("RPC discovers built-in and extension commands without exposing source templates", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-commands-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new QueueProvider([]));
  const bundle = {
    skillRoots: [],
    prompts: [{
      id: "review",
      extensionId: "fixture",
      description: "Review the change",
      sourcePath: "/private/prompt.md",
      sha256: "prompt-hash",
      template: "private prompt {{input}}",
    }],
    commands: [{
      name: "deploy",
      extensionId: "fixture",
      description: "Deploy safely",
      argumentHint: "TARGET",
      sourcePath: "/private/command.md",
      sha256: "command-hash",
      template: "private command {{args}}",
    }],
    themes: [],
    runtime: [],
  } satisfies ExtensionBundle;
  const catalog = new ExtensionCatalog([], [], bundle);
  await runtime.service.replaceRuntimeResources({
    providers: runtime.providers,
    projectTrusted: false,
    skills: [],
    extraTools: [],
    resourceCatalog: { extensions: catalog },
  });
  const runtimeExtensions = { commands: () => [] } as unknown as RuntimeExtensionHost;
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: { ...runtime, extensions: catalog, runtimeExtensions },
  });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
  });
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const result = await dispatcher.dispatch(new CapturePeer("commands"), request("commands.list")) as {
    builtins: Array<{ name: string; activePolicy: string }>;
    runtimeExtensions: Array<Record<string, unknown>>;
    extensionTemplates: Array<Record<string, unknown>>;
    prompts: Array<Record<string, unknown>>;
    skills: unknown[];
  };
  assert.equal(result.builtins.find((entry) => entry.name === "cancel")?.activePolicy, "cancel");
  assert.equal(result.builtins.find((entry) => entry.name === "follow")?.activePolicy, "follow_up");
  assert.deepEqual(result.runtimeExtensions, []);
  assert.deepEqual(result.extensionTemplates, [{
    name: "deploy",
    extensionId: "fixture",
    description: "Deploy safely",
    argumentHint: "TARGET",
  }]);
  assert.deepEqual(result.prompts, [{ id: "review", extensionId: "fixture", description: "Review the change" }]);
  assert.deepEqual(result.skills, []);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private command|\/private\//u);
});

test("RPC exports bounded HTML Markdown and legacy JSONL for workspace threads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-export-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new QueueProvider([]));
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
  });
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const peer = new CapturePeer("export");
  const thread = runtime.store.createThread({ workspaceRoot: root, name: "RPC export" });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "message-export",
        role: "assistant",
        content: [{ type: "text", text: "<script>alert('no')</script> café" }],
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    },
  });

  const legacy = await dispatcher.dispatch(peer, request("thread.export", { threadId: thread.threadId })) as { jsonl: string };
  assert.match(legacy.jsonl, /message-export/u);
  const markdown = await dispatcher.dispatch(peer, request("thread.export", {
    threadId: thread.threadId,
    format: "markdown",
  })) as { format: string; content: string; bytes: number };
  assert.equal(markdown.format, "markdown");
  assert.equal(markdown.bytes, Buffer.byteLength(markdown.content));
  assert.match(markdown.content, /café/u);
  const html = await dispatcher.dispatch(peer, request("thread.export", {
    threadId: thread.threadId,
    format: "html",
  })) as { format: string; content: string; bytes: number };
  assert.equal(html.format, "html");
  assert.match(html.content, /Content-Security-Policy/u);
  assert.match(html.content, /&lt;script&gt;alert\('no'\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html.content, /<script>alert/u);
  await assert.rejects(dispatcher.dispatch(peer, request("thread.export", {
    threadId: thread.threadId,
    format: "jsonl",
    branch: "main",
  })), /do not accept branch/u);

  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "message-large-export",
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
        createdAt: "2026-07-10T00:00:01.000Z",
      },
    },
  });
  await assert.rejects(
    dispatcher.dispatch(peer, request("thread.export", { threadId: thread.threadId, format: "markdown" })),
    /exceeds 2097152 bytes/u,
  );
});
