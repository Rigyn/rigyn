import assert from "node:assert/strict";
import test from "node:test";

import { reconcileProviderStateAfterContextRewrite } from "../../src/core/provider-state.js";
import type { CanonicalMessage, ProviderState } from "../../src/core/types.js";

const previousMessages: CanonicalMessage[] = [
  {
    id: "system",
    role: "system",
    purpose: "instructions",
    content: [{ type: "text", text: "old instructions" }],
    createdAt: "2026-07-26T00:00:00.000Z",
  },
  {
    id: "user",
    role: "user",
    content: [{ type: "text", text: "question" }],
    createdAt: "2026-07-26T00:00:01.000Z",
  },
  {
    id: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    createdAt: "2026-07-26T00:00:02.000Z",
  },
];

test("provider continuation reconciliation preserves exact prefixes and replays rewritten prefixes", () => {
  const state: ProviderState = {
    kind: "openai_responses",
    previousResponseId: "response-1",
    outputItems: [{ type: "message", id: "item-1" }],
    source: { provider: "openai", model: "model", api: "openai-responses" },
  };
  assert.deepEqual(
    reconcileProviderStateAfterContextRewrite(state, "assistant", previousMessages, structuredClone(previousMessages)),
    { providerState: state, providerStateMessageId: "assistant" },
  );

  const rewritten = structuredClone(previousMessages);
  rewritten[0] = {
    ...rewritten[0]!,
    content: [{ type: "text", text: "new instructions" }],
  };
  assert.deepEqual(
    reconcileProviderStateAfterContextRewrite(state, "assistant", previousMessages, rewritten),
    {
      providerState: {
        kind: "openai_responses",
        outputItems: [{ type: "message", id: "item-1" }],
        source: { provider: "openai", model: "model", api: "openai-responses" },
      },
      providerStateMessageId: "assistant",
    },
  );
});

test("provider continuation reconciliation handles stored interactions and unsafe owner changes", () => {
  const state: ProviderState = {
    kind: "gemini_interactions",
    previousInteractionId: "interaction-1",
    steps: [{ type: "model_output", id: "step-1" }],
  };
  const compacted = [
    {
      id: "summary",
      role: "user" as const,
      purpose: "compaction" as const,
      content: [{ type: "text" as const, text: "summary" }],
      createdAt: "2026-07-26T00:00:03.000Z",
    },
    previousMessages[2]!,
  ];
  assert.deepEqual(
    reconcileProviderStateAfterContextRewrite(state, "assistant", previousMessages, compacted),
    {
      providerState: {
        kind: "gemini_interactions",
        steps: [{ type: "model_output", id: "step-1" }],
      },
      providerStateMessageId: "assistant",
    },
  );

  const changedOwner = structuredClone(previousMessages);
  changedOwner[2] = { ...changedOwner[2]!, content: [{ type: "text", text: "changed answer" }] };
  assert.deepEqual(
    reconcileProviderStateAfterContextRewrite(state, "assistant", previousMessages, changedOwner),
    {},
  );
  assert.deepEqual(
    reconcileProviderStateAfterContextRewrite(
      { kind: "openai_responses", previousResponseId: "response-1", outputItems: [] },
      "assistant",
      previousMessages,
      compacted,
    ),
    {},
  );
});
