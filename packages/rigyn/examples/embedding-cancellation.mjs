import { writeFileSync } from "node:fs";

import { createInMemoryHarness } from "rigyn/embedding";
import { createScriptedProvider } from "rigyn/testing";

const usage = "node examples/embedding-cancellation.mjs";

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  writeFileSync(1, `${usage}\n`);
} else {
  const provider = createScriptedProvider({
    id: "example-cancellation",
    models: [{ id: "example-model" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "this response is cancelled" }],
      eventDelayMs: 1_000,
    }],
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "example-model",
    api: "openai-chat-completions",
  });
  const run = harness.session.start({ prompt: "cancel this run" });
  run.abort("example cancellation");
  const result = await run.result;
  writeFileSync(1, `${result.results.at(-1)?.finishReason ?? "unknown"}\n`);
}
