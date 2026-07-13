import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { RuntimeExtensionEvent } from "../../src/extensions/runtime.js";

const RUNTIME_EVENTS: Record<RuntimeExtensionEvent, true> = {
  resources_discover: true,
  session_start: true,
  session_info_changed: true,
  session_end: true,
  session_shutdown: true,
  session_before_switch: true,
  session_before_fork: true,
  session_before_tree: true,
  session_tree: true,
  session_before_compact: true,
  session_compact: true,
  before_agent_start: true,
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  tool_call: true,
  tool_result: true,
  context: true,
  input: true,
  model_select: true,
  thinking_level_select: true,
  before_provider_request: true,
  after_provider_response: true,
  before_user_shell: true,
  user_shell: true,
  theme_change: true,
  event: true,
};

test("runtime event reference documents every public event exactly once", async () => {
  const documentation = await readFile(resolve("docs/extension-events.md"), "utf8");
  const table = documentation.match(
    /<!-- RUNTIME_EXTENSION_EVENTS_START -->([\s\S]*?)<!-- RUNTIME_EXTENSION_EVENTS_END -->/u,
  )?.[1];
  assert.notEqual(table, undefined, "runtime event table markers are missing");

  const documented = [...table!.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]!);
  assert.equal(new Set(documented).size, documented.length, "runtime event table contains a duplicate event");
  assert.deepEqual(documented.toSorted(), Object.keys(RUNTIME_EVENTS).toSorted());

  const toolCall = table!.match(/^\| `tool_call` \|(.+)$/mu)?.[1];
  assert.notEqual(toolCall, undefined, "tool_call reference row is missing");
  for (const contract of [
    "threadId",
    "runId",
    "exact resolved `branch`",
    "top-level event is frozen",
    "Nested `input` remains mutable",
    "branch-safe state",
  ]) assert.ok(toolCall!.includes(contract), `tool_call reference is missing: ${contract}`);
});
