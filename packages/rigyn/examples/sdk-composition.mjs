import { writeFileSync } from "node:fs";

import { createAgentSession } from "rigyn/sdk";

const usage = "node examples/sdk-composition.mjs <provider> <model> <prompt>";
const [provider, model, ...promptParts] = process.argv.slice(2);

if (provider === "--help" || provider === "-h") {
  writeFileSync(1, `${usage}\n`);
} else if (!provider || !model || promptParts.length === 0) {
  writeFileSync(2, `${usage}\n`);
  process.exitCode = 2;
} else {
  const created = await createAgentSession({ cwd: process.cwd() });
  await using session = created.session;
  const selected = await session.resolveModel(model, { provider });
  await session.setModel(selected);
  const result = await session.prompt(
    `Complete this task and report concrete verification evidence:\n\n${promptParts.join(" ")}`,
  );
  console.log(result.results.at(-1)?.finalText ?? "");
}
