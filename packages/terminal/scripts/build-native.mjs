import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import targets from "../native/targets.json" with { type: "json" };

const target = targets.targets.find((candidate) => candidate.platform === process.platform && candidate.arch === process.arch);
if (!target) {
  throw new Error(`native helpers cannot be built for ${process.platform}-${process.arch}`);
}

await mkdir(dirname(target.output), { recursive: true });

const compiler = process.env.CC || (process.platform === "win32" ? "cl" : "cc");
const nodeHeaders = resolve(dirname(process.execPath), "..", "include", "node");
const args = process.platform === "darwin"
  ? ["-bundle", "-O2", "-fvisibility=hidden", "-undefined", "dynamic_lookup", "-I", nodeHeaders, "-framework", "CoreGraphics", target.source, "-o", target.output]
  : ["/nologo", "/O2", "/LD", target.source, "/link", `/OUT:${target.output}`];
const result = spawnSync(compiler, args, { cwd: new URL("..", import.meta.url), stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`native compiler exited with status ${result.status ?? "unknown"}`);

console.log(`built ${target.output}`);

if (target.keychain) {
  await mkdir(dirname(target.keychain.output), { recursive: true });
  const swiftCompiler = process.env.SWIFTC || "swiftc";
  const swift = spawnSync(
    swiftCompiler,
    ["-O", "-framework", "Security", target.keychain.source, "-o", target.keychain.output],
    { cwd: new URL("..", import.meta.url), stdio: "inherit" },
  );
  if (swift.error) throw swift.error;
  if (swift.status !== 0) throw new Error(`Swift compiler exited with status ${swift.status ?? "unknown"}`);
  await chmod(target.keychain.output, 0o755);
  console.log(`built ${target.keychain.output}`);
}
