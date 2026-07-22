import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AssistantMessageEventStream as ModelsAssistantMessageEventStream,
  EventStream as ModelsEventStream,
  contentText as modelsContentText,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@rigyn/models";
import {
  Agent,
  AssistantMessageEventStream,
  EventStream,
  contentText,
  createAssistantEventStream,
  createSessionId,
} from "../../src/index.js";
import * as nodeEntry from "../../src/node.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const model: Model = {
  id: "boundary-model",
  name: "Boundary Model",
  api: "boundary",
  provider: "boundary",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("kernel preserves its root names while sharing model runtime identities", async () => {
  assert.equal(EventStream, ModelsEventStream);
  assert.equal(AssistantMessageEventStream, ModelsAssistantMessageEventStream);
  assert.equal(contentText, modelsContentText);

  const stream = createAssistantEventStream();
  assert.ok(stream instanceof ModelsAssistantMessageEventStream);
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "shared" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
  stream.push({ type: "done", reason: "stop", message });
  assert.equal(await stream.result(), message);
});

test("Agent consumes a models-owned assistant stream without an adapter", async () => {
  const runtime = new Agent({
    initialState: { model },
    streamFunction: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "direct" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "stop",
          timestamp: 2,
        },
      }));
      return stream;
    },
  });

  await runtime.prompt("boundary");
  const final = runtime.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.equal(final?.role === "assistant" ? modelsContentText(final.content) : "", "direct");
});

test("session IDs use the shared UUIDv7 contract and no private bridge remains", async () => {
  assert.match(createSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  await Promise.all([
    assert.rejects(access(join(packageRoot, "src/internal/uuid.ts"))),
    assert.rejects(access(join(packageRoot, "src/protocol.ts"))),
  ]);
  const storage = await readFile(join(packageRoot, "src/harness/session/jsonl-storage.ts"), "utf8");
  assert.match(storage, /import \{ uuidv7 \} from "@rigyn\/models";/u);
});

test("package and node entrypoints preserve the declared dependency boundary", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.["@rigyn/models"], "0.5.1");
  assert.equal(nodeEntry.Agent, Agent);
  assert.equal(typeof nodeEntry.NodeExecutionEnv, "function");
});
