import { createInMemoryHarness } from "rigyn/embedding";
import { createScriptedProvider } from "rigyn/testing";

const usage = "node examples/embedding-in-memory.mjs [prompt]";
const prompt = process.argv.slice(2).join(" ");

if (prompt === "--help" || prompt === "-h") {
  process.stdout.write(`${usage}\n`);
} else {
  const provider = createScriptedProvider({
    id: "example-memory",
    models: [{ id: "example-model" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: `offline: ${prompt || "hello"}` }],
    }],
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "example-model",
  });
  const run = await harness.run({ prompt: prompt || "hello" });
  process.stdout.write(`${run.results.at(-1)?.finalText ?? ""}\n`);
}
