import assert from "node:assert/strict";
import test from "node:test";

import { formatResourceCatalogReport } from "../../src/cli/resource-report.js";
import { buildHarnessResourceCatalog } from "../../src/service/resource-catalog.js";

test("resource report summarizes the canonical bounded catalog", () => {
  const catalog = buildHarnessResourceCatalog({
    tools: [],
    toolOwner: () => ({ kind: "builtin" }),
    skills: [],
    providers: [],
  });
  const report = formatResourceCatalogReport(catalog);
  assert.match(report, /^Resource catalog$/mu);
  assert.match(report, /^Tools: 0 · Commands: \d+ · Skills: 0 · Prompts: 0 · Themes: 0$/mu);
  assert.match(report, /^Packages: 0$/mu);
  assert.match(report, /^Extensions: 0 · Active: 0$/mu);
  assert.match(report, /^Diagnostics: 0$/mu);
});
