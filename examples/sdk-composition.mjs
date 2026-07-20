import { createRigynSdk } from "rigyn/sdk";

const [provider, model, ...promptParts] = process.argv.slice(2);
if (!provider || !model || promptParts.length === 0) {
  console.error("Usage: node examples/sdk-composition.mjs <provider> <model> <prompt>");
  process.exitCode = 1;
} else {
  await using rigyn = await createRigynSdk({
    workspace: process.cwd(),
    defaultSelection: { provider, model },
    resources: {
      templates: [{ id: "task", template: "Complete this task and verify the result:\n\n{{input}}" }],
    },
    context: {
      appendSystemPrompt: [{ text: "Report concrete verification evidence.", source: "SDK example" }],
    },
  });
  const result = await rigyn.run({
    prompt: rigyn.renderPrompt("task", promptParts.join(" ")),
  });
  console.log(result.results.at(-1)?.finalText ?? "");
}
