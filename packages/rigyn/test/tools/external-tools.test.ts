import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureExternalTool, getExternalToolPath } from "../../src/tools/external-tools.js";

test("external tool discovery prefers the isolated Rigyn bin directory", async (t) => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "rigyn-external-tool-"));
  t.after(async () => await rm(agentDirectory, { recursive: true, force: true }));
  const bin = join(agentDirectory, "bin");
  await mkdir(bin);
  const binary = join(bin, process.platform === "win32" ? "fd.exe" : "fd");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const environment = { RIGYN_CODING_AGENT_DIR: agentDirectory, PATH: "" };
  assert.equal(await getExternalToolPath("fd", environment), binary);
  assert.equal(await ensureExternalTool("fd", { environment, silent: true }), binary);
});

test("external tool discovery never downloads while offline", async (t) => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "rigyn-external-tool-offline-"));
  t.after(async () => await rm(agentDirectory, { recursive: true, force: true }));
  assert.equal(await ensureExternalTool("fd", {
    environment: { RIGYN_CODING_AGENT_DIR: agentDirectory, RIGYN_OFFLINE: "yes", PATH: "" },
    silent: true,
  }), undefined);
});
