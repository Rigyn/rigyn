import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import {
  SCRIPTED_PROVIDER_LIMITS,
  createScriptedProvider,
  type ScriptedProviderStep,
} from "../../src/testing/index.js";
import type { HarnessTool } from "../../src/tools/types.js";

async function collect(iterable: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function providerRequest(provider: string, model = "model-a", sessionId = "session-a"): ProviderRequest {
  return {
    provider,
    model,
    messages: [{
      id: "message-1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    tools: [],
    sessionId,
  };
}

function terminalEvents(events: readonly AdapterEvent[]): AdapterEvent[] {
  return events.filter((event) => event.type === "response_end" || event.type === "error");
}

function usage(events: readonly AdapterEvent[]) {
  const event = events.find((candidate) => candidate.type === "usage");
  if (event?.type !== "usage") throw new Error("expected a usage event");
  return event.usage;
}

test("scripted provider queues model-aware factories and emits deterministic normalized fragments", async () => {
  const provider = createScriptedProvider({
    id: "offline-scripted",
    defaultFragmentCharacters: 3,
    models: [
      { id: "model-a", displayName: "Model A", capabilities: { reasoning: "unsupported" } },
      { id: "model-b", displayName: "Model B", capabilities: { reasoning: "supported" } },
    ],
  });
  provider.setScripts([
    ({ model, callCount, request }) => ({
      kind: "turn",
      responseId: `response-${callCount}`,
      content: [
        { type: "reasoning", text: `${model.id}:${request.messages.length}`, fragments: [model.id, ":1"] },
        { type: "text", text: "working", fragments: ["work", "ing"] },
        {
          type: "tool_call",
          name: "echo",
          arguments: { value: "fragmented" },
          fragments: ["{\"value\":", "\"fragmented\"}"],
        },
      ],
    }),
  ]);

  const events = await collect(provider.stream(providerRequest(provider.id, "model-b"), new AbortController().signal));
  assert.deepEqual(events.map((event) => event.type), [
    "response_start",
    "reasoning_delta",
    "reasoning_delta",
    "text_delta",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_end",
    "usage",
    "response_end",
  ]);
  assert.equal(events[0]?.type === "response_start" && events[0].responseId, "response-1");
  const fragments = events.flatMap((event) => event.type === "tool_call_delta" ? [event.jsonFragment] : []);
  assert.equal(fragments.join(""), "{\"value\":\"fragmented\"}");
  assert.deepEqual(
    events.find((event) => event.type === "tool_call_end"),
    {
      type: "tool_call_end",
      index: 0,
      id: "scripted_call_1_0",
      name: "echo",
      rawArguments: "{\"value\":\"fragmented\"}",
      arguments: { value: "fragmented" },
    },
  );
  assert.equal(provider.callCount, 1);
  assert.equal(provider.pendingScriptCount, 0);
  assert.deepEqual(provider.models.map((model) => model.id), ["model-a", "model-b"]);
  assert.equal(provider.getModel("model-b")?.capabilities.reasoning.value, "supported");

  const captured = provider.capturedRequests();
  assert.equal(captured.length, 1);
  captured[0]!.messages[0]!.content[0] = { type: "text", text: "mutated copy" };
  const retainedBlock = provider.capturedRequests()[0]?.messages[0]?.content[0];
  assert.equal(
    retainedBlock?.type === "text" ? retainedBlock.text : undefined,
    "hello",
  );
});

test("event scripts preserve explicit finishes and partial failures", async () => {
  const state = {
    kind: "chat_completions" as const,
    assistantMessage: { role: "assistant", content: "partial" },
  };
  const provider = createScriptedProvider({
    id: "event-scripted",
    models: [{ id: "model-a" }],
    scripts: [
      {
        kind: "events",
        events: [
          { type: "response_start", model: "model-a" },
          { type: "text_delta", part: 0, text: "short" },
          { type: "response_end", reason: "length", rawReason: "max_tokens", state },
        ],
      },
      {
        kind: "events",
        events: [
          { type: "response_start", model: "model-a" },
          { type: "text_delta", part: 0, text: "partial" },
          {
            type: "error",
            error: {
              category: "network",
              message: "connection reset",
              retryable: false,
              partial: true,
              bodyStarted: true,
            },
          },
        ],
      },
    ],
  });

  const finished = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
  const finishTerminal = finished.at(-1);
  assert.equal(finishTerminal?.type === "response_end" && finishTerminal.reason, "length");
  const failed = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
  const failureTerminal = failed.at(-1);
  assert.equal(failureTerminal?.type, "error");
  assert.equal(failureTerminal?.type === "error" && failureTerminal.error.partial, true);
  assert.equal(terminalEvents(failed).length, 1);
});

test("scripts are validated atomically and malformed factory output becomes one protocol terminal", async () => {
  assert.throws(() => createScriptedProvider({
    id: "malformed-unknown",
    models: [{ id: "model-a" }],
    scripts: [{ kind: "turn", content: [], unexpected: true } as unknown as ScriptedProviderStep],
  }), /unknown field "unexpected"/u);
  assert.throws(() => createScriptedProvider({
    id: "malformed-terminal",
    models: [{ id: "model-a" }],
    scripts: [{
      kind: "events",
      events: [{ type: "response_start", model: "model-a" }],
    }],
  }), /exactly one terminal/u);
  assert.throws(() => createScriptedProvider({
    id: "malformed-fragments",
    models: [{ id: "model-a" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "expected", fragments: ["different"] }],
    }],
  }), /concatenate exactly/u);
  assert.throws(() => createScriptedProvider({
    id: "too-many-scripts",
    models: [{ id: "model-a" }],
    scripts: Array.from({ length: SCRIPTED_PROVIDER_LIMITS.queuedScripts + 1 }, () => () => ({ kind: "turn" as const })),
  }), /queue exceeds/u);

  const provider = createScriptedProvider({ id: "factory-malformed", models: [{ id: "model-a" }] });
  provider.setScripts([async () => ({ kind: "turn", bad: true } as unknown as ScriptedProviderStep as never)]);
  const events = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.type === "error" && events[0].error.category, "protocol");
  assert.equal(terminalEvents(events).length, 1);
});

