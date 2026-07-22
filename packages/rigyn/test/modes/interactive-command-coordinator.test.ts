import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERACTIVE_BUILTIN_COMMANDS,
  InteractiveCommandCoordinator,
  type InteractiveActionHandlers,
  type InteractiveCommandHandlers,
} from "../../src/modes/interactive-command-coordinator.js";
import type { PickerItem, TuiAction } from "../../src/tui/types.js";

test("interactive coordinator dispatches every built-in and canonical alias", async () => {
  const calls: Array<{ command: string; args: string; images: readonly string[] }> = [];
  const commands = Object.fromEntries(INTERACTIVE_BUILTIN_COMMANDS.map((command) => [
    command,
    (request: { args: string; images: readonly string[] }) => calls.push({ command, args: request.args, images: request.images }),
  ])) as unknown as InteractiveCommandHandlers<string>;
  const unknown: string[] = [];
  const coordinator = new InteractiveCommandCoordinator<string>({
    commands,
    unknownCommand(request) { unknown.push(request.command); return false; },
    submissions: { prompt() {}, shell() {} },
    actions: actionHandlers(),
  });

  for (const command of INTERACTIVE_BUILTIN_COMMANDS) {
    assert.equal(await coordinator.dispatchSlash(`/${command} first   second`, ["image"]), true);
  }
  assert.equal(await coordinator.dispatchSlash("/exit", []), true);
  assert.equal(await coordinator.dispatchSlash("/clear", []), true);
  assert.equal(await coordinator.dispatchSlash("/extension-command value", []), false);
  assert.deepEqual(calls.slice(0, INTERACTIVE_BUILTIN_COMMANDS.length).map((call) => call.command), [...INTERACTIVE_BUILTIN_COMMANDS]);
  assert.deepEqual(calls[0], { command: "cancel", args: "first second", images: ["image"] });
  assert.deepEqual(calls.slice(-2).map((call) => call.command), ["quit", "new"]);
  assert.deepEqual(unknown, ["extension-command"]);
});

test("interactive coordinator classifies slash, shell, hidden shell, and prompt submissions", async () => {
  const events: unknown[] = [];
  const coordinator = new InteractiveCommandCoordinator<string>({
    commands: Object.fromEntries(INTERACTIVE_BUILTIN_COMMANDS.map((command) => [
      command,
      () => events.push(["command", command]),
    ])) as unknown as InteractiveCommandHandlers<string>,
    unknownCommand() { return false; },
    submissions: {
      prompt(text, images) { events.push(["prompt", text, images]); },
      shell(request) { events.push(["shell", request]); },
    },
    actions: actionHandlers(),
  });

  await coordinator.dispatchSubmission("/help");
  await coordinator.dispatchSubmission("/unknown value", ["attachment"]);
  await coordinator.dispatchSubmission("! pwd ");
  await coordinator.dispatchSubmission("!! env");
  await coordinator.dispatchSubmission("hello", ["attachment"]);
  assert.deepEqual(events, [
    ["command", "help"],
    ["prompt", "/unknown value", ["attachment"]],
    ["shell", { command: "pwd", hidden: false, input: "! pwd " }],
    ["shell", { command: "env", hidden: true, input: "!! env" }],
    ["prompt", "hello", ["attachment"]],
  ]);
  await assert.rejects(async () => await coordinator.dispatchSubmission("! pwd", ["attachment"]), /do not accept image attachments/u);
});

test("interactive coordinator routes the complete TUI action surface", async () => {
  const calls: string[] = [];
  const coordinator = new InteractiveCommandCoordinator<never>({
    commands: Object.fromEntries(INTERACTIVE_BUILTIN_COMMANDS.map((command) => [command, () => {}])) as unknown as InteractiveCommandHandlers<never>,
    unknownCommand() { return false; },
    submissions: { prompt() {}, shell() {} },
    actions: actionHandlers(calls),
  });
  const item: PickerItem = { id: "fixture", label: "Fixture", value: "/tmp/session.jsonl" };
  const actions: TuiAction[] = [
    { type: "exit" },
    { type: "signal", signal: "SIGTERM" },
    { type: "error", error: new Error("fixture") },
    { type: "cancel" },
    { type: "submit", text: "hello" },
    { type: "steer", text: "now" },
    { type: "follow_up", text: "later" },
    { type: "dequeue" },
    { type: "queue_restore_discard" },
    { type: "session_open" },
    { type: "session_scope", scope: "all" },
    { type: "session_search", scope: "all", query: "needle" },
    { type: "session_more", scope: "all", query: "needle" },
    { type: "session_rename", item, name: "renamed", scope: "all", query: "" },
    { type: "session_delete", item, scope: "all", query: "" },
    { type: "select", picker: "session", item },
    { type: "select", picker: "model", item },
    { type: "command", item },
    { type: "copy" },
    { type: "copy_text", text: "value", label: "Value" },
    { type: "cycle_thinking" },
    { type: "extension_shortcut", shortcut: "ctrl+x", generation: new AbortController().signal },
    { type: "paste_image" },
    { type: "suspend" },
    { type: "select", picker: "provider", item },
  ];
  for (const action of actions) await coordinator.dispatchAction(action);
  assert.deepEqual(calls, [
    "exit", "exit", "error", "cancel", "submit", "active", "active", "dequeue", "queue",
    "catalog", "catalog", "catalog", "catalog", "mutation", "mutation", "session", "model",
    "command", "copy", "copyText", "thinking", "shortcut", "other", "other", "other",
  ]);
});

function actionHandlers(calls: string[] = []): InteractiveActionHandlers {
  return {
    exit() { calls.push("exit"); },
    error() { calls.push("error"); },
    cancel() { calls.push("cancel"); },
    submit() { calls.push("submit"); },
    activeSubmission() { calls.push("active"); },
    dequeue() { calls.push("dequeue"); },
    queueRestoreDiscard() { calls.push("queue"); },
    sessionCatalog() { calls.push("catalog"); },
    sessionMutation() { calls.push("mutation"); },
    selectSession() { calls.push("session"); },
    selectModel() { calls.push("model"); },
    command() { calls.push("command"); },
    copy() { calls.push("copy"); },
    copyText() { calls.push("copyText"); },
    cycleThinking() { calls.push("thinking"); },
    extensionShortcut() { calls.push("shortcut"); },
    other() { calls.push("other"); },
  };
}
