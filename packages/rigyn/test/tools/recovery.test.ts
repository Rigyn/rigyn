import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import type { ToolDefinition } from "../../src/extensions/direct.js";
import {
  createHarnessToolFromDefinition,
  createToolDefinitionFromAgentTool,
  wrapToolDefinition,
} from "../../src/tools/direct-tool.js";
import {
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ShellTool,
  ToolRegistry,
  WriteTool,
} from "../../src/tools/index.js";
import type {
  DurableToolEffect,
  HarnessTool,
  ToolRecoveryContext,
  ToolRecoveryResult,
} from "../../src/tools/types.js";

function customTool(
  name: string,
  recovery?: HarnessTool["recovery"],
): HarnessTool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: "object" },
    },
    ...(recovery === undefined ? {} : { recovery }),
    validate() {},
    resources() { return []; },
    async execute() { return { content: "ok", isError: false }; },
  };
}

test("tool registries resolve omitted recovery conservatively and retain explicit contracts", async () => {
  const recover = async (
    effect: DurableToolEffect,
    context: ToolRecoveryContext,
  ): Promise<ToolRecoveryResult> => {
    context.signal.throwIfAborted();
    return effect.input === null
      ? { status: "not_applied" }
      : { status: "in_doubt", reason: effect.name };
  };
  const registry = new ToolRegistry([
    customTool("default"),
    customTool("read_only", { mode: "repeatable" }),
    customTool("inspectable", { mode: "reconcile", recover }),
  ]);

  assert.deepEqual(registry.recovery("default"), { mode: "never_repeat" });
  assert.deepEqual(registry.recovery("read_only"), { mode: "repeatable" });
  const inspectable = registry.recovery("inspectable");
  assert.equal(inspectable?.mode, "reconcile");
  assert.equal(inspectable?.mode === "reconcile" ? inspectable.recover : undefined, recover);
  assert.equal(Object.isFrozen(registry.recovery("default")), true);

  assert.throws(() => new ToolRegistry([
    customTool("invalid", { mode: "reconcile" } as never),
  ]), /must define recover/u);
});

test("built-in tools declare conservative effect recovery modes", () => {
  const registry = new ToolRegistry([
    new ReadTool(),
    new GrepTool(),
    new FindTool(),
    new LsTool(),
    new ShellTool(),
    new WriteTool(),
    new EditTool(),
  ]);

  assert.deepEqual(
    Object.fromEntries(registry.names().map((name) => [name, registry.recovery(name)?.mode])),
    {
      edit: "never_repeat",
      find: "repeatable",
      grep: "repeatable",
      ls: "repeatable",
      read: "repeatable",
      shell: "never_repeat",
      write: "never_repeat",
    },
  );
});

test("direct tool adapters default to never_repeat and preserve explicit policy", () => {
  const parameters = Type.Object({});
  const adaptedDefault = createHarnessToolFromDefinition({
    name: "direct_default",
    label: "Direct default",
    description: "default",
    parameters,
    async execute() { return { content: [], details: undefined }; },
  }, () => ({} as never));
  const adaptedRepeatable = createHarnessToolFromDefinition({
    name: "direct_repeatable",
    label: "Direct repeatable",
    description: "repeatable",
    parameters,
    recovery: { mode: "repeatable" },
    async execute() { return { content: [], details: undefined }; },
  }, () => ({} as never));
  const registry = new ToolRegistry([adaptedDefault, adaptedRepeatable]);

  assert.equal(registry.recovery("direct_default")?.mode, "never_repeat");
  assert.equal(registry.recovery("direct_repeatable")?.mode, "repeatable");
});

test("direct tool adapters preserve resource claims in both directions", async () => {
  const parameters = Type.Object({ path: Type.String() });
  const toolContext = { workspace: { root: "/workspace" } } as never;
  const claims = [{ kind: "file", key: "/workspace/output.txt", mode: "write" }] as const;
  const definition: ToolDefinition<typeof parameters> = {
    name: "direct_claims",
    label: "Direct claims",
    description: "claims",
    parameters,
    resources(input, context) {
      assert.equal(input.path, "output.txt");
      assert.equal(context.workspace.root, "/workspace");
      return [...claims];
    },
    async execute() { return { content: [], details: undefined }; },
  };

  const harness = createHarnessToolFromDefinition(definition, () => ({} as never));
  assert.deepEqual(await harness.resources({ path: "output.txt" }, toolContext), claims);

  const agent = wrapToolDefinition(definition);
  assert.deepEqual(await agent.resources?.({ path: "output.txt" }, toolContext), claims);

  const roundTrip = createToolDefinitionFromAgentTool(agent);
  assert.deepEqual(await roundTrip.resources?.({ path: "output.txt" }, toolContext), claims);
});
