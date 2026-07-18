import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { buildSystemPrompt } from "../../src/prompts/system.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { EditTool, ReadTool, ShellTool, WriteTool } from "../../src/tools/index.js";
import type { HarnessTool } from "../../src/tools/types.js";

const capability = { value: "supported", source: "configuration", observedAt: "2026-07-10T00:00:00.000Z" } as const;

test("built-in tool contracts contribute focused model-visible operating guidance", () => {
  const definitions = [new ReadTool(), new EditTool(), new WriteTool(), new ShellTool("bash")]
    .map((tool) => tool.definition);
  const prompt = buildSystemPrompt({
    workspace: "/workspace",
    instructions: { entries: [], totalBytes: 0, truncated: false },
    skills: [],
    selectedTools: definitions.map((definition) => definition.name),
    toolMetadata: definitions,
  });
  assert.match(prompt, /read: Read bounded text ranges/iu);
  assert.match(prompt, /continue with offset and limit/iu);
  assert.match(prompt, /make each oldText uniquely identify/iu);
  assert.match(prompt, /several separate changes.*one edit call/iu);
  assert.match(prompt, /oldText is matched against the original file/iu);
  assert.match(prompt, /inspect an existing file before overwriting/iu);
  assert.match(prompt, /bash for commands and verification/iu);
});

test("generic bash guidance is present only when bash is active", () => {
  const input = {
    workspace: "/workspace",
    instructions: { entries: [], totalBytes: 0, truncated: false },
    skills: [],
  };
  const withBash = buildSystemPrompt({ ...input, selectedTools: ["read", "bash"] });
  const withoutBash = buildSystemPrompt({ ...input, selectedTools: ["read"] });

  assert.match(withBash, /Use bash for file operations such as ls, rg, and find/iu);
  assert.doesNotMatch(withoutBash, /Use bash for file operations such as ls, rg, and find/iu);
});

test("active extension tool prompt metadata is model-visible without leaking inactive guidance", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-tool-prompt-"));
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "tool-prompt-fixture",
    async *stream(request): AsyncIterable<AdapterEvent> {
      requests.push(request);
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "tool-prompt-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const customTool: HarnessTool = {
    definition: {
      name: "workspace_index",
      description: "Query a prepared workspace index",
      inputSchema: { type: "object", additionalProperties: false },
      promptSnippet: "Query the prepared workspace index",
      promptGuidelines: ["Use workspace_index when a question requires indexed project facts."],
    },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "indexed", isError: false }; },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
    extraTools: [customTool],
  });
  try {
    await service.initialize({ skills: [] });
    await service.run({
      prompt: "Use the index",
      provider: provider.id,
      model: "tool-prompt-v1",
      noBuiltinTools: true,
      allowedTools: ["workspace_index"],
    });
    await service.run({
      prompt: "No tools",
      provider: provider.id,
      model: "tool-prompt-v1",
      noBuiltinTools: true,
      allowedTools: [],
    });
    const systemText = (request: ProviderRequest | undefined): string => request?.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? "";
    assert.match(systemText(requests[0]), /workspace_index: Query the prepared workspace index/u);
    assert.match(systemText(requests[0]), /Use workspace_index when a question requires indexed project facts/u);
    assert.doesNotMatch(systemText(requests[1]), /prepared workspace index|workspace_index/u);
  } finally {
    await service.close("tool_prompt_test");
    store.close();
  }
});

test("skills are advertised only when read is active", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-skill-prompt-"));
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "skill-prompt-fixture",
    async *stream(request): AsyncIterable<AdapterEvent> {
      requests.push(request);
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "skill-prompt-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
  });
  try {
    await service.initialize({
      skills: [{
        name: "review-guide",
        description: "Review changes with the project checklist",
        scope: "user",
        trusted: true,
        rootPath: workspace,
        directory: workspace,
        manifestPath: join(workspace, "SKILL.md"),
        metadataTruncated: false,
        metadata: {},
        disableModelInvocation: false,
      }],
    });
    await service.run({
      prompt: "Without read",
      provider: provider.id,
      model: "skill-prompt-v1",
      noBuiltinTools: true,
    });
    await service.run({
      prompt: "With read",
      provider: provider.id,
      model: "skill-prompt-v1",
      allowedTools: ["read"],
    });
    const systemText = (request: ProviderRequest | undefined): string => request?.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? "";
    assert.doesNotMatch(systemText(requests[0]), /review-guide/u);
    assert.match(systemText(requests[1]), /<name>review-guide<\/name>/u);
    assert.deepEqual(requests[0]?.tools?.map((tool) => tool.name), []);
    assert.deepEqual(requests[1]?.tools?.map((tool) => tool.name), ["read"]);
  } finally {
    await service.close("skill_prompt_test");
    store.close();
  }
});

