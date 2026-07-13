import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("run cancellation settles when the generic event observer never resolves", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-event-observer-cancel-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({
    id: "observer-cancel-provider",
    models: [{ id: "observer-cancel-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "must not complete" }] }],
  });
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const thread = await service.createSession();
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const pending = new Promise<void>(() => undefined);
  const running = service.run({
    threadId: thread.threadId,
    prompt: "cancel the blocked observer",
    provider: provider.id,
    model: "observer-cancel-model",
    onEvent() {
      markEntered();
      return pending;
    },
  });

  await within(entered, "event observer entry");
  service.cancel(thread.threadId, "cancel blocked event observer");
  const result = await within(running, "cancelled run settlement");

  assert.equal(result.results.at(-1)?.finishReason, "cancelled");
  assert.equal(store.listRuns(thread.threadId).at(-1)?.state, "cancelled");
});
