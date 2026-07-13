import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { sha256 } from "../../src/tools/hash.js";

test("runtime session metadata is explicit, durable, observable, cancellable, and generation-bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-session-metadata-"));
  const sourcePath = join(root, "metadata.mjs");
  const source = `export default (api) => {
    globalThis.__sessionMetadataApi = api;
    globalThis.__sessionInfoEvents = [];
    globalThis.__sessionLabelEvents = [];
    api.on("session_info_changed", (event) => globalThis.__sessionInfoEvents.push(event));
    api.on("event", (event) => {
      if (event.event?.type === "entry_label_changed") globalThis.__sessionLabelEvents.push(event.event);
    });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "metadata.extension",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const databasePath = join(root, "sessions.sqlite");
  const store = new SessionStore(databasePath);
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry(),
    runtimeExtensions: host,
  });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("runtime_session_metadata_test");
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__sessionMetadataApi;
    delete (globalThis as Record<string, unknown>).__sessionInfoEvents;
    delete (globalThis as Record<string, unknown>).__sessionLabelEvents;
    await rm(root, { recursive: true, force: true });
  });

  const api = (globalThis as Record<string, any>).__sessionMetadataApi;
  const thread = await service.createSession({ threadId: "metadata-thread" });
  const target = store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "metadata-message",
        role: "user",
        content: [{ type: "text", text: "checkpoint" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  assert.deepEqual(await api.setSessionName({
    threadId: thread.threadId,
    branch: "main",
    name: "  Extension\nname  ",
  }), { threadId: thread.threadId, branch: "main", name: "Extension name" });
  assert.deepEqual((globalThis as Record<string, any>).__sessionInfoEvents, [{
    threadId: thread.threadId,
    branch: "main",
    name: "Extension name",
  }]);

  await service.setSessionName({ threadId: thread.threadId, branch: "main", name: "Host name" });
  assert.equal((globalThis as Record<string, any>).__sessionInfoEvents.at(-1).name, "Host name");
  assert.deepEqual(await api.setSessionName({ threadId: thread.threadId }), {
    threadId: thread.threadId,
    branch: "main",
  });
  assert.equal(store.getThread(thread.threadId).name, undefined);

  const labeled = await api.setEntryLabel({
    threadId: thread.threadId,
    targetEventId: target.eventId,
    label: "  before refactor  ",
  });
  assert.equal(labeled.label, "before refactor");
  assert.deepEqual(store.listEntryLabels(thread.threadId).map(({ targetEventId, label }) => ({ targetEventId, label })), [{
    targetEventId: target.eventId,
    label: "before refactor",
  }]);
  assert.deepEqual((globalThis as Record<string, any>).__sessionLabelEvents.at(-1), {
    type: "entry_label_changed",
    targetEventId: target.eventId,
    label: "before refactor",
  });

  const reopened = new SessionStore(databasePath);
  assert.equal(reopened.listEntryLabels(thread.threadId)[0]?.label, "before refactor");
  reopened.close();

  const cancelled = new AbortController();
  cancelled.abort(new Error("cancel metadata update"));
  await assert.rejects(api.setSessionName({
    threadId: thread.threadId,
    name: "must not persist",
    signal: cancelled.signal,
  }), /cancel metadata update/u);
  assert.equal(store.getThread(thread.threadId).name, undefined);
  await assert.rejects(api.setEntryLabel({
    threadId: thread.threadId,
    targetEventId: target.eventId,
    label: "must not persist",
    signal: cancelled.signal,
  }), /cancel metadata update/u);
  assert.equal(store.listEntryLabels(thread.threadId)[0]?.label, "before refactor");
  await assert.rejects(api.setSessionName({
    threadId: thread.threadId,
    requesterExtensionId: "spoofed",
    name: "invalid",
  }), /owner-controlled field/u);
  await assert.rejects(api.setEntryLabel({
    threadId: thread.threadId,
    targetEventId: "missing",
    label: "invalid",
  }), /Unknown label target/u);

  await host.close();
  await assert.rejects(api.setSessionName({ threadId: thread.threadId, name: "stale" }), /no longer active/u);
  assert.equal(store.getThread(thread.threadId).name, undefined);
});
