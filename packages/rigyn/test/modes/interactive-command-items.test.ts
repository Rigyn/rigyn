import assert from "node:assert/strict";
import test from "node:test";

import { interactiveSkillCommands } from "../../src/modes/interactive-command-items.js";

test("same-name prompts own interactive discovery without mutating skills", () => {
  const skills = [
    { name: "rigyn-dev" },
    { name: "Rigyn-Dev" },
    { name: "review" },
  ];
  assert.deepEqual(
    interactiveSkillCommands(skills, ["rigyn-dev"]),
    [{ name: "Rigyn-Dev" }, { name: "review" }],
  );
  assert.deepEqual(skills, [
    { name: "rigyn-dev" },
    { name: "Rigyn-Dev" },
    { name: "review" },
  ]);
});
