import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { checkReleaseMetadata } from "./check-release-metadata.mjs";
import { withLifecycleLock } from "./lifecycle-common.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SENSITIVE_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const OUTPUT_MARKER = ".rigyn-release-output.json";
const MAX_MARKER_BYTES = 16 * 1024;

function parseArguments(argv) {
  let output = resolve(PROJECT_ROOT, ".release");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--output") throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value === "") throw new Error("--output requires a directory");
    output = resolve(PROJECT_ROOT, value);
    index += 1;
  }
  if (output === PROJECT_ROOT || output === parse(output).root) {
    throw new Error("Release output cannot be the project or filesystem root");
  }
  return { output };
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && npmExecPath !== "") {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function releaseEnvironment() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_NAME.test(name)) environment[name] = value;
  }
  return {
    ...environment,
    NO_COLOR: "1",
    SOURCE_DATE_EPOCH: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_loglevel: "error",
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
  };
}

async function run(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let total = 0;
  let outputFailure;
  const capture = (target, chunk) => {
    if (outputFailure !== undefined) return;
    total += chunk.byteLength;
    if (total > MAX_OUTPUT_BYTES) {
      outputFailure = new Error(`${options.label} output exceeded ${MAX_OUTPUT_BYTES} bytes`);
      child.kill("SIGKILL");
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", (chunk) => capture(stdout, chunk));
  child.stderr.on("data", (chunk) => capture(stderr, chunk));
  const result = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      outputFailure = new Error(`${options.label} timed out after ${options.timeoutMs} ms`);
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal });
    });
  });
  const output = {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
  if (outputFailure !== undefined) throw outputFailure;
  if (result.code !== 0) {
    throw new Error(
      `${options.label} failed${result.code === null ? ` with signal ${result.signal ?? "unknown"}` : ` with exit ${result.code}`}\n${output.stderr.slice(-8192)}`,
    );
  }
  return output;
}

async function existingPathType(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function physicalTarget(target) {
  let existing = resolve(target);
  const missing = [];
  while (await existingPathType(existing) === undefined) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Release output has no existing ancestor: ${target}`);
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(await realpath(existing), ...missing);
}

async function assertSafeOutputPath(output) {
  const physicalOutput = await physicalTarget(output);
  const physicalProject = await realpath(PROJECT_ROOT);
  if (physicalOutput === parse(physicalOutput).root || inside(physicalOutput, physicalProject)) {
    throw new Error("Release output cannot be the project, filesystem root, or an ancestor of the project");
  }
}

async function readOutputMarker(storagePath) {
  const storageMetadata = await existingPathType(storagePath);
  if (storageMetadata === undefined || !storageMetadata.isDirectory() || storageMetadata.isSymbolicLink()) {
    throw new Error(`Release output directory is unsafe: ${storagePath}`);
  }
  const path = resolve(storagePath, OUTPUT_MARKER);
  const metadata = await existingPathType(path);
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) {
    throw new Error(`Refusing to replace an unowned release output: ${storagePath}`);
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Release output marker is invalid: ${path}`, { cause: error });
  }
  const keys = Object.keys(marker).sort();
  const expectedKeys = ["product", "schemaVersion", "version", "archive", "archiveSha256"].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
    || marker.product !== "rigyn"
    || marker.schemaVersion !== 1
    || typeof marker.version !== "string" || marker.version === ""
    || typeof marker.archive !== "string" || basename(marker.archive) !== marker.archive
    || !/^[a-f0-9]{64}$/u.test(marker.archiveSha256 ?? "")) {
    throw new Error(`Release output marker is invalid: ${path}`);
  }
  const archive = await readFile(resolve(storagePath, marker.archive));
  if (createHash("sha256").update(archive).digest("hex") !== marker.archiveSha256) {
    throw new Error(`Release output archive does not match its ownership marker: ${storagePath}`);
  }
  return marker;
}

