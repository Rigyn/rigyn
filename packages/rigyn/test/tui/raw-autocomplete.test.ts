import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider as PackageAutocompleteProvider } from "@rigyn/terminal";
import { CombinedAutocompleteProvider } from "../../src/tui/index.js";

function findFd(): string | null {
  for (const executable of ["fd", "fdfind"]) {
    if (spawnSync(executable, ["--version"], { stdio: "ignore" }).status === 0) return executable;
  }
  return null;
}

function writeFixture(basePath: string, relativePath: string): void {
  const fullPath = join(basePath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, "export {};\n");
}

const fdPath = findFd();

test("rigyn autocomplete delegates to the terminal package", () => {
  assert.equal(CombinedAutocompleteProvider, PackageAutocompleteProvider);
});

test("published autocomplete matches multiple fragments in a deeply nested path", { skip: fdPath === null }, async (context) => {
  if (fdPath === null) return;
  const basePath = mkdtempSync(join(tmpdir(), "rigyn-terminal-autocomplete-"));
  context.after(() => rmSync(basePath, { recursive: true, force: true }));
  writeFixture(basePath, "packages/terminal/src/autocomplete.ts");
  writeFixture(basePath, "packages/models/src/autocomplete.ts");
  const provider = new CombinedAutocompleteProvider([], basePath, fdPath);
  const line = "@terminal/src/auto";

  const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  const item = result?.items.find((candidate) => candidate.value === "@packages/terminal/src/autocomplete.ts");

  assert.ok(result);
  assert.ok(item);
  assert.ok(!result.items.some((candidate) => candidate.value === "@packages/models/src/autocomplete.ts"));
  assert.equal(provider.applyCompletion([line], 0, line.length, item, result.prefix).lines[0], "@packages/terminal/src/autocomplete.ts ");
});

test("published autocomplete matches a directory fragment in the middle of a path", { skip: fdPath === null }, async (context) => {
  if (fdPath === null) return;
  const basePath = mkdtempSync(join(tmpdir(), "rigyn-terminal-autocomplete-"));
  context.after(() => rmSync(basePath, { recursive: true, force: true }));
  writeFixture(basePath, "src/components/Button.tsx");
  writeFixture(basePath, "src/utils/helpers.ts");
  const provider = new CombinedAutocompleteProvider([], basePath, fdPath);
  const line = "@components/";

  const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  const item = result?.items.find((candidate) => candidate.value === "@src/components/Button.tsx");

  assert.ok(result);
  assert.ok(item);
  assert.ok(!result.items.some((candidate) => candidate.value === "@src/utils/helpers.ts"));
  assert.equal(provider.applyCompletion([line], 0, line.length, item, result.prefix).lines[0], "@src/components/Button.tsx ");
});
