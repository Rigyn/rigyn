import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveSessionOperations,
  type InteractiveSessionRuntime,
} from "../../src/modes/interactive-session-operations.js";
import { MissingSessionCwdError } from "../../src/service/agent-session-runtime.js";
import { TuiSelectionCancelledError, type TuiController } from "../../src/tui/controller.js";

test("/import offers the active cwd when the stored cwd is missing, then retries with the override", async () => {
  const calls: Array<[string, string | undefined, AbortSignal | undefined]> = [];
  const notifications: string[] = [];
  const choices: unknown[] = [true, "/active/workspace"];
  const choiceSignals: Array<AbortSignal | undefined> = [];
  const runtime = {
    session: {},
    cwd: "/active/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl(path: string, cwdOverride?: string, signal?: AbortSignal) {
      calls.push([path, cwdOverride, signal]);
      if (cwdOverride === undefined) {
        throw new MissingSessionCwdError({
          sessionFile: path,
          sessionCwd: "/old/workspace",
          fallbackCwd: "/active/workspace",
        });
      }
      return { cancelled: false };
    },
  } as unknown as InteractiveSessionRuntime;
  const terminal = {
    async choose(_prompt: string, _choices: unknown[], signal?: AbortSignal) {
      choiceSignals.push(signal);
      return choices.shift();
    },
    notify(message: string) { notifications.push(message); },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    resolveInputPath: (value) => value,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.importSession("/tmp/imported.jsonl", controller.signal);

  assert.deepEqual(calls, [
    ["/tmp/imported.jsonl", undefined, controller.signal],
    ["/tmp/imported.jsonl", "/active/workspace", controller.signal],
  ]);
  assert.deepEqual(choiceSignals, [controller.signal, controller.signal]);
  assert.deepEqual(notifications, ["Imported session from /tmp/imported.jsonl"]);
});

test("/import can be cancelled after reporting the missing stored cwd", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const notifications: string[] = [];
  const choices: unknown[] = [true, new TuiSelectionCancelledError()];
  const runtime = {
    session: {},
    cwd: "/active/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl(path: string, cwdOverride?: string) {
      calls.push([path, cwdOverride]);
      throw new MissingSessionCwdError({
        sessionFile: path,
        sessionCwd: "/old/workspace",
        fallbackCwd: "/active/workspace",
      });
    },
  } as unknown as InteractiveSessionRuntime;
  const terminal = {
    async choose() {
      const choice = choices.shift();
      if (choice instanceof Error) throw choice;
      return choice;
    },
    notify(message: string) { notifications.push(message); },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    resolveInputPath: (value) => value,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.importSession("/tmp/imported.jsonl");

  assert.deepEqual(calls, [["/tmp/imported.jsonl", undefined]]);
  assert.deepEqual(notifications, ["Import cancelled"]);
});
