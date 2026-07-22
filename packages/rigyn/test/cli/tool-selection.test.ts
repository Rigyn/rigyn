import assert from "node:assert/strict";
import test from "node:test";

import {
  activeToolsForSelection,
  defaultTools,
  selectedTools,
} from "../../src/cli/tool-selection.js";

const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

test("all built-in tools are active by default", () => {
  assert.deepEqual(defaultTools(), BUILTINS);
  assert.deepEqual(selectedTools({}, ["extension_probe"]), {
    allowedTools: [...BUILTINS, "extension_probe"],
  });
});

test("explicit tool policies preserve extension-only, empty, allowlist, and exclusion behavior", () => {
  assert.deepEqual(selectedTools({ noBuiltinTools: true }, ["extension_probe"]), {
    allowedTools: ["extension_probe"],
  });
  assert.deepEqual(selectedTools({ noTools: true }, ["extension_probe"]), {
    allowedTools: [],
  });
  assert.deepEqual(selectedTools({ tools: ["read", "extension_probe"] }, ["extension_probe"]), {
    allowedTools: ["read", "extension_probe"],
  });
  assert.deepEqual(
    activeToolsForSelection(
      [...BUILTINS, "extension_probe"],
      selectedTools({ excludeTools: ["bash", "extension_probe"] }, ["extension_probe"]),
    ),
    ["read", "edit", "write", "grep", "find", "ls"],
  );
});

test("persisted tool policy supplies defaults while invocation flags retain precedence", () => {
  const configured = { allowedTools: ["read", "extension_probe"], excludedTools: ["extension_probe"] };
  assert.deepEqual(selectedTools({}, ["extension_probe"], configured), configured);
  assert.deepEqual(selectedTools({ tools: ["bash"], excludeTools: ["read"] }, ["extension_probe"], configured), {
    allowedTools: ["bash"],
    excludedTools: ["extension_probe", "read"],
  });
  assert.deepEqual(selectedTools({ noBuiltinTools: true }, ["extension_probe"], configured), {
    allowedTools: ["extension_probe"],
    excludedTools: ["extension_probe"],
  });
});

test("mutually exclusive tool policies are rejected", () => {
  assert.throws(
    () => selectedTools({ noBuiltinTools: true, tools: ["read"] }),
    /mutually exclusive/u,
  );
});
