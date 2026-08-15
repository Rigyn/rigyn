import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { windowsJobLauncherPath } from "../../src/windows-job-launcher.js";
import targets from "../../native/targets.json" with { type: "json" };

test("Windows job launcher resolves only from the kernel package", () => {
  const packageRoot = join(process.cwd(), "packages", "kernel");
  assert.equal(
    windowsJobLauncherPath({
      architecture: "arm64",
      moduleUrl: pathToFileURL(join(packageRoot, "dist", "windows-job-launcher.js")).href,
    }),
    join(packageRoot, "native", "win32", "prebuilds", "win32-arm64", "rigyn-job-launcher.exe"),
  );
});

test("Windows job launcher release targets stay complete and package-owned", () => {
  assert.deepEqual(targets, {
    schemaVersion: 1,
    targets: ["x64", "arm64"].map((arch) => ({
      platform: "win32",
      arch,
      source: "native/win32/src/rigyn-job-launcher.c",
      output: `native/win32/prebuilds/win32-${arch}/rigyn-job-launcher.exe`,
    })),
  });
});