test("replace, append, immutable queueing, and captured-request bounds remain reusable", async () => {
  const first = {
    kind: "turn",
    content: [{ type: "text", text: "first" }],
  } satisfies ScriptedProviderStep;
  const provider = createScriptedProvider({
    id: "bounded-queue",
    models: [{ id: "model-a" }],
    maxCapturedRequests: 1,
  });
  provider.setScripts([first]);
  first.content[0]!.text = "caller mutation";
  provider.appendScripts([{ kind: "turn", content: [{ type: "text", text: "second" }] }]);
  assert.equal(provider.pendingScriptCount, 2);
  assert.throws(() => provider.appendScripts([{
    kind: "events",
    events: [{ type: "response_start", model: "model-a" }],
  }]), /exactly one terminal/u);
  assert.equal(provider.pendingScriptCount, 2);

  const firstEvents = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
  assert.equal(firstEvents.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join(""), "first");
  assert.equal(provider.pendingScriptCount, 1);

  const bounded = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0]?.type === "error" && bounded[0].error.category, "invalid_request");
  assert.equal(provider.pendingScriptCount, 1);
  provider.clearCapturedRequests();
  const secondEvents = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
  assert.equal(secondEvents.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join(""), "second");
  assert.equal(provider.callCount, 3);
});

test("cancellation at each stream phase yields one terminal and the provider remains reusable", async (t) => {
  await t.test("before streaming begins", async () => {
    const provider = createScriptedProvider({
      id: "abort-before",
      models: [{ id: "model-a" }],
      scripts: [{ kind: "turn", content: [{ type: "text", text: "unused" }] }],
    });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const events = await collect(provider.stream(providerRequest(provider.id), controller.signal));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type === "error" && events[0].error.category, "cancelled");
    assert.equal(events[0]?.type === "error" && events[0].error.partial, false);
    assert.equal(provider.pendingScriptCount, 0);
  });

  const abortTargets = ["response_start", "reasoning_delta", "text_delta", "tool_call_delta", "usage"] as const;
  for (const target of abortTargets) {
    await t.test(`after ${target}`, async () => {
      const provider = createScriptedProvider({
        id: `abort-${target}`,
        defaultFragmentCharacters: 1,
        models: [{ id: "model-a" }],
        scripts: [{
          kind: "turn",
          content: [
            { type: "reasoning", text: "reason" },
            { type: "text", text: "answer" },
            { type: "tool_call", id: "call", name: "echo", arguments: { value: "tool" } },
          ],
        }],
      });
      const controller = new AbortController();
      const events: AdapterEvent[] = [];
      for await (const event of provider.stream(providerRequest(provider.id), controller.signal)) {
        events.push(event);
        if (event.type === target) controller.abort(new Error(`cancel after ${target}`));
      }
      assert.equal(terminalEvents(events).length, 1);
      const terminal = terminalEvents(events)[0];
      assert.equal(terminal?.type, "error");
      assert.equal(terminal?.type === "error" && terminal.error.category, "cancelled");
      assert.equal(events.some((event) => event.type === "response_end"), false);
    });
  }

  await t.test("before factory resolution and then a follow-up turn", async () => {
    const provider = createScriptedProvider({
      id: "abort-factory",
      models: [{ id: "model-a" }],
      scripts: [
        async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          return { kind: "turn", content: [{ type: "text", text: "too late" }] };
        },
        { kind: "turn", content: [{ type: "text", text: "follow-up works" }] },
      ],
    });
    const controller = new AbortController();
    const firstPromise = collect(provider.stream(providerRequest(provider.id), controller.signal));
    setTimeout(() => controller.abort(new Error("cancel factory")), 5);
    const first = await firstPromise;
    assert.equal(first.length, 1);
    assert.equal(first[0]?.type === "error" && first[0].error.category, "cancelled");

    const followUp = await collect(provider.stream(providerRequest(provider.id), new AbortController().signal));
    assert.equal(followUp.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join(""), "follow-up works");
    assert.equal(followUp.at(-1)?.type, "response_end");
    assert.equal(provider.callCount, 2);
  });

  await t.test("during pacing before the first event", async () => {
    const provider = createScriptedProvider({
      id: "abort-delay",
      models: [{ id: "model-a" }],
      scripts: [{
        kind: "events",
        events: [
          { event: { type: "response_start", model: "model-a" }, delayMs: 100 },
          {
            type: "response_end",
            reason: "stop",
            state: { kind: "chat_completions", assistantMessage: { role: "assistant" } },
          },
        ],
      }],
    });
    const controller = new AbortController();
    const promise = collect(provider.stream(providerRequest(provider.id), controller.signal));
    setTimeout(() => controller.abort(), 5);
    const events = await promise;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type === "error" && events[0].error.partial, false);
  });
});

