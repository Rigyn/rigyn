import { createInMemoryHarness } from "rigyn/embedding";
import { createScriptedProvider } from "rigyn/testing";

const usage = "node examples/embedding-cancellation.mjs";

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  process.stdout.write(`${usage}\n`);
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
  });
  const run = await harness.start({ prompt: "cancel this run" });
  run.cancel("example cancellation");
  const result = await run.result;
  process.stdout.write(`${result.results.at(-1)?.finishReason ?? "unknown"}\n`);
}
