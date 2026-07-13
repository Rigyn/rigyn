import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { discoverExtensions, loadRuntimeExtensions } from "rigyn/extensions";

test("package starter activates through the public extension loader", async (context) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "rigyn-package-starter-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const extensionRoot = join(workspace, "extensions");
  await mkdir(extensionRoot);
  await cp(resolve("."), join(extensionRoot, "package-starter"), { recursive: true });

  const catalog = await discoverExtensions([{
    path: extensionRoot,
    scope: "user",
    trusted: true,
  }]);
  assert.deepEqual(catalog.list().map((entry) => entry.id), ["package-starter"]);

  const host = await loadRuntimeExtensions(catalog.bundle().runtime, { workspace });
  context.after(async () => await host.close());
  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.commands().map((command) => command.name), ["starter-review"]);
  assert.deepEqual(host.initialUi().map((operation) => operation.type), ["status"]);
});
