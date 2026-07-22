import { writeFileSync } from "node:fs";

import { createInMemoryHarness } from "rigyn/embedding";
import { createScriptedProvider } from "rigyn/testing";

const usage = "node examples/embedding-in-memory.mjs [prompt]";
const prompt = process.argv.slice(2).join(" ");

if (prompt === "--help" || prompt === "-h") {
  writeFileSync(1, `${usage}\n`);
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
    api: "openai-chat-completions",
  });
  const run = await harness.session.run({ prompt: prompt || "hello" });
  writeFileSync(1, `${run.results.at(-1)?.finalText ?? ""}\n`);
}
