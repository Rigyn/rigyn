import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveFileCompletionPath } from "../dist/autocomplete.js";
import { CombinedAutocompleteProvider } from "../dist/index.js";

function findFd() {
  for (const executable of ["fd", "fdfind"]) {
    if (spawnSync(executable, ["--version"], { stdio: "ignore" }).status === 0) return executable;
  }
  return null;
}

function writeFixture(basePath, relativePath) {
  const fullPath = join(basePath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, "export {};\n");
}

const fdPath = findFd();

describe("Windows-shaped autocomplete paths", () => {
  let basePath;

  beforeEach(() => { basePath = mkdtempSync(join(tmpdir(), "rigyn-terminal-autocomplete-")); });
  afterEach(() => { rmSync(basePath, { recursive: true, force: true }); });

  it("resolves drive-letter absolute paths with either separator", () => {
    assert.deepEqual(resolveFileCompletionPath("C:\\Users\\alice\\Doc", basePath), {
      search: "C:\\Users\\alice",
      needle: "Doc",
      parent: "C:/Users/alice/",
    });
    assert.deepEqual(resolveFileCompletionPath("C:/Users/alice/Doc", basePath), {
      search: "C:/Users/alice",
      needle: "Doc",
      parent: "C:/Users/alice/",
    });
  });

  it("completes relative prefixes with either separator through the native filesystem", async () => {
    writeFixture(basePath, "src/components/Button.tsx");
    const provider = new CombinedAutocompleteProvider([], basePath);

    for (const line of ["src/components/But", "src\\components\\But"]) {
      const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

      assert.equal(result?.prefix, line);
      assert.deepEqual(result?.items.map((item) => item.value), ["src/components/Button.tsx"]);
    }
  });
});

describe("attachment autocomplete path fragments", { skip: fdPath === null }, () => {
  let basePath;

  beforeEach(() => { basePath = mkdtempSync(join(tmpdir(), "rigyn-terminal-autocomplete-")); });
  afterEach(() => { rmSync(basePath, { recursive: true, force: true }); });

  it("matches multiple fragments in a deeply nested path", async () => {
    writeFixture(basePath, "packages/terminal/src/autocomplete.ts");
    writeFixture(basePath, "packages/models/src/autocomplete.ts");
    const provider = new CombinedAutocompleteProvider([], basePath, fdPath);
    const line = "@terminal/src/auto";

    const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
    const values = result?.items.map((item) => item.value);

    assert.ok(values?.includes("@packages/terminal/src/autocomplete.ts"));
    assert.ok(!values?.includes("@packages/models/src/autocomplete.ts"));
  });

  it("matches a directory fragment in the middle of a path", async () => {
    writeFixture(basePath, "src/components/Button.tsx");
    writeFixture(basePath, "src/utils/helpers.ts");
    const provider = new CombinedAutocompleteProvider([], basePath, fdPath);
    const line = "@components/";

    const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
    const values = result?.items.map((item) => item.value);

    assert.ok(values?.includes("@src/components/Button.tsx"));
    assert.ok(!values?.includes("@src/utils/helpers.ts"));
  });
});
