import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  mergeConfig,
  parseJsonc,
  parseJsoncObject,
  readJsoncConfig,
  resolveConfig,
} from "../../src/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "harness-config-"));
  temporaryDirectories.push(path);
  return path;
}

test("JSONC accepts comments and trailing commas without changing string contents", () => {
  const parsed = parseJsoncObject(`{
    // line comment
    "url": "https://example.test/a/*literal*/", 
    "nested": {
      /* block comment */
      "values": [1, 2,],
    },
  }`, "settings.jsonc");
  assert.deepEqual(parsed, {
    url: "https://example.test/a/*literal*/",
    nested: { values: [1, 2] },
  });
});

test("JSONC errors include deterministic source, line, and column", () => {
  assert.throws(
    () => parseJsonc("{\n  \"ok\": true,\n  nope\n}", "broken.jsonc"),
    (error: unknown) => error instanceof Error && /^broken\.jsonc:\d+:\d+:/.test(error.message),
  );
  assert.throws(
    () => parseJsonc("{ /* never closes", "comment.jsonc"),
    /comment\.jsonc:1:3: Unterminated block comment/,
  );
  assert.throws(() => parseJsoncObject("[]", "array.jsonc"), /root must be an object/);
});

test("unsafe prototype keys are rejected at any depth", () => {
  assert.throws(
    () => parseJsoncObject('{"nested":{"__proto__":{"polluted":true}}}', "unsafe.jsonc"),
    /unsafe key at \$\.nested\.__proto__/,
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("deep merge is deterministic, recursively merges objects, and replaces arrays", () => {
  const merged = mergeConfig(
    { z: 1, model: { name: "base", options: { one: 1 }, list: [1, 2] } },
    { a: 2, model: { options: { two: 2 }, list: [3], nullable: null } },
  );
  assert.deepEqual(merged, {
    a: 2,
    model: {
      list: [3],
      name: "base",
      nullable: null,
      options: { one: 1, two: 2 },
    },
    z: 1,
  });
  assert.equal(JSON.stringify(merged), '{"a":2,"model":{"list":[3],"name":"base","nullable":null,"options":{"one":1,"two":2}},"z":1}');
});

test("global, trusted project, and CLI layers apply in increasing precedence", () => {
  const root = directory();
  const globalPath = join(root, "global.jsonc");
  const projectPath = join(root, "project.jsonc");
  writeFileSync(globalPath, '{"model":"global","nested":{"global":true,"value":1},"list":[1]}');
  writeFileSync(projectPath, '{"model":"project","nested":{"project":true,"value":2},"list":[2]}');

  const resolved = resolveConfig({
    globalPath,
    projectPath,
    projectTrusted: true,
    cli: { model: "cli", nested: { cli: true } },
  });
  assert.deepEqual(resolved.value, {
    list: [2],
    model: "cli",
    nested: { cli: true, global: true, project: true, value: 2 },
  });
  assert.deepEqual(resolved.appliedSources, ["global", "project", "cli"]);
  assert.equal(resolved.projectIgnored, false);
});

test("untrusted project configuration is never parsed or applied", () => {
  const root = directory();
  const globalPath = join(root, "global.jsonc");
  const projectPath = join(root, "project.jsonc");
  writeFileSync(globalPath, '{"safe":true}');
  writeFileSync(projectPath, "this is deliberately invalid JSONC");

  const untrusted = resolveConfig({
    globalPath,
    projectPath,
    projectTrusted: false,
    cli: { cli: true },
  });
  assert.deepEqual(untrusted.value, { cli: true, safe: true });
  assert.deepEqual(untrusted.appliedSources, ["global", "cli"]);
  assert.equal(untrusted.projectIgnored, true);
  assert.throws(
    () => resolveConfig({ globalPath, projectPath, projectTrusted: true }),
    /project\.jsonc:/,
  );
});

test("missing optional files are ignored while required reads fail with a stable code", () => {
  const missing = join(directory(), "missing.jsonc");
  assert.equal(readJsoncConfig(missing), undefined);
  assert.throws(
    () => readJsoncConfig(missing, true),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFIG_READ" && /Unable to read/.test(error.message),
  );
});
