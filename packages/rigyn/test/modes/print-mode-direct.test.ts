import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { RuntimeEvent } from "../../src/core/events.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import type { AgentSession, ExtensionBindings } from "../../src/service/agent-session.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import type { SessionContextMessage } from "../../src/storage/types.js";

interface PrintFixture {
  runtime: AgentSessionRuntime;
  prompted: Array<{ text: string; imageCount: number }>;
  promptImages: unknown[][];
  bindCount(): number;
  disposeCount(): number;
  binding(): ExtensionBindings | undefined;
  calls: string[];
  triggerRebind(session?: AgentSession): Promise<void>;
}

function fixture(
  onPrompt?: (
    emit: (event: RuntimeEvent) => void,
    messages: SessionContextMessage[],
  ) => void | Promise<void>,
  options: { blockedRecovery?: boolean } = {},
): PrintFixture {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const messages: SessionContextMessage[] = [];
  const prompted: Array<{ text: string; imageCount: number }> = [];
  const promptImages: unknown[][] = [];
  let bound = 0;
  let disposed = 0;
  let binding: ExtensionBindings | undefined;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  let beforeInvalidate: (() => void) | undefined;
  const calls: string[] = [];
  const session = {
    sessionManager: { getHeader: () => ({ type: "session", version: 4, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }) },
    get state() { return { messages }; },
    get suspendedRun() {
      return options.blockedRecovery === true
        ? { operationId: "interrupted-operation" }
        : undefined;
    },
    async recoverInterruptedRun() {
      calls.push("session:recover");
      return options.blockedRecovery === true
        ? {
            recovered: false,
            operationId: "interrupted-operation",
            blocked: [{
              effectId: "unsafe-effect",
              name: "write",
              reason: "the prior effect outcome is unknown",
            }],
          }
        : { recovered: false, blocked: [] };
    },
    async bindExtensions(value?: ExtensionBindings) { bound += 1; binding = value; },
    subscribe(listener: (event: RuntimeEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async waitForIdle() { calls.push("session:wait"); },
    async navigateTree(targetId: string, options: { summarize?: boolean }) {
      calls.push(`session:navigate:${targetId}:${options.summarize === true}`);
      return { cancelled: false };
    },
    async refresh() { calls.push("session:refresh"); },
    async prompt(text: string, options: { images?: unknown[] } = {}) {
      prompted.push({ text, imageCount: options.images?.length ?? 0 });
      promptImages.push(structuredClone(options.images ?? []));
      const emit = (event: RuntimeEvent): void => { for (const listener of listeners) listener(event); };
      await onPrompt?.(emit, messages);
      return { sessionId: "s", results: [] };
    },
  } as unknown as AgentSession;
  let currentSession = session;
  const runtime = {
    get session() { return currentSession; },
    setRebindSession(callback: (session: AgentSession) => Promise<void>) { rebind = callback; },
    setBeforeSessionInvalidate(callback?: () => void) { beforeInvalidate = callback; },
    async newSession(options: { parentSession?: string } = {}) {
      calls.push(`runtime:new:${options.parentSession ?? ""}`);
      return { cancelled: false };
    },
    async fork(entryId: string, options: { position?: string } = {}) {
      calls.push(`runtime:fork:${entryId}:${options.position ?? ""}`);
      return { cancelled: false };
    },
    async switchSession(path: string) {
      calls.push(`runtime:switch:${path}`);
      return { cancelled: false };
    },
    async refreshSession(
      expectedSession: AgentSession,
      refresh: (signal: AbortSignal) => Promise<AgentSession | void>,
      options: {
        signal?: AbortSignal;
        withSession?: (replacement: AgentSession) => Promise<void>;
      } = {},
    ) {
      assert.equal(expectedSession, session);
      const signal = options.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const replacement = await refresh(signal);
      signal.throwIfAborted();
      assert.equal(replacement, undefined);
      await options.withSession?.(session);
    },
    async dispose() { disposed += 1; },
    async triggerRebind(replacement = session) {
      beforeInvalidate?.();
      await rebind?.(replacement);
      currentSession = replacement;
    },
  } as unknown as AgentSessionRuntime;
  return {
    runtime,
    prompted,
    promptImages,
    bindCount: () => bound,
    disposeCount: () => disposed,
    binding: () => binding,
    calls,
    async triggerRebind(replacement = session) {
      beforeInvalidate?.();
      await rebind?.(replacement);
      currentSession = replacement;
    },
  };
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
    initialImages: [{ type: "image", mimeType: "image/JPG", data: "AA==" }],
    messages: ["second"],
  }));
  assert.equal(captured.result, 0);
  assert.equal(captured.output, "finished\n");
  assert.deepEqual(value.prompted, [{ text: "first", imageCount: 1 }, { text: "second", imageCount: 0 }]);
  assert.deepEqual(value.promptImages, [
    [{ type: "image", mediaType: "image/jpeg", data: "AA==" }],
    [],
  ]);
  assert.equal(value.bindCount(), 1);
  assert.equal(value.disposeCount(), 1);
  assert.equal(value.binding()?.mode, "print");
  const actions = value.binding()?.commandContextActions;
  assert.ok(actions);
  await actions.waitForIdle();
  await actions.newSession({ parentSession: "parent.jsonl" });
  await actions.fork("entry", { position: "at" });
  await actions.navigateTree("target", { summarize: true });
  await actions.switchSession("/tmp/session.jsonl");
  await actions.refresh();
  assert.deepEqual(value.calls, [
    "session:wait",
    "runtime:new:parent.jsonl",
    "runtime:fork:entry:at",
    "session:navigate:target:true",
    "runtime:switch:/tmp/session.jsonl",
    "session:refresh",
  ]);
});

