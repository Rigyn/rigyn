import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCanonicalDirectoryCreationPath,
  assertCanonicalDirectoryCreationPathSync,
  canonicalExistingPath,
  hasSymlinkComponent,
  windowsPathHazard,
} from "../../src/config/canonical-path.js";

test("canonical paths resolve aliases while the security check retains symlink provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-canonical-path-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const target = join(root, "ActualWorkspace");
  const alias = join(root, "workspace-alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

  assert.equal(await canonicalExistingPath(alias), await realpath(target));
  assert.equal(await hasSymlinkComponent(alias), true);
  assert.equal(await hasSymlinkComponent(target), false);
  await assert.rejects(
    assertCanonicalDirectoryCreationPath(join(alias, "missing")),
    /symbolic or non-canonical existing ancestor/u,
  );
  assert.throws(
    () => assertCanonicalDirectoryCreationPathSync(join(alias, "missing")),
    /symbolic or non-canonical existing ancestor/u,
  );
  await assert.doesNotReject(assertCanonicalDirectoryCreationPath(join(target, "missing")));
  assert.doesNotThrow(() => assertCanonicalDirectoryCreationPathSync(join(target, "missing")));
});

test("runtime rejects an aliased state root before creating its database directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-state-path-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const target = join(root, "actual-state");
  const alias = join(root, "state-alias");
  const workspace = join(root, "workspace");
  const config = join(root, "config");
  const home = join(root, "home");
  await Promise.all([target, workspace, config, home].map(async (path) => await mkdir(path)));
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  const runtimeUrl = new URL("../../src/cli/runtime.ts", import.meta.url).href;
  const script = `
    import { loadRuntime } from ${JSON.stringify(runtimeUrl)};
    const runtime = await loadRuntime({ workspace: ${JSON.stringify(workspace)} });
    await runtime.close();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: alias,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic or non-canonical existing ancestor/u);
  await assert.rejects(
    stat(join(target, "rigyn")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("Windows state paths reject device, network, stream, alias, and reserved-name forms", () => {
  assert.equal(windowsPathHazard(String.raw`C:\Users\fixture\state`, "win32"), undefined);
  assert.equal(windowsPathHazard(String.raw`\\?\C:\Users\fixture`, "win32"), "device namespace");
  assert.equal(windowsPathHazard(String.raw`\\server\share\state`, "win32"), "UNC path");
  assert.equal(windowsPathHazard(String.raw`C:\state\sessions.sqlite:stream`, "win32"), "alternate data stream");
  assert.equal(windowsPathHazard(String.raw`C:\state\name.`, "win32"), "trailing dot or space");
  assert.equal(windowsPathHazard(String.raw`C:\state\NUL.txt`, "win32"), "reserved device name");
  assert.equal(windowsPathHazard("/ordinary/unix/path", "linux"), undefined);
});
