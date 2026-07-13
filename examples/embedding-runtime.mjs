import { createEmbeddingHarness } from "rigyn/embedding";

const usage = "node examples/embedding-runtime.mjs <provider> <model> <prompt>";
const [provider, model, ...promptParts] = process.argv.slice(2);

if (provider === "--help" || provider === "-h") {
  process.stdout.write(`${usage}\n`);
  process.exitCode = 0;
} else if (provider === undefined || model === undefined || promptParts.length === 0) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else {
  const runtime = await createEmbeddingHarness({ workspace: process.cwd() });
  let streamedText = false;
  try {
    const run = await runtime.run({
      provider,
      model,
      prompt: promptParts.join(" "),
      onEvent(envelope) {
        if (envelope.event.type !== "text_delta") return;
        streamedText = true;
        process.stdout.write(envelope.event.text);
      },
    });
    const final = run.results.at(-1);
    if (!streamedText && final?.finalText !== undefined) process.stdout.write(final.finalText);
    process.stdout.write("\n");
  } finally {
    await runtime.close();
  }
}