test("run-level system prompt replacement and append text reach the model", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-system-prompt-"));
  await mkdir(join(workspace, ".rigyn"));
  await writeFile(join(workspace, ".rigyn", "SYSTEM.md"), "Automatic operating prompt.\0");
  await writeFile(join(workspace, ".rigyn", "APPEND_SYSTEM.md"), "Automatic appended prompt.");
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "prompt-fixture",
    async *stream(request, signal): AsyncIterable<AdapterEvent> {
      signal.throwIfAborted();
      requests.push(request);
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "prompt-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
  });
  try {
    await service.initialize({ skills: [] });
    await service.run({
      prompt: "Do the work",
      provider: provider.id,
      model: "prompt-v1",
      noBuiltinTools: true,
      systemPrompt: { text: "Follow the team's proof checklist.", source: "team.md" },
      appendSystemPrompt: [{ text: "Report the exact tests.", source: "verification.md" }],
    });
    const system = requests[0]?.messages.find((message) => message.role === "system")?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? "";
    assert.match(system, /Follow the team's proof checklist/u);
    assert.match(system, /Report the exact tests/u);
    assert.match(system, /Automatic appended prompt/u);
    assert.doesNotMatch(system, /Automatic operating prompt/u);
    assert.match(system, /Current date:/u);
    assert.match(system, /Current working directory:/u);
  } finally {
    await service.close("system_prompt_test");
    store.close();
  }
});

test("context-file disabling is invocation-scoped and preserves explicit embedded instructions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-context-files-"));
  const userInstructions = join(await mkdtemp(join(tmpdir(), "harness-user-context-files-")), "AGENTS.md");
  await writeFile(userInstructions, "global file rules");
  await writeFile(join(workspace, "AGENTS.md"), "workspace file rules");
  await mkdir(join(workspace, ".rigyn"));
  await writeFile(join(workspace, ".rigyn", "SYSTEM.md"), "automatic operating rules");
  await writeFile(join(workspace, ".rigyn", "APPEND_SYSTEM.md"), "automatic appended rules");
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "context-fixture",
    async *stream(request): AsyncIterable<AdapterEvent> {
      requests.push(request);
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "context-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
    userInstructions: { text: "embedded rules", source: "profile" },
    userInstructionFile: userInstructions,
  });
  try {
    await service.initialize({ skills: [] });
    const session = await service.createSession();
    await service.run({
      threadId: session.threadId,
      prompt: "First turn",
      provider: provider.id,
      model: "context-v1",
      noBuiltinTools: true,
      noContextFiles: true,
    });
    await service.run({
      threadId: session.threadId,
      prompt: "Second turn",
      provider: provider.id,
      model: "context-v1",
      noBuiltinTools: true,
    });
    const prompts = requests.map((request) => request.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"));
    assert.match(prompts[0] ?? "", /embedded rules/u);
    assert.doesNotMatch(
      prompts[0] ?? "",
      /global file rules|workspace file rules|automatic operating rules|automatic appended rules/u,
    );
    assert.match(prompts[1] ?? "", /global file rules/u);
    assert.match(prompts[1] ?? "", /workspace file rules/u);
    assert.match(prompts[1] ?? "", /automatic operating rules/u);
    assert.match(prompts[1] ?? "", /automatic appended rules/u);

    await writeFile(join(workspace, ".rigyn", "APPEND_SYSTEM.md"), "updated automatic append");
    await service.run({
      threadId: session.threadId,
      prompt: "Third turn",
      provider: provider.id,
      model: "context-v1",
      noBuiltinTools: true,
    });
    const thirdPrompt = requests[2]?.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? "";
    assert.match(thirdPrompt, /updated automatic append/u);
  } finally {
    await service.close("context_file_test");
    store.close();
  }
});

test("queued follow-up turns rediscover automatic context files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-context-refresh-"));
  await writeFile(join(workspace, "AGENTS.md"), "first turn rules");
  const requests: ProviderRequest[] = [];
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const firstRelease = new Promise<void>((resolve) => { release = resolve; });
  const provider: ProviderAdapter = {
    id: "context-refresh-fixture",
    async *stream(request): AsyncIterable<AdapterEvent> {
      requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      if (requests.length === 1) {
        started();
        await firstRelease;
      }
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "context-refresh-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
  });
  try {
    await service.initialize({ skills: [] });
    const session = await service.createSession();
    const running = service.run({
      threadId: session.threadId,
      prompt: "First turn",
      provider: provider.id,
      model: "context-refresh-v1",
      noBuiltinTools: true,
    });
    await firstStarted;
    await writeFile(join(workspace, "AGENTS.md"), "second turn rules");
    service.followUp(session.threadId, "Second turn");
    release();
    assert.equal((await running).results.length, 2);

    const prompts = requests.map((request) => request.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"));
    assert.match(prompts[0] ?? "", /first turn rules/u);
    assert.doesNotMatch(prompts[0] ?? "", /second turn rules/u);
    assert.match(prompts[1] ?? "", /second turn rules/u);
    assert.doesNotMatch(prompts[1] ?? "", /first turn rules/u);
  } finally {
    release();
    await service.close("context_refresh_test");
    store.close();
  }
});

test("continued sessions retain their nested instruction cwd", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-context-cwd-"));
  const nested = join(workspace, "packages", "app");
  await mkdir(nested, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "workspace root rules");
  await writeFile(join(nested, "AGENTS.md"), "nested app rules");
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "context-cwd-fixture",
    async *stream(request): AsyncIterable<AdapterEvent> {
      requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        id: "context-cwd-v1",
        provider: this.id,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
  });
  try {
    await service.initialize({ skills: [] });
    const session = await service.createSession({ cwd: nested });
    for (const prompt of ["First turn", "Second turn"]) {
      await service.run({
        threadId: session.threadId,
        prompt,
        provider: provider.id,
        model: "context-cwd-v1",
        noBuiltinTools: true,
      });
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const system = request.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      assert.match(system, /workspace root rules/u);
      assert.match(system, /nested app rules/u);
    }
  } finally {
    await service.close("context_cwd_test");
    store.close();
  }
});
