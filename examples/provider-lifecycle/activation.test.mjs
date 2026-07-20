import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("provider lifecycle awaits one idempotent disposer per registration", async () => {
  let command;
  let registrations = 0;
  let disposals = 0;
  const notices = [];
  activate({
    registerProvider(provider) {
      assert.equal(provider.id, "lifecycle-offline");
      registrations += 1;
      let disposed = false;
      return async () => {
        if (disposed) return;
        disposed = true;
        disposals += 1;
      };
    },
    registerCommand(value) { command = value; },
  });
  const context = {
    args: "disable",
    ui: { notify(message) { notices.push(message); } },
  };
  await command.execute(context);
  await command.execute(context);
  assert.equal(registrations, 1);
  assert.equal(disposals, 1);

  await command.execute({ ...context, args: "enable" });
  assert.equal(registrations, 2);
  await command.execute(context);
  await command.execute(context);
  assert.equal(disposals, 2);
  assert.match(notices.at(-1), /disabled/u);
});
