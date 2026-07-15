import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("product uninstall without --yes reports one actionable CLI error", (context) => {
  const home = mkdtempSync(join(tmpdir(), "rigyn-uninstall-confirmation-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RIGYN_INSTALL_DIR: join(home, ".rigyn"),
  };
  delete environment.RIGYN_RECURSION_DEPTH;

  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "uninstall",
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "rigyn: Uninstall requires confirmation; run `rigyn uninstall --yes`\n");
});
