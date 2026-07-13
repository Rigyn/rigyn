import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("resource catalog documentation names every canonical projection and its safety boundary", async () => {
  const documentation = await readFile(new URL("../../docs/resource-catalog.md", import.meta.url), "utf8");
  for (const surface of ["HarnessRuntime.resourceCatalog()", "resources.list", "api.getResourceCatalog()", "HarnessService.resourceCatalog()"] as const) {
    assert.match(documentation, new RegExp(surface.replace(/[.()]/gu, "\\$&"), "u"));
  }
  assert.match(documentation, /never contains command or tool callbacks/u);
  assert.match(documentation, /prompt\/template contents/u);
  assert.match(documentation, /Blocked or untrusted extensions/u);
  assert.match(documentation, /bounds\.omitted/u);
});
