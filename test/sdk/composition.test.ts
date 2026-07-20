import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRigynSdk } from "../../src/sdk/index.js";
import { createScriptedProvider } from "../../src/testing/index.js";
import type { HarnessTool } from "../../src/tools/types.js";

const sdkTool: HarnessTool = {
  definition: {
    name: "sdk_echo",
    description: "Return a value supplied by the model.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  validate() {},
  resources() { return []; },
  async execute(input) {
    const value = typeof input === "object" && input !== null && !Array.isArray(input)
      ? input["value"]
      : undefined;
    return { content: typeof value === "string" ? value : "", isError: false };
  },
};

test("SDK composition runs, stays narrow, and survives runtime reload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-sdk-composition-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const resources = join(root, "resources");
  const skill = join(resources, "sdk-skill");
  const prompts = join(resources, "prompts");
  await mkdir(workspace);
  await mkdir(skill, { recursive: true });
  await mkdir(prompts, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), `---
name: sdk-skill
description: A portable SDK composition fixture.
---

Use the SDK composition fixture.
`);
  await writeFile(join(prompts, "sdk-path-prompt.md"), "Path prompt: {{input}}\n");
  const extensionPath = join(root, "sdk-extension.mjs");
  await writeFile(extensionPath, `export default function activate(api) {
    globalThis.__rigynSdkActivations = (globalThis.__rigynSdkActivations ?? 0) + 1;
    api.registerTool({
      name: "extension_echo",
      description: "Extension-owned control tool.",
      inputSchema: { type: "object", additionalProperties: false },
      execute() { return { content: "extension", isError: false }; },
    });
    api.on("agent_start", () => {
      globalThis.__rigynSdkAgentStarts = (globalThis.__rigynSdkAgentStarts ?? 0) + 1;
    });
  }
`);

  const priorConfig = process.env.XDG_CONFIG_HOME;
  const priorState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  t.after(() => {
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
    if (priorState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorState;
    delete (globalThis as Record<string, unknown>).__rigynSdkActivations;
    delete (globalThis as Record<string, unknown>).__rigynSdkAgentStarts;
  });

  const provider = createScriptedProvider({
    id: "sdk-scripted",
    models: [{ id: "sdk-model", capabilities: { tools: "supported" } }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "first" }] },
      { kind: "turn", content: [{ type: "text", text: "second" }] },
    ],
  });
  let factoryDisposed = 0;
  let factoryAborted = false;
  const sdk = await createRigynSdk({
    workspace,
    defaultSelection: { provider: provider.id, model: "sdk-model" },
    extensions: {
      paths: [extensionPath],
      factories: [({ signal }) => {
        signal.addEventListener("abort", () => { factoryAborted = true; }, { once: true });
        return {
          providers: [provider],
          tools: [sdkTool],
          context: {
            appendSystemPrompt: [{ text: "SDK_CONTEXT_MARKER", source: "SDK test" }],
          },
          dispose: () => { factoryDisposed += 1; },
        };
      }],
    },
    resources: {
      loaders: [() => ({
        skillPaths: [skill],
        promptTemplatePaths: [prompts],
        templates: [{ id: "sdk-inline", template: "Inline: {{input}}" }],
      })],
    },
    runtime: { recover: false, projectTrusted: false },
  });
  t.after(async () => await sdk.close().catch(() => undefined));

  for (const privateProperty of ["auth", "config", "credentials", "providers", "service", "store"]) {
    assert.equal(privateProperty in sdk, false);
  }
  assert.equal(sdk.renderPrompt("sdk-inline", "hello"), "Inline: hello");
  assert.deepEqual(sdk.promptTemplates().map((entry) => entry.id), ["sdk-inline"]);

  const before = await sdk.resourceCatalog();
  assert.ok(before.tools.some((tool) => tool.name === "sdk_echo" && tool.owner.kind === "host"));
  assert.ok(before.tools.some((tool) => tool.name === "extension_echo" && tool.owner.kind === "extension"));
  assert.ok(before.skills.some((entry) => entry.name === "sdk-skill"));
  assert.ok(before.prompts.some((entry) => entry.id === "sdk-path-prompt"));
  assert.ok(before.providers.some((entry) => entry.id === provider.id));

  assert.equal((await sdk.run({ prompt: "one" })).results.at(-1)?.finalText, "first");
  const firstRequest = provider.capturedRequests()[0];
  assert.ok(firstRequest?.tools.some((tool) => tool.name === "sdk_echo"));
  assert.match(JSON.stringify(firstRequest?.messages), /SDK_CONTEXT_MARKER/u);
  assert.equal((globalThis as Record<string, unknown>).__rigynSdkAgentStarts, 1);

  await sdk.reload();
  const after = await sdk.resourceCatalog();
  assert.ok(after.tools.some((tool) => tool.name === "sdk_echo" && tool.owner.kind === "host"));
  assert.ok(after.tools.some((tool) => tool.name === "extension_echo" && tool.owner.kind === "extension"));
  assert.ok(after.skills.some((entry) => entry.name === "sdk-skill"));
  assert.ok(after.providers.some((entry) => entry.id === provider.id));
  assert.equal((globalThis as Record<string, unknown>).__rigynSdkActivations, 2);
  assert.equal((await sdk.run({ prompt: "two" })).results.at(-1)?.finalText, "second");

  await sdk.close();
  assert.equal(factoryAborted, true);
  assert.equal(factoryDisposed, 1);
  await sdk.close();
  assert.equal(factoryDisposed, 1);
});

test("SDK rejects duplicate programmatic provider IDs before opening a runtime", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-sdk-duplicates-"));
  const first = createScriptedProvider({ id: "duplicate-sdk" });
  const second = createScriptedProvider({ id: "duplicate-sdk" });
  await assert.rejects(
    createRigynSdk({ workspace, providers: [first, second], extensions: { enabled: false } }),
    /Duplicate SDK provider/u,
  );
});

test("SDK aborts and disposes completed factories when later composition fails", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-sdk-factory-failure-"));
  let aborted = false;
  let disposed = 0;
  await assert.rejects(
    createRigynSdk({
      workspace,
      extensions: {
        enabled: false,
        factories: [
          ({ signal }) => {
            signal.addEventListener("abort", () => { aborted = true; }, { once: true });
            return { dispose: () => { disposed += 1; } };
          },
          () => { throw new Error("factory failed"); },
        ],
      },
    }),
    /factory failed/u,
  );
  assert.equal(aborted, true);
  assert.equal(disposed, 1);
});
