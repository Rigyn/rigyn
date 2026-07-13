import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeExtensionApi } from "../../src/extensions/runtime.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { sha256 } from "../../src/tools/hash.js";

test("runtime extensions receive bounded branch-safe transcript pages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-transcript-"));
  const source = "export default (api) => { globalThis.__runtimeTranscriptApi = api; };\n";
  const path = join(root, "extension.mjs");
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([
    { extensionId: "transcript.fixture", sourcePath: path, sha256: sha256(source) },
  ], { workspace: root });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({ store, workspace: root, providers: new ProviderRegistry(), runtimeExtensions: host });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("runtime_transcript_test");
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__runtimeTranscriptApi;
    await rm(root, { recursive: true, force: true });
  });

  const api = (globalThis as Record<string, unknown>).__runtimeTranscriptApi as RuntimeExtensionApi;
  const thread = store.createThread({ threadId: "runtime-transcript", workspaceRoot: root });
  const common = store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "common-message",
        role: "user",
        content: [{ type: "text", text: "common" }],
        createdAt: "2026-07-12T00:00:00.000Z",
      },
    },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: common.eventId });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "main-message",
        role: "assistant",
        content: [{ type: "text", text: "main only" }],
        createdAt: "2026-07-12T00:00:01.000Z",
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: {
      type: "message_appended",
      message: {
        id: "experiment-message",
        role: "assistant",
        content: [{ type: "text", text: "experiment only" }],
        createdAt: "2026-07-12T00:00:02.000Z",
      },
    },
  });

  const page = await api.getTranscript({ threadId: thread.threadId, branch: "experiment", limit: 1 });
  assert.equal(page.branch, "experiment");
  assert.deepEqual(page.entries.map((entry) => entry.text), ["common"]);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextSequence !== undefined);
  const second = await api.getTranscript({
    threadId: thread.threadId,
    branch: "experiment",
    afterSequence: page.nextSequence,
    limit: 1,
  });
  assert.deepEqual(second.entries.map((entry) => entry.text), ["experiment only"]);
  assert.equal(second.hasMore, false);

  second.entries[0]!.text = "mutated return";
  assert.equal((await api.getTranscript({ threadId: thread.threadId, branch: "experiment" })).entries.at(-1)?.text, "experiment only");
  await assert.rejects(api.getTranscript({ threadId: thread.threadId, branch: "experiment", limit: 257 }), /limit/u);
  await assert.rejects(api.getTranscript({
    threadId: thread.threadId,
    branch: "experiment",
    providerState: "owner controlled",
  } as never), /owner-controlled/u);
  const controller = new AbortController();
  controller.abort(new Error("stop replay"));
  await assert.rejects(api.getTranscript({ threadId: thread.threadId, signal: controller.signal }), /stop replay/u);
});
