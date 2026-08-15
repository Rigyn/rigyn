import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import type { CommandOptions } from "../../src/extensions/capabilities/commands.js";
import {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionEventMap,
  type ToolResultEvent,
} from "../../src/extensions/capabilities/events.js";
import type { ProviderConfig } from "../../src/extensions/capabilities/provider.js";
import type { ReplacementOptions } from "../../src/extensions/capabilities/session.js";
import { defineTool } from "../../src/extensions/capabilities/tools.js";

test("direct capability modules can be consumed independently", () => {
  const command: CommandOptions = {
    handler(args) { return args; },
  };
  const event: ExtensionEventMap["input"] = {
    type: "input",
    text: "hello",
    source: "extension",
  };
  const provider = { models: [] } as unknown as ProviderConfig;
  const replacement: ReplacementOptions = { parentSession: "parent.jsonl" };
  const tool = defineTool({
    name: "capability_probe",
    description: "Capability module probe",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: input.value }], details: null };
    },
  });

  assert.equal(command.handler("/workspace", {} as never), "/workspace");
  assert.equal(event.source, "extension");
  assert.deepEqual(provider.models, []);
  assert.equal(replacement.parentSession, "parent.jsonl");
  assert.equal(tool.name, "capability_probe");
});

test("public tool guards discriminate exact tool names", () => {
  const event = (toolName: string): ToolResultEvent => ({
    type: "tool_result",
    toolCallId: "call-1",
    toolName,
    input: {},
    content: [],
    isError: false,
  });

  const guards = [
    ["bash", isBashToolResult],
    ["read", isReadToolResult],
    ["edit", isEditToolResult],
    ["write", isWriteToolResult],
    ["grep", isGrepToolResult],
    ["find", isFindToolResult],
    ["ls", isLsToolResult],
  ] as const;

  for (const [name, guard] of guards) {
    assert.equal(guard(event(name)), true, name);
    assert.equal(guard(event("custom")), false, name);
  }
  assert.equal(isToolCallEventType(event("custom"), "custom"), true);
  assert.equal(isToolCallEventType(event("custom"), "bash"), false);
});
