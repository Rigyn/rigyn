import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProviderRegistry } from "../../src/providers/index.js";
import { HarnessService } from "../../src/service/index.js";
import { SessionStore } from "../../src/storage/index.js";
import { ScriptedProvider } from "../../src/testing/index.js";
import type { ToolExecutionBackend } from "../../src/tools/index.js";

test("service routes model tools through its configured execution backend", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-service-backend-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const provider = new ScriptedProvider({
    id: "backend-provider",
    models: [{ id: "backend-model", capabilities: { tools: "supported" } }],
    scripts: [
      { kind: "turn", content: [{ type: "tool_call", id: "read-call", name: "read", arguments: { path: "missing.txt" } }] },
      { kind: "turn", content: [{ type: "text", text: "backend complete" }] },
    ],
  });
  const seen: string[] = [];
  const toolBackend: ToolExecutionBackend = {
    id: "service-fixture",
    handles(name) { return name === "read"; },
    resources(request) {
      seen.push(`resources:${request.invocation.name}`);
      return [{ kind: "workspace", key: "workspace", mode: "read" }];
    },
    async execute(request) {
      seen.push(`execute:${request.invocation.name}`);
      return { content: "isolated file contents", isError: false, status: "success", summary: "remote read" };
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    toolBackend,
  });
  t.after(async () => {
    await service.close("test complete");
    store.close();
  });
  await service.initialize({ skills: [] });

  const run = await service.run({
    prompt: "read remotely",
    provider: provider.id,
    model: "backend-model",
    allowedTools: ["read"],
  });

  assert.equal(run.results.at(-1)?.finalText, "backend complete");
  assert.deepEqual(seen, ["resources:read", "execute:read"]);
  const secondRequest = provider.capturedRequests()[1];
  assert.match(JSON.stringify(secondRequest?.messages), /isolated file contents/u);
});
