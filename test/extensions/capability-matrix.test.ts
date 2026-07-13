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

test("extension capability matrix references real docs, examples, tests, and public API members", async () => {
  const matrix = JSON.parse(await readFile(resolve("docs/extension-capabilities.json"), "utf8")) as {
    schemaVersion: number;
    hosts: string[];
    capabilities: Capability[];
  };
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(matrix.hosts, ["tui", "print", "json", "rpc", "embedding"]);
  assert.equal(new Set(matrix.capabilities.map((entry) => entry.id)).size, matrix.capabilities.length);
  const runtimeSource = await readFile(resolve("src/extensions/runtime.ts"), "utf8");

  for (const capability of matrix.capabilities) {
    assert.match(capability.id, /^[a-z][a-z0-9-]*$/u);
    assert.ok(["implemented", "intentionally-different", "missing", "rejected-for-safety"].includes(capability.status));
    assert.equal(new Set(capability.hosts).size, capability.hosts.length);
    assert.ok(capability.hosts.every((host) => matrix.hosts.includes(host)));
    assert.ok(capability.docs.length > 0, `${capability.id} has no documentation`);
    assert.ok(capability.tests.length > 0, `${capability.id} has no verification`);
    if (capability.authoring) assert.ok(capability.examples.length > 0, `${capability.id} has no authoring reference`);
    for (const path of [...capability.docs, ...capability.examples, ...capability.tests]) await access(resolve(path));
    for (const member of capability.apiMembers) {
      const escaped = member.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      assert.match(runtimeSource, new RegExp(`\\b${escaped}\\b`, "u"));
    }
  }

  const serialized = JSON.stringify(matrix);
  assert.doesNotMatch(serialized, /bounded-orchestrator|web-dashboard/u);
  assert.ok(matrix.capabilities.some((entry) => entry.status === "intentionally-different"));
  assert.ok(matrix.capabilities.some((entry) => entry.status === "rejected-for-safety"));

  const hosts = (id: string): string[] => matrix.capabilities.find((entry) => entry.id === id)?.hosts ?? [];
  assert.deepEqual(hosts("tools-and-active-selection"), matrix.hosts);
  assert.deepEqual(hosts("tool-renderers"), ["tui"]);
  assert.deepEqual(hosts("runtime-commands"), ["tui", "rpc"]);
  assert.deepEqual(hosts("runtime-shortcuts"), ["tui"]);
  assert.deepEqual(hosts("invocation-flags"), ["tui", "print", "json"]);
  assert.deepEqual(hosts("interactive-dialog-and-presentation-ui"), ["tui", "rpc"]);
  assert.deepEqual(hosts("tui-input-components-and-theme"), ["tui"]);
  assert.deepEqual(hosts("session-snapshots-and-flow-controls"), matrix.hosts);
  assert.deepEqual(hosts("session-focus-switching"), ["tui"]);
  assert.deepEqual(hosts("graceful-shutdown"), ["tui", "rpc", "embedding"]);
  assert.deepEqual(hosts("resource-reload"), ["tui", "embedding"]);
});
