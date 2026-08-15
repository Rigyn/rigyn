import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryHarness } from "../../src/embedding/index.js";
import type {
  ObservabilityRecord,
  ObservabilitySink,
} from "../../src/core/observability.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

class RecordingSink implements ObservabilitySink {
  readonly records: ObservabilityRecord[] = [];
  flushes = 0;
  closes = 0;
  record(record: ObservabilityRecord): void { this.records.push(record); }
  async flush(): Promise<void> { this.flushes += 1; }
  async close(): Promise<void> { this.closes += 1; }
}

test("embedding observability is opt-in and leaves the injected sink caller-owned", async () => {
  const sink = new RecordingSink();
  const provider = createScriptedProvider({
    id: "observability-fixture",
    models: [{ id: "fixture" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "private answer" }] }],
  });
  const harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
    observabilitySink: sink,
  });
  await harness.session.run({ prompt: "private prompt" });
  await harness.close();

  assert.equal(sink.records.some((record) => record.name === "run_started"), true);
  assert.equal(sink.records.some((record) => record.name === "run_completed"), true);
  assert.doesNotMatch(JSON.stringify(sink.records), /private prompt|private answer/u);
  assert.equal(sink.flushes, 1);
  assert.equal(sink.closes, 0);
});