test("print mode redacts extension and assistant failures before writing stderr", async () => {
  const secret = "sk-proj-print-mode-redaction-1234567890";
  const terminalControl = "\x1b[2J";
  defaultSecretRedactor.register(secret);
  let value: PrintFixture;
  value = fixture((_emit, messages) => {
    value.binding()?.onError?.({
      extensionPath: `/extensions/before-${secret}-after${terminalControl}.mjs`,
      event: "input",
      error: `extension-before-${secret}-after${terminalControl}`,
    });
    messages.push({
      id: "failure",
      role: "assistant",
      content: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "error",
      errorMessage: `assistant-before-${secret}-after${terminalControl}`,
    });
  });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items: unknown[]) => { errors.push(items.map(String).join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "text",
      initialMessage: "fail",
      write() {},
    }), 1);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
  assert.equal(errors.some((entry) => entry.includes(secret)), false);
  assert.equal(errors.every((entry) => entry.includes("[REDACTED]")), true);
  assert.equal(errors.some((entry) => entry.includes("\x1b")), false);
  assert.equal(errors.every((entry) => entry.includes("\\x1b[2J")), true);
});

test("print mode does not install process signal handlers", { concurrency: false }, async () => {
  let markPromptEntered!: () => void;
  let finishPrompt!: () => void;
  const promptEntered = new Promise<void>((resolve) => { markPromptEntered = resolve; });
  const promptFinished = new Promise<void>((resolve) => { finishPrompt = resolve; });
  const value = fixture(async () => {
    markPromptEntered();
    await promptFinished;
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = new Map(signals.map((signal) => [signal, getEventListeners(process, signal)]));

  const running = runPrintMode(value.runtime, {
    mode: "text",
    initialMessage: "wait",
    write() {},
  });
  await promptEntered;
  for (const signal of signals) {
    assert.deepEqual(getEventListeners(process, signal), before.get(signal));
  }
  finishPrompt();
  assert.equal(await running, 0);
  assert.equal(value.disposeCount(), 1);
});

test("print mode rejects the internal image shape at its public boundary and still disposes", async () => {
  const value = fixture();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items: unknown[]) => { errors.push(items.map(String).join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "text",
      initialMessage: "inspect",
      initialImages: [{ type: "image", mediaType: "image/png", data: "AA==" } as never],
      write() {},
    }), 1);
  } finally {
    console.error = original;
  }
  assert.deepEqual(value.prompted, []);
  assert.equal(value.disposeCount(), 1);
  assert.match(errors.join("\n"), /initialImages\[0\].*unsupported field mediaType/u);
});