async function recoverPreviousOutput(output, previous) {
  const outputMetadata = await existingPathType(output);
  const previousMetadata = await existingPathType(previous);
  if (previousMetadata === undefined) {
    if (outputMetadata !== undefined) await readOutputMarker(output);
    return;
  }
  if (!previousMetadata.isDirectory() || previousMetadata.isSymbolicLink()) {
    throw new Error(`Release output backup is unsafe: ${previous}`);
  }
  await readOutputMarker(previous);
  if (outputMetadata === undefined) {
    await rename(previous, output);
    return;
  }
  await readOutputMarker(output);
  await rm(previous, { recursive: true, force: true });
}

async function stage(output) {
  const previous = `${output}.previous`;
  await recoverPreviousOutput(output, previous);
  const metadata = await checkReleaseMetadata(PROJECT_ROOT);
  const manifest = JSON.parse(await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8"));
  const platformPolicy = JSON.parse(await readFile(resolve(PROJECT_ROOT, "release/platforms.json"), "utf8"));
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.staging-${process.pid}-${randomBytes(6).toString("hex")}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const invocation = npmInvocation([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      staging,
      PROJECT_ROOT,
    ]);
    const packedOutput = await run(invocation.command, invocation.args, {
      cwd: PROJECT_ROOT,
      env: releaseEnvironment(),
      timeoutMs: 120_000,
      label: "npm pack",
    });
    const packed = JSON.parse(packedOutput.stdout);
    assert.equal(packed.length, 1, "npm pack must produce exactly one archive");
    assert.equal(packed[0]?.name, manifest.name, "Packed package name does not match package.json");
    assert.equal(packed[0]?.version, manifest.version, "Packed package version does not match package.json");
    const archiveFile = packed[0]?.filename;
    assert.equal(typeof archiveFile, "string", "npm pack did not report an archive filename");
    assert.equal(archiveFile.includes("/") || archiveFile.includes("\\"), false, "Archive filename must be a basename");
    const archive = await readFile(resolve(staging, archiveFile));
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (packed[0]?.integrity !== undefined) {
      assert.equal(packed[0].integrity, integrity, "npm pack integrity does not match the staged archive");
    }
    const releaseManifest = {
      schemaVersion: 1,
      product: manifest.name,
      version: manifest.version,
      tag: `v${manifest.version}`,
      packaging: platformPolicy.packaging,
      node: manifest.engines.node,
      archive: {
        file: archiveFile,
        sha256,
        integrity,
        bytes: archive.byteLength,
      },
      checksumFile: "SHA256SUMS",
      releaseNotes: "RELEASE_NOTES.md",
      targets: platformPolicy.targets,
    };
    await Promise.all([
      writeFile(resolve(staging, "SHA256SUMS"), `${sha256}  ${archiveFile}\n`, { mode: 0o600 }),
      writeFile(
        resolve(staging, "RELEASE_NOTES.md"),
        `# Rigyn ${manifest.version}\n\n${metadata.releaseBody}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        resolve(staging, "release-manifest.json"),
        `${JSON.stringify(releaseManifest, null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        resolve(staging, OUTPUT_MARKER),
        `${JSON.stringify({
          product: "rigyn",
          schemaVersion: 1,
          version: manifest.version,
          archive: archiveFile,
          archiveSha256: sha256,
        }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    const hadOutput = await existingPathType(output) !== undefined;
    if (hadOutput) await rename(output, previous);
    try {
      await rename(staging, output);
    } catch (error) {
      if (hadOutput && await existingPathType(output) === undefined) await rename(previous, output);
      throw error;
    }
    if (hadOutput) await rm(previous, { recursive: true, force: true });
    process.stdout.write(`Staged ${archiveFile} and release metadata in ${output}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const { output } = parseArguments(process.argv.slice(2));
  await assertSafeOutputPath(output);
  await withLifecycleLock(output, async () => await stage(output));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
