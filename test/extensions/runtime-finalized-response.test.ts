import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalMessage } from "../../src/core/types.js";
import {
  loadRuntimeExtensions,
  type RuntimeExtensionApi,
} from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";

type Cleanup = () => void | Promise<void>;

async function fixture(
  t: { after(callback: () => Promise<void>): void },
  source: string,
) {
  const root = await mkdtemp(join(tmpdir(), "rigyn-finalized-response-"));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "response-adjuster",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const cleanups: Cleanup[] = [async () => await host.close(), async () => await rm(root, { recursive: true, force: true })];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
  });
  return { root, host, cleanups };
}

const assistantMessage: CanonicalMessage = {
  id: "assistant-final",
  role: "assistant",
  provider: "scripted",
  content: [{ type: "text", text: "answer" }],
  createdAt: "2026-07-19T00:00:00.000Z",
};

test("message_end safely replaces finalized assistant accounting with durable provenance", async (t) => {
  const source = `export default (api) => {
    globalThis.__finalizedResponseApi = api;
    api.on("message_end", (event) => {
      if (event.finalized === undefined) return;
      globalThis.__finalizedResponseSeen = event.finalized;
      return {
        message: { ...event.message, displayText: "adjusted answer" },
        finalized: {
          finishReason: "refusal",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 8,
            cacheWriteTokens: 0,
            totalTokens: 20,
            reasoningTokens: 1,
            cost: "0.125"
          }
        }
      };
    });
    api.on("turn_end", (event) => { globalThis.__finalizedResponseTurn = event; });
    api.on("agent_end", (event) => { globalThis.__finalizedResponseAgent = event; });
  };\n`;
  const value = await fixture(t, source);
  const provider = new ScriptedProvider({
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "answer" }],
      usage: {
        inputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 5,
        cost: "0.01",
        raw: { authorization: "provider-secret" },
      },
      terminal: { type: "finish", reason: "stop" },
    }],
    models: [{ id: "finalized-model", contextTokens: 10_000 }],
  });
  const store = new SessionStore(join(value.root, "sessions.sqlite"));
  value.cleanups.unshift(() => store.close());
  const service = new HarnessService({
    store,
    workspace: value.root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: value.host,
  });
  await service.initialize();
  value.cleanups.unshift(async () => await service.close());

  const run = await service.run({ prompt: "answer", provider: provider.id, model: "finalized-model" });
  assert.equal(run.results[0]?.finishReason, "refusal");
  const seen = (globalThis as Record<string, unknown>).__finalizedResponseSeen as {
    usage: Record<string, unknown>;
  };
  assert.equal(Object.hasOwn(seen.usage, "raw"), false);

  const events = store.listEvents(run.threadId);
  const audit = events.find((entry) => entry.event.type === "assistant_response_transformed");
  assert.deepEqual(audit?.event, {
    type: "assistant_response_transformed",
    step: 1,
    transformations: [{ actor: "response-adjuster", fields: ["message", "finishReason", "usage"] }],
    original: {
      finishReason: "stop",
      usage: {
        inputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 5,
        cost: "0.01",
      },
    },
    final: {
      finishReason: "refusal",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
        totalTokens: 20,
        reasoningTokens: 1,
        cost: "0.125",
      },
    },
  });
  const usageEvents = events.filter((entry) => entry.event.type === "usage");
  assert.equal(usageEvents.length, 2);
  assert.deepEqual(usageEvents.at(-1)?.event, {
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      totalTokens: 20,
      reasoningTokens: 1,
      cost: "0.125",
    },
  });
  const assistantCompleted = events.findLast((entry) => entry.event.type === "assistant_completed");
  assert.equal(assistantCompleted?.event.type === "assistant_completed" ? assistantCompleted.event.finishReason : undefined, "refusal");
  const runCompleted = events.findLast((entry) => entry.event.type === "run_completed");
  assert.equal(runCompleted?.event.type === "run_completed" ? runCompleted.event.finishReason : undefined, "refusal");
  const assistant = events.findLast((entry) =>
    entry.event.type === "message_appended" && entry.event.message.role === "assistant");
  assert.equal(assistant?.event.type === "message_appended" ? assistant.event.message.displayText : undefined, "adjusted answer");

  const api = (globalThis as Record<string, unknown>).__finalizedResponseApi as RuntimeExtensionApi;
  const historical = await api.getSessionUsage({ threadId: run.threadId, branch: "main" });
  assert.deepEqual(historical.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 8,
    cacheWriteTokens: 0,
    totalTokens: 20,
    reasoningTokens: 1,
    cost: "0.125",
  });
  const turn = (globalThis as Record<string, unknown>).__finalizedResponseTurn as {
    outcome: { finishReason: string; usage?: unknown };
  };
  assert.equal(turn.outcome.finishReason, "refusal");
  assert.deepEqual(turn.outcome.usage, historical.usage);
  const agent = (globalThis as Record<string, unknown>).__finalizedResponseAgent as {
    outcome: { finishReason: string };
  };
  assert.equal(agent.outcome.finishReason, "refusal");

  delete (globalThis as Record<string, unknown>).__finalizedResponseApi;
  delete (globalThis as Record<string, unknown>).__finalizedResponseSeen;
  delete (globalThis as Record<string, unknown>).__finalizedResponseTurn;
  delete (globalThis as Record<string, unknown>).__finalizedResponseAgent;
});

test("message_end diagnoses invalid finalized usage and operationally unsafe finish reasons", async (t) => {
  const source = `export default (api) => {
    api.on("message_end", (event) => event.finalized === undefined ? undefined : ({
      finalized: { usage: { inputTokens: 1, totalTokens: 9 } }
    }));
    api.on("message_end", (event) => event.finalized === undefined ? undefined : ({
      finalized: { finishReason: "tool_calls" }
    }));
    api.on("message_end", (event) => {
      globalThis.__invalidFinalizedResponseSeen = event.finalized;
    });
  };\n`;
  const { host } = await fixture(t, source);
  const reduction = await host.reduceFinalizedMessageEnd({
    threadId: "thread-finalized",
    runId: "run-finalized",
    branch: "main",
    step: 1,
    message: assistantMessage,
    finalized: {
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cost: "0.02" },
    },
  });

  assert.deepEqual(reduction.message, assistantMessage);
  assert.deepEqual(reduction.finalized, {
    finishReason: "stop",
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cost: "0.02" },
  });
  assert.equal(reduction.transformations, undefined);
  assert.deepEqual((globalThis as Record<string, unknown>).__invalidFinalizedResponseSeen, reduction.finalized);
  assert.equal(host.diagnostics().filter((entry) => entry.message.includes("message_end")).length, 2);
  delete (globalThis as Record<string, unknown>).__invalidFinalizedResponseSeen;
});
