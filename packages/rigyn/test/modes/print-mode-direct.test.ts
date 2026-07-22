import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "../../src/core/events.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import type { AgentSession } from "../../src/service/agent-session.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import type { SessionContextMessage } from "../../src/storage/types.js";

interface PrintFixture {
  runtime: AgentSessionRuntime;
  prompted: Array<{ text: string; imageCount: number }>;
  bindCount(): number;
  disposeCount(): number;
}

function fixture(onPrompt?: (emit: (event: RuntimeEvent) => void, messages: SessionContextMessage[]) => void): PrintFixture {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const messages: SessionContextMessage[] = [];
  const prompted: Array<{ text: string; imageCount: number }> = [];
  let bound = 0;
  let disposed = 0;
  let rebind: (() => Promise<void>) | undefined;
  const session = {
    sessionManager: { getHeader: () => ({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }) },
    get state() { return { messages }; },
    async bindExtensions() { bound += 1; },
    subscribe(listener: (event: RuntimeEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text: string, options: { images?: unknown[] } = {}) {
      prompted.push({ text, imageCount: options.images?.length ?? 0 });
      const emit = (event: RuntimeEvent): void => { for (const listener of listeners) listener(event); };
      onPrompt?.(emit, messages);
      return { sessionId: "s", results: [] };
    },
  } as unknown as AgentSession;
  const runtime = {
    session,
    setRebindSession(callback: () => Promise<void>) { rebind = callback; },
    async dispose() { disposed += 1; },
    async triggerRebind() { await rebind?.(); },
  } as unknown as AgentSessionRuntime;
  return { runtime, prompted, bindCount: () => bound, disposeCount: () => disposed };
}

async function captureStdout<T>(operation: () => Promise<T>): Promise<{ result: T; output: string }> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += String(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await operation(), output };
  } finally {
    process.stdout.write = original;
  }
}

test("print mode binds the direct session, writes final assistant text, and disposes once", async () => {
  const value = fixture((_emit, messages) => {
    messages.push({
      id: "m",
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "stop",
    });
  });
  const captured = await captureStdout(() => runPrintMode(value.runtime, {
    mode: "text",
    initialMessage: "first",
    initialImages: [{ type: "image", mediaType: "image/png", data: "AA==" }],
    messages: ["second"],
  }));
  assert.equal(captured.result, 0);
  assert.equal(captured.output, "finished\n");
  assert.deepEqual(value.prompted, [{ text: "first", imageCount: 1 }, { text: "second", imageCount: 0 }]);
  assert.equal(value.bindCount(), 1);
  assert.equal(value.disposeCount(), 1);
});

test("JSON mode writes the header before raw events and rebinds after replacement", async () => {
  let turn = 0;
  const value = fixture((emit) => emit({ type: "warning", code: `event_${++turn}`, message: "fixture" }));
  const captured = await captureStdout(async () => {
    const running = runPrintMode(value.runtime, { mode: "json", initialMessage: "one", messages: ["two"] });
    await running;
    return 0;
  });
  const records = captured.output.trim().split("\n").map((line) => JSON.parse(line) as { type: string; code?: string });
  assert.deepEqual(records.map((record) => record.code ?? record.type), ["session", "event_1", "event_2"]);
  assert.equal(value.disposeCount(), 1);
});

test("assistant provider errors return a failing exit status", async () => {
  const value = fixture((_emit, messages) => {
    messages.push({
      id: "m",
      role: "assistant",
      content: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "error",
      errorMessage: "provider failed",
    });
  });
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (value: unknown) => { errors.push(String(value)); };
  try {
    assert.equal(await runPrintMode(value.runtime, { mode: "text", initialMessage: "go" }), 1);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, ["provider failed"]);
  assert.equal(value.disposeCount(), 1);
});