test("usage estimates isolate model caches and expose cache reads on repeated session prefixes", async () => {
  const provider = createScriptedProvider({
    id: "cache-scripted",
    models: [{ id: "model-a" }, { id: "model-b" }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "one" }] },
      { kind: "turn", content: [{ type: "text", text: "two" }] },
      { kind: "turn", content: [{ type: "text", text: "three" }] },
    ],
  });
  const first = await collect(provider.stream(providerRequest(provider.id, "model-a", "same-session"), new AbortController().signal));
  const second = await collect(provider.stream(providerRequest(provider.id, "model-a", "same-session"), new AbortController().signal));
  const switched = await collect(provider.stream(providerRequest(provider.id, "model-b", "same-session"), new AbortController().signal));

  assert.ok((usage(first).cacheWriteTokens ?? 0) > 0);
  assert.equal(usage(first).cacheReadTokens, 0);
  assert.ok((usage(second).cacheReadTokens ?? 0) > 0);
  assert.equal(usage(switched).cacheReadTokens, 0);
  for (const events of [first, second, switched]) {
    const value = usage(events);
    assert.equal(
      value.totalTokens,
      (value.inputTokens ?? 0) + (value.outputTokens ?? 0) +
        (value.cacheReadTokens ?? 0) + (value.cacheWriteTokens ?? 0),
    );
  }
});

test("registration cleanup unregisters the exact adapter and dispose clears bounded state", async () => {
  const provider = createScriptedProvider({
    id: "registered-scripted",
    models: [{ id: "model-a" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "ok" }] }],
  });
  const registry = new ProviderRegistry();
  const unregister = provider.register(registry);
  assert.equal(registry.get(provider.id), provider);
  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
  assert.equal(registry.has(provider.id), false);
  provider.register(registry);
  provider.dispose();
  assert.equal(registry.has(provider.id), false);
  assert.equal(provider.disposed, true);
  assert.equal(provider.pendingScriptCount, 0);
  await assert.rejects(provider.listModels(new AbortController().signal), /disposed/u);

  const active = createScriptedProvider({
    id: "disposed-active-scripted",
    defaultEventDelayMs: 100,
    models: [{ id: "model-a" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "never emitted" }] }],
  });
  const activeEvents = collect(active.stream(providerRequest(active.id), new AbortController().signal));
  setTimeout(() => active.dispose(), 5);
  const disposedEvents = await activeEvents;
  assert.equal(disposedEvents.length, 1);
  assert.equal(disposedEvents[0]?.type === "error" && disposedEvents[0].error.category, "cancelled");
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
const imageTool: HarnessTool = {
  definition: {
    name: "inspect_image",
    description: "Return one deterministic test image",
    inputSchema: { type: "object", additionalProperties: false },
  },
  validate(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("object required");
  },
  resources() {
    return [];
  },
  async execute() {
    return {
      content: "Attached deterministic pixel.",
      isError: false,
      images: [{ type: "image", mediaType: "image/png", data: png }],
    };
  },
};

