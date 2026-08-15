import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import targets from "../native/targets.json" with { type: "json" };

const expected = new Set(["win32-x64", "win32-arm64"]);
if (targets.schemaVersion !== 1 || !Array.isArray(targets.targets) || targets.targets.length !== expected.size) {
  throw new Error("kernel native target manifest must contain two release targets");
}
for (const target of targets.targets) {
  const key = `${target.platform}-${target.arch}`;
  if (!expected.delete(key)) throw new Error(`unexpected or duplicate kernel native target: ${key}`);
  if (target.source !== "native/win32/src/rigyn-job-launcher.c"
      || target.output !== `native/win32/prebuilds/${key}/rigyn-job-launcher.exe`) {
    throw new Error(`kernel native target has an invalid layout: ${key}`);
  }
}
if (expected.size > 0) throw new Error(`kernel native targets are missing: ${[...expected].join(", ")}`);

const source = await readFile("native/win32/src/rigyn-job-launcher.c", "utf8");
for (const fragment of [
  "CreateJobObjectW(NULL, NULL)",
  "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
  "PROC_THREAD_ATTRIBUTE_JOB_LIST",
  "PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
  "EXTENDED_STARTUPINFO_PRESENT",
  "JobObjectBasicAccountingInformation",
  "_get_osfhandle(3)",
]) {
  if (!source.includes(fragment)) throw new Error(`kernel native source is missing ${fragment}`);
}
for (const forbidden of ["BREAKAWAY_OK", "CREATE_BREAKAWAY_FROM_JOB", "SILENT_BREAKAWAY_OK"]) {
  if (source.includes(forbidden)) throw new Error(`kernel native source permits process breakaway: ${forbidden}`);
}

const release = process.argv.includes("--release");
const local = targets.targets.find((target) =>
  target.platform === process.platform && target.arch === process.arch);
const selected = release ? targets.targets : local === undefined ? [] : [local];
for (const target of selected) {
  let metadata;
  try {
    metadata = await stat(target.output);
  } catch {
    throw new Error(`required kernel native artifact is missing: ${target.output}`);
  }
  if (!metadata.isFile() || metadata.size < 1_024) {
    throw new Error(`kernel native artifact is invalid: ${target.output}`);
  }
  const header = await readFile(target.output);
  if (header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error(`kernel native artifact has an unexpected executable header: ${target.output}`);
  }
  const peOffset = header.readUInt32LE(0x3c);
  const machine = peOffset + 6 <= header.byteLength ? header.readUInt16LE(peOffset + 4) : 0;
  const expectedMachine = target.arch === "x64" ? 0x8664 : 0xaa64;
  if (machine !== expectedMachine) {
    throw new Error(`kernel native artifact has the wrong architecture: ${target.output}`);
  }
}

if (local !== undefined) {
  const shell = process.env.ComSpec || "cmd.exe";
  const probe = spawnSync(resolve(local.output), [shell, "echo rigyn-job-launcher-ok & exit /b 17"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.error !== undefined) throw probe.error;
  if (probe.signal !== null || probe.status !== 17
      || probe.stdout.trim() !== "rigyn-job-launcher-ok" || probe.stderr !== ""
      || probe.output[3]?.toString("ascii") !== "O") {
    throw new Error(`kernel native runtime probe failed: ${local.output}`);
  }
  const reservedExit = spawnSync(resolve(local.output), [shell, "exit /b 125"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  if (reservedExit.error !== undefined) throw reservedExit.error;
  if (reservedExit.status !== 125 || reservedExit.stderr !== ""
      || reservedExit.output[3]?.toString("ascii") !== "O") {
    throw new Error("kernel native runtime probe did not preserve child exit 125");
  }
  const rejected = spawnSync(resolve(local.output), [resolve("rigyn-missing-shell.exe"), "exit /b 0"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  if (rejected.error !== undefined) throw rejected.error;
  if (rejected.status !== 125 || rejected.output[3]?.toString("ascii") !== "E"
      || rejected.stderr !== "rigyn-job-launcher: launch failed\r\n") {
    throw new Error("kernel native runtime probe did not report setup failure on its control pipe");
  }
  console.log(`kernel native source, layout, and runtime verified for ${process.platform}-${process.arch}`);
} else {
  console.log(`kernel native source and two-target layout verified (current: ${process.platform}-${process.arch})`);
}
if (release) console.log("all kernel native release artifacts verified");
