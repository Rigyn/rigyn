import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

interface Capability {
  id: string;
  status: "implemented" | "intentionally-different" | "missing" | "rejected-for-safety";
  authoring: boolean;
  hosts: string[];
  apiMembers: string[];
  docs: string[];
  examples: string[];
  tests: string[];
}

const exampleRoots = new Set([
  "examples/starter",
  "examples/lifecycle-events",
  "examples/command-controls",
  "examples/tool-rendering",
  "examples/input-guard",
  "examples/ui-surfaces",
  "examples/context-compaction",
  "examples/messages-bus",
  "examples/model-controls",
  "examples/provider-override",
  "examples/raw-editor-ui",
  "examples/session-jsonl",
  "examples/session-control",
  "examples/session-metadata",
  "examples/subprocess-workers",
  "examples/dynamic-package",
  "examples/provider-hooks",
  "examples/runtime-catalog",
  "examples/session-lifecycle",
  "examples/provider-catalog",
  "examples/terminal-workbench",
  "examples/project-trust",
]);

test("direct extension capability matrix references current docs, examples, and tests", async () => {
  const matrix = JSON.parse(await readFile(resolve("docs/extension-capabilities.json"), "utf8")) as {
    schemaVersion: number;
    hosts: string[];
    capabilities: Capability[];
  };
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(matrix.hosts, ["tui", "print", "json", "rpc", "embedding"]);
  assert.equal(new Set(matrix.capabilities.map((entry) => entry.id)).size, matrix.capabilities.length);
  assert.equal(matrix.capabilities.every((entry) => entry.status === "implemented"), true);

  for (const capability of matrix.capabilities) {
    assert.match(capability.id, /^[a-z][a-z0-9-]*$/u);
    assert.equal(new Set(capability.hosts).size, capability.hosts.length);
    assert.ok(capability.hosts.every((host) => matrix.hosts.includes(host)));
    assert.ok(capability.docs.length > 0, `${capability.id} has no documentation`);
    assert.ok(capability.tests.length > 0, `${capability.id} has no verification`);
    if (capability.authoring) assert.ok(capability.examples.length > 0, `${capability.id} has no authoring reference`);
    assert.ok(capability.examples.every((path) => exampleRoots.has(path)), `${capability.id} references an obsolete example`);
    for (const path of [...capability.docs, ...capability.examples, ...capability.tests]) await access(resolve(path));
    for (const member of capability.apiMembers) assert.match(member, /^[A-Za-z][A-Za-z0-9]*$/u);
  }

  assert.deepEqual(new Set(matrix.capabilities.flatMap((entry) => entry.examples)), exampleRoots);
  assert.deepEqual(
    matrix.capabilities.find((entry) => entry.id === "trusted-editor-ui")?.hosts,
    ["tui"],
  );
});