test("agent tool round trip projects image results and survives a model switch with cache accounting", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "scripted-provider-agent-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(":memory:");
  t.after(() => store.close());
  const provider = createScriptedProvider({
    id: "agent-scripted",
    defaultFragmentCharacters: 2,
    models: [{ id: "model-a" }, { id: "model-b", capabilities: { reasoning: "supported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "tool_call", id: "image-call", name: "inspect_image", arguments: {} }],
      },
      ({ request }) => ({
        kind: "turn",
        content: [{ type: "text", text: request.model === "model-a" ? "saw image" : "wrong model" }],
      }),
      ({ model }) => ({
        kind: "turn",
        content: [
          { type: "reasoning", text: `using ${model.id}` },
          { type: "text", text: `continued on ${model.id}` },
        ],
      }),
    ],
  });
  const registry = new ProviderRegistry();
  provider.register(registry);
  const harness = new HarnessService({
    store,
    workspace,
    providers: registry,
    extraTools: [imageTool],
  });
  t.after(async () => await harness.close("test cleanup"));
  await harness.initialize({ skills: [] });

  const firstUsage: AdapterEvent[] = [];
  const first = await harness.run({
    prompt: "inspect the image",
    provider: provider.id,
    model: "model-a",
    noBuiltinTools: true,
    onEvent(event) {
      if (event.event.type === "usage") firstUsage.push({
        type: "usage",
        usage: event.event.usage,
        semantics: event.event.semantics,
      });
    },
  });
  assert.equal(first.results.at(-1)?.finalText, "saw image");
  assert.equal(first.results.at(-1)?.steps, 2);
  const secondRequest = provider.capturedRequests()[1];
  const imageResult = secondRequest?.messages.flatMap((message) => message.content).find(
    (block) => block.type === "tool_result" && block.callId === "image-call",
  );
  assert.equal(imageResult?.type, "tool_result");
  assert.deepEqual(imageResult?.type === "tool_result" ? imageResult.images : undefined, [
    { type: "image", mediaType: "image/png", data: png },
  ]);
  assert.ok(firstUsage.some((event) => event.type === "usage" && (event.usage.cacheReadTokens ?? 0) > 0));

  const switchedUsage: AdapterEvent[] = [];
  const switched = await harness.run({
    threadId: first.threadId,
    prompt: "continue",
    provider: provider.id,
    model: "model-b",
    noBuiltinTools: true,
    onEvent(event) {
      if (event.event.type === "usage") switchedUsage.push({
        type: "usage",
        usage: event.event.usage,
        semantics: event.event.semantics,
      });
    },
  });
  assert.equal(switched.results.at(-1)?.finalText, "continued on model-b");
  const thirdRequest = provider.capturedRequests()[2];
  assert.equal(thirdRequest?.model, "model-b");
  assert.equal(thirdRequest?.messages.some((message) => message.content.some(
    (block) => block.type === "text" && block.text === "saw image",
  )), true);
  assert.equal(switchedUsage.length, 1);
  assert.equal(switchedUsage[0]?.type === "usage" ? switchedUsage[0].usage.cacheReadTokens : undefined, 0);
  assert.ok(((switchedUsage[0]?.type === "usage" ? switchedUsage[0].usage.cacheWriteTokens : 0) ?? 0) > 0);
});

test("agent cancellation consumes one scripted turn and a later run on the session succeeds", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "scripted-provider-cancel-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(":memory:");
  t.after(() => store.close());
  const provider = createScriptedProvider({
    id: "agent-cancel-scripted",
    defaultFragmentCharacters: 1,
    defaultEventDelayMs: 1,
    models: [{ id: "model-a" }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "cancel this answer" }] },
      { kind: "turn", content: [{ type: "text", text: "recovered follow-up" }] },
    ],
  });
  const harness = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
  });
  t.after(async () => await harness.close("test cleanup"));
  await harness.initialize({ skills: [] });
  const session = await harness.createSession({ name: "cancel-reuse" });
  let cancelled = false;
  const first = await harness.run({
    threadId: session.threadId,
    prompt: "first",
    provider: provider.id,
    model: "model-a",
    noBuiltinTools: true,
    onEvent(event) {
      if (!cancelled && event.event.type === "text_delta") {
        cancelled = true;
        harness.cancel(session.threadId, "offline cancellation test");
      }
    },
  });
  assert.equal(first.results.at(-1)?.finishReason, "cancelled");

  const followUp = await harness.run({
    threadId: session.threadId,
    prompt: "second",
    provider: provider.id,
    model: "model-a",
    noBuiltinTools: true,
  });
  assert.equal(followUp.results.at(-1)?.finalText, "recovered follow-up");
  assert.equal(provider.callCount, 2);
});
