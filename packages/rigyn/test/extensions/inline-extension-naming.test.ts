import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDirectExtensions } from "../../src/extensions/runtime.js";

test("inline extension metadata uses stable ordinal and explicit names", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-inline-names-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const noop = (): void => undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [
      noop,
      { name: "named", factory: noop, hidden: true },
      noop,
    ],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.extensions().map((entry) => entry.sourcePath), [
    "<inline:1>",
    "<inline:named>",
    "<inline:3>",
  ]);
  assert.equal(host.compatibilityProjection("<inline:named>")?.hidden, true);
});
