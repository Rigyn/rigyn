import assert from "node:assert/strict";
import test from "node:test";

import activate from "../extensions/index.mjs";

function registrations() {
  let command;
  let tool;
  activate({
    registerCommand(name, registration) {
      command = { name, ...registration };
    },
    registerTool(registration) {
      tool = registration;
    },
  });
  assert.ok(command);
  assert.ok(tool);
  return { command, tool };
}

test("starter command notifies with the requested name", async () => {
  const { command } = registrations();
  const notices = [];
  await command.handler(" Ada ", {
    ui: { notify: (...notice) => notices.push(notice) },
  });
  assert.equal(command.name, "example-hello");
  assert.deepEqual(notices, [["Hello, Ada.", "info"]]);
});

test("starter tool returns a bounded canonical observation", async () => {
  const { tool } = registrations();
  assert.equal(tool.name, "example_text_length");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.text.maxLength, 4096);
  assert.deepEqual(await tool.execute("example-call", { text: "A🙂" }), {
    content: [{ type: "text", text: JSON.stringify({ codePoints: 2 }) }],
    details: { codePoints: 2 },
  });
});
