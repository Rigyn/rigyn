import assert from "node:assert/strict";
import test from "node:test";
import { updateAllExtensionPackages } from "../../src/cli/extensions-command.js";

test("update all extension packages continues after individual failures", async () => {
  const calls: Array<{ id: string; scope: "project"; sourcePath: string | undefined; allowScripts: boolean | undefined }> = [];
  const manager = {
    async list(scope: "project") {
      assert.equal(scope, "project");
      return [{ id: "one" }, { id: "two" }, { id: "three" }];
    },
    async update(id: string, scope: "project", sourcePath?: string, options?: { allowScripts?: boolean }) {
      calls.push({ id, scope, sourcePath, allowScripts: options?.allowScripts });
      if (id === "two") throw new Error("registry unavailable");
      return { id, version: "2.0.0" };
    },
  };

  assert.deepEqual(await updateAllExtensionPackages(manager, "project", { allowScripts: true }), {
    scope: "project",
    updated: [
      { id: "one", version: "2.0.0" },
      { id: "three", version: "2.0.0" },
    ],
    skipped: [],
    failed: [{ id: "two", error: "registry unavailable" }],
  });
  assert.deepEqual(calls, [
    { id: "one", scope: "project", sourcePath: undefined, allowScripts: true },
    { id: "two", scope: "project", sourcePath: undefined, allowScripts: true },
    { id: "three", scope: "project", sourcePath: undefined, allowScripts: true },
  ]);
});

test("update all extension packages handles an empty scope", async () => {
  let updates = 0;
  const manager = {
    async list() {
      return [];
    },
    async update() {
      updates += 1;
      return undefined;
    },
  };

  assert.deepEqual(await updateAllExtensionPackages(manager, "user"), {
    scope: "user",
    updated: [],
    skipped: [],
    failed: [],
  });
  assert.equal(updates, 0);
});

test("update all reports immutable npm versions and Git revisions without fetching them", async () => {
  const calls: string[] = [];
  const common = {
    schemaVersion: 1 as const,
    scope: "user" as const,
    installedAt: "2026-01-01T00:00:00.000Z",
    manifestSha256: "a".repeat(64),
  };
  const result = await updateAllExtensionPackages({
    async list() {
      return [
        {
          id: "npm-pinned",
          provenance: {
            ...common,
            kind: "npm" as const,
            id: "npm-pinned",
            source: "npm:fixture@1.2.3",
            packageName: "fixture",
            resolvedVersion: "1.2.3",
            archiveSha256: "b".repeat(64),
          },
        },
        {
          id: "git-pinned",
          provenance: {
            ...common,
            kind: "git" as const,
            id: "git-pinned",
            source: `git:https://example.com/fixture.git#${"c".repeat(40)}`,
            revision: "c".repeat(40),
          },
        },
        {
          id: "moving",
          provenance: {
            ...common,
            kind: "npm" as const,
            id: "moving",
            source: "npm:moving@latest",
            packageName: "moving",
            resolvedVersion: "1.0.0",
            archiveSha256: "d".repeat(64),
          },
        },
      ];
    },
    async update(id) {
      calls.push(id);
      return { id };
    },
  }, "user");

  assert.deepEqual(calls, ["moving"]);
  assert.deepEqual(result.updated, [{ id: "moving" }]);
  assert.deepEqual(result.skipped.map(({ id }) => id), ["npm-pinned", "git-pinned"]);
});
