import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "./bounded-command.mjs";
import { REQUIRED_SOURCE_PATHS, inspectSourceArchive } from "./source-archive.mjs";
import { resolveNpmInvocation } from "../packages/rigyn/scripts/lifecycle-common.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SENSITIVE_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;

function buildEnvironment(root) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_NAME.test(name)) environment[name] = value;
  }
  return {
    ...environment,
    HOME: resolve(root, "home"),
    USERPROFILE: resolve(root, "home"),
    XDG_CACHE_HOME: resolve(root, "cache"),
    XDG_CONFIG_HOME: resolve(root, "config"),
    XDG_STATE_HOME: resolve(root, "state"),
    TMPDIR: resolve(root, "tmp"),
    TMP: resolve(root, "tmp"),
    TEMP: resolve(root, "tmp"),
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_cache: process.env.npm_config_cache ?? (process.platform === "win32"
      ? resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"), "npm-cache")
      : resolve(homedir(), ".npm")),
    npm_config_fund: "false",
    npm_config_globalconfig: resolve(root, "npmrc-global"),
    npm_config_loglevel: "error",
    npm_config_logs_dir: resolve(root, "npm-logs"),
    npm_config_progress: "false",
    npm_config_prefer_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: resolve(root, "npmrc"),
  };
}

export function assertSourceMetadata(source, version) {
  assert.deepEqual(Object.keys(source ?? {}).sort(), [
    "bytes", "commit", "file", "root", "schemaVersion", "sha256",
  ].sort(), "Source artifact metadata must use the exact schema");
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.file, `rigyn-v${version}-source.tar.gz`);
  assert.equal(basename(source.file), source.file);
  assert.equal(source.root, `rigyn-v${version}`);
  assert.match(source.commit, /^[0-9a-f]{40,64}$/u);
  assert.match(source.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0);
}

export async function verifySourceRelease({
  directory,
  build = false,
  requiredPaths = REQUIRED_SOURCE_PATHS,
}) {
  const releaseDirectory = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(releaseDirectory, "release-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 4, "Unsupported release manifest schema");
  assertSourceMetadata(manifest.source, manifest.version);
  const archivePath = resolve(releaseDirectory, manifest.source.file);
  const archive = await readFile(archivePath);
  assert.equal(archive.byteLength, manifest.source.bytes, "Source archive size does not match the manifest");
  assert.equal(createHash("sha256").update(archive).digest("hex"), manifest.source.sha256,
    "Source archive SHA-256 does not match the manifest");
  const inspected = await inspectSourceArchive(archivePath, { root: manifest.source.root, requiredPaths });
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rigyn-source-verify-"));
  let buildResult;
  try {
    const extractionRoot = resolve(temporaryRoot, "extracted");
    await mkdir(extractionRoot, { recursive: true, mode: 0o700 });
    await runBoundedCommand("tar", ["-xzf", archivePath, "-C", extractionRoot], {
      cwd: extractionRoot,
      env: process.env,
      timeoutMs: 120_000,
      label: "source archive extraction",
    });
    if (build) {
      const environmentRoot = resolve(temporaryRoot, "environment");
      await Promise.all([
        "home", "cache", "config", "state", "tmp", "npm-logs",
      ].map(async (path) => await mkdir(resolve(environmentRoot, path), { recursive: true, mode: 0o700 })));
      await Promise.all([
        writeFile(resolve(environmentRoot, "npmrc"), "", { mode: 0o600 }),
        writeFile(resolve(environmentRoot, "npmrc-global"), "", { mode: 0o600 }),
      ]);
      const environment = buildEnvironment(environmentRoot);
      const sourceRoot = resolve(extractionRoot, manifest.source.root);
      const install = await resolveNpmInvocation(["ci", "--ignore-scripts"]);
      await runBoundedCommand(install.command, install.args, {
        cwd: sourceRoot,
        env: environment,
        timeoutMs: 600_000,
        maxOutputBytes: 16 * 1024 * 1024,
        label: "source archive dependency installation",
      });
      const buildInvocation = await resolveNpmInvocation(["run", "build"]);
      buildResult = await runBoundedCommand(buildInvocation.command, buildInvocation.args, {
        cwd: sourceRoot,
        env: environment,
        timeoutMs: 600_000,
        maxOutputBytes: 16 * 1024 * 1024,
        label: "source archive build",
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  return { source: manifest.source, entries: inspected.entries, build: buildResult };
}

function parseArguments(argv) {
  let directory;
  let build = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--build") {
      if (build) throw new Error("--build may be specified only once");
      build = true;
      continue;
    }
    if (argument !== "--directory") throw new Error(`Unknown argument: ${argument ?? ""}`);
    const value = argv[index + 1];
    if (value === undefined || value === "") throw new Error("--directory requires a value");
    if (directory !== undefined) throw new Error("--directory may be specified only once");
    directory = resolve(REPOSITORY_ROOT, value);
    index += 1;
  }
  if (directory === undefined) throw new Error("--directory is required");
  return { directory, build };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifySourceRelease(parseArguments(process.argv.slice(2)));
    writeFileSync(1, `Verified ${result.source.file}${result.build ? " and rebuilt its source" : ""}.\n`);
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { parseArguments as parseSourceVerificationArguments };