test("print mode contains a hostile thrown value and still disposes", async () => {
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() { throw new Error("prototype trap must not run"); },
    get() { throw new Error("property trap must not run"); },
  });
  const value = fixture(() => { throw hostile; });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items: unknown[]) => { errors.push(items.join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, { mode: "text", initialMessage: "go" }), 1);
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, ["[Thrown object]"]);
  assert.equal(value.disposeCount(), 1);
});

test("JSON mode ignores a stale startup bind and writes the replacement session header", async () => {
  let releaseStartup!: () => void;
  let signalStartup!: () => void;
  const startupEntered = new Promise<void>((resolve) => { signalStartup = resolve; });
  const startupRelease = new Promise<void>((resolve) => { releaseStartup = resolve; });
  let replacementSubscriptions = 0;
  let replacementSubscriptionStarts = 0;
  let beforeInvalidate: (() => void) | undefined;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  const createSession = (id: string, waitForRelease: boolean): AgentSession => {
    const messages: SessionContextMessage[] = [];
    return {
      sessionManager: {
        getHeader: () => ({ type: "session", version: 4, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      },
      get state() { return { messages }; },
      async bindExtensions() {
        if (!waitForRelease) return;
        signalStartup();
        await startupRelease;
      },
      subscribe() {
        if (id === "replacement") {
          replacementSubscriptions += 1;
          replacementSubscriptionStarts += 1;
        }
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          if (id === "replacement") replacementSubscriptions -= 1;
        };
      },
      async prompt() {
        messages.push({
          id: `${id}-answer`,
          role: "assistant",
          content: [{ type: "text", text: id }],
          createdAt: "2026-01-01T00:00:00.000Z",
          stopReason: "stop",
        });
        return { sessionId: id, results: [] };
      },
    } as unknown as AgentSession;
  };
  const startup = createSession("startup", true);
  const replacement = createSession("replacement", false);
  let current = startup;
  const runtime = {
    get session() { return current; },
    setBeforeSessionInvalidate(callback?: () => void) { beforeInvalidate = callback; },
    setRebindSession(callback: (session: AgentSession) => Promise<void>) { rebind = callback; },
    async dispose() {},
  } as unknown as AgentSessionRuntime;

  const running = captureStdout(async () => await runPrintMode(runtime, {
    mode: "json",
    initialMessage: "go",
  }));
  await startupEntered;
  beforeInvalidate?.();
  await rebind?.(replacement);
  current = replacement;
  assert.equal(replacementSubscriptions, 1);
  releaseStartup();

  const captured = await running;
  assert.equal(captured.result, 0);
  const records = captured.output.trim().split("\n").map((line) => JSON.parse(line) as { type: string; id?: string });
  assert.deepEqual(records, [{
    type: "session",
    version: 4,
    id: "replacement",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
  }]);
  assert.equal(replacementSubscriptionStarts, 1);
  assert.equal(replacementSubscriptions, 0);
});

test("JSON mode writes the header before raw events and rebinds after replacement", async () => {
  let turn = 0;
  let value!: PrintFixture;
  value = fixture(async (emit) => {
    emit({ type: "warning", code: `event_${++turn}`, message: "fixture" });
    if (turn === 1) await value.triggerRebind();
  });
  const captured = await captureStdout(async () => {
    const running = runPrintMode(value.runtime, { mode: "json", initialMessage: "one", messages: ["two"] });
    await running;
    return 0;
  });
  const records = captured.output.trim().split("\n").map((line) => JSON.parse(line) as { type: string; code?: string });
  assert.deepEqual(records.map((record) => record.code ?? record.type), ["session", "event_1", "event_2"]);
  assert.equal(value.disposeCount(), 1);
  assert.equal(value.bindCount(), 2);
  assert.equal(value.binding()?.mode, "json");
});

test("print and JSON modes recover replacements or reject unresolved work before prompting", async () => {
  for (const mode of ["text", "json"] as const) {
    for (const blocked of [false, true]) {
      const order: string[] = [];
      const recoveryOptions: unknown[] = [];
      let value!: PrintFixture;
      let replacement!: AgentSession;
      value = fixture(async () => {
        order.push("initial:prompt");
        await value.triggerRebind(replacement);
      });
      const initial = value.runtime.session;
      let suspended = true;
      replacement = Object.create(initial) as AgentSession;
      Object.defineProperties(replacement, {
        suspendedRun: { get: () => suspended ? { operationId: "replacement-run" } : undefined },
        recoverInterruptedRun: { value: async (options?: unknown) => {
          order.push("replacement:recover");
          recoveryOptions.push(options);
          if (blocked) {
            return {
              recovered: false,
              operationId: "replacement-run",
              blocked: [{
                effectId: "unsafe-effect",
                name: "bash",
                reason: "recovery policy never_repeat requires an explicit decision",
              }],
            };
          }
          suspended = false;
          return { recovered: true, operationId: "replacement-run", blocked: [] };
        } },
        prompt: { value: async (text: string, options: { images?: unknown[] } = {}) => {
          order.push("replacement:prompt");
          assert.equal(suspended, false);
          value.prompted.push({ text, imageCount: options.images?.length ?? 0 });
          return { sessionId: "replacement", results: [] };
        } },
      });
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (error: unknown) => { errors.push(String(error)); };
      let status: number;
      try {
        status = await runPrintMode(value.runtime, {
          mode,
          initialMessage: "first",
          messages: ["second"],
          write() {},
        });
      } finally {
        console.error = originalError;
      }
      assert.equal(status, blocked ? 1 : 0, `${mode}:${blocked}`);
      assert.deepEqual(order, blocked
        ? ["initial:prompt", "replacement:recover"]
        : ["initial:prompt", "replacement:recover", "replacement:prompt"]);
      assert.deepEqual(recoveryOptions, [undefined]);
      assert.equal(value.bindCount(), 2);
      assert.equal(value.binding()?.mode, mode === "json" ? "json" : "print");
      assert.equal(value.prompted.length, blocked ? 1 : 2);
      assert.equal(errors.length, blocked ? 1 : 0);
      if (blocked) {
        assert.equal(errors[0], "Interrupted operation replacement-run requires an explicit recovery decision: unsafe-effect (bash): recovery policy never_repeat requires an explicit decision. Open an interactive session and use /recover, or use the RPC or SDK recovery API.");
      }
    }
  }
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

test("JSON assistant provider errors return a failing status without a human diagnostic", async () => {
  const value = fixture((emit, messages) => {
    emit({ type: "warning", code: "provider_failure", message: "provider failed" });
    messages.push({
      id: "m",
      role: "assistant",
      content: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "error",
      errorMessage: "provider failed",
    });
  });
  const errors: string[] = [];
  const output: string[] = [];
  const originalError = console.error;
  console.error = (message: unknown) => { errors.push(String(message)); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "json",
      initialMessage: "go",
      messages: ["must not run"],
      write(text) { output.push(text); },
    }), 1);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(output.map((line) => JSON.parse(line) as { type: string }).map((entry) => entry.type), [
    "session",
    "warning",
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(value.prompted, [{ text: "go", imageCount: 0 }]);
  assert.equal(value.disposeCount(), 1);
});

test("print mode reports blocked recovery before it sends a prompt", async () => {
  const value = fixture(undefined, { blockedRecovery: true });
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (message: unknown) => { errors.push(String(message)); };
  try {
    assert.equal(await runPrintMode(value.runtime, { mode: "text", initialMessage: "must wait" }), 1);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(value.calls, ["session:recover"]);
  assert.deepEqual(value.prompted, []);
  assert.equal(value.disposeCount(), 1);
  assert.deepEqual(errors, [
    "Interrupted operation interrupted-operation requires an explicit recovery decision: unsafe-effect (write): the prior effect outcome is unknown. Open an interactive session and use /recover, or use the RPC or SDK recovery API.",
  ]);
});
