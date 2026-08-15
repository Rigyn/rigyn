import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import targets from "../native/targets.json" with { type: "json" };

const target = targets.targets.find((candidate) =>
  candidate.platform === process.platform && candidate.arch === process.arch);
if (target === undefined) {
  throw new Error(`kernel native helpers cannot be built for ${process.platform}-${process.arch}`);
}

await mkdir(dirname(target.output), { recursive: true });
const compiler = process.env.CC || "cl";
const temporary = await mkdtemp(join(tmpdir(), "rigyn-kernel-native-"));
try {
  const result = spawnSync(compiler, [
    "/nologo",
    "/O2",
    "/MT",
    "/std:c17",
    "/W4",
    "/WX",
    "/utf-8",
    "/guard:cf",
    target.source,
    `/Fo${join(temporary, "rigyn-job-launcher.obj")}`,
    `/Fe${target.output}`,
    "/link",
    "/DYNAMICBASE",
    "/NXCOMPAT",
    "/guard:cf",
  ], {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`native compiler exited with status ${result.status ?? "unknown"}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(`built ${target.output}`);
