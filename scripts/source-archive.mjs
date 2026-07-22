import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { runBoundedCommand } from "./bounded-command.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const REQUIRED_SOURCE_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/source-archive.mjs",
  "scripts/verify-source-archive.mjs",
  "scripts/generate-provider-models.mjs",
  "packages/terminal/package.json",
  "packages/terminal/tsconfig.build.json",
  "packages/terminal/src/index.ts",
  "packages/terminal/scripts/build-native.mjs",
  "packages/terminal/scripts/verify-native.mjs",
  "packages/terminal/native/targets.json",
  "packages/terminal/native/darwin/src/darwin-modifiers.c",
  "packages/terminal/native/win32/src/win32-console-mode.c",
  "packages/models/package.json",
  "packages/models/tsconfig.build.json",
  "packages/models/src/index.ts",
  "packages/models/src/providers/data/.manifest.json",
  "packages/models/scripts/check-model-data.mjs",
  "packages/models/scripts/copy-model-data.mjs",
  "packages/kernel/package.json",
  "packages/kernel/tsconfig.build.json",
  "packages/kernel/src/index.ts",
  "packages/rigyn/package.json",
  "packages/rigyn/tsconfig.json",
  "packages/rigyn/src/bin/rigyn.ts",
  "packages/rigyn/src/providers/maintained-model-catalog.ts",
  "packages/rigyn/scripts/install-user.mjs",
  "packages/rigyn/scripts/lifecycle-common.mjs",
]);

const EXCLUDED_COMPONENTS = new Set([
  ".app-install",
  ".build-install",
  ".release",
  ".standalone",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const NATIVE_BINARY_EXTENSION = /\.(?:dll|dylib|exe|node|so)$/iu;
const GIT_EXCLUSIONS = [
  ...[...EXCLUDED_COMPONENTS].flatMap((component) => [
    `:(exclude,glob)${component}/**`,
    `:(exclude,glob)**/${component}/**`,
  ]),
  ":(exclude,glob)*.dll",
  ":(exclude,glob)*.dylib",
  ":(exclude,glob)*.exe",
  ":(exclude,glob)*.node",
  ":(exclude,glob)*.so",
  ":(exclude,glob)**/*.dll",
  ":(exclude,glob)**/*.dylib",
  ":(exclude,glob)**/*.exe",
  ":(exclude,glob)**/*.node",
  ":(exclude,glob)**/*.so",
  ":(exclude,glob)packages/terminal/native/**/prebuilds/**",
];

function tarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end >= offset && end < offset + length ? end : offset + length).toString("utf8");
}

function tarNumber(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = value * 256n + BigInt(byte);
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), "Source archive contains an oversized tar entry");
    return Number(value);
  }
  const text = field.toString("ascii").replace(/\0.*$/su, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(data) {
  const values = new Map();
  let offset = 0;
  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    assert.ok(separator > offset, "Source archive contains invalid PAX metadata");
    const length = Number.parseInt(data.subarray(offset, separator).toString("ascii"), 10);
    assert.ok(Number.isSafeInteger(length) && length > separator - offset + 1 && offset + length <= data.length,
      "Source archive contains invalid PAX metadata");
    const record = data.subarray(separator + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) values.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return values;
}

function parseTar(buffer) {
  const records = [];
  let offset = 0;
  let nextPath;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = tarNumber(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    assert.equal(checksum, expectedChecksum, "Source archive contains an invalid tar header checksum");
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix === "" ? name : `${prefix}/${name}`;
    const type = String.fromCharCode(header[156] || 0x30);
    const size = tarNumber(header, 124, 12);
    assert.ok(Number.isSafeInteger(size) && size >= 0, "Source archive contains an invalid tar entry size");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert.ok(dataEnd <= buffer.length, "Source archive contains a truncated tar entry");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "x") {
      const pax = parsePax(data);
      assert.deepEqual([...pax.keys()], ["path"], "Source archive contains unsupported PAX entry metadata");
      nextPath = pax.get("path");
    }
    else if (type === "L") nextPath = data.subarray(0, data.indexOf(0) < 0 ? data.length : data.indexOf(0)).toString("utf8");
    else if (type === "g") {
      const pax = parsePax(data);
      assert.deepEqual([...pax.keys()], ["comment"], "Source archive contains unsupported global PAX metadata");
    } else {
      assert.ok(type === "0" || type === "5", `Source archive contains unsupported tar entry type: ${type}`);
      records.push({ path: nextPath ?? headerPath, type, data });
      nextPath = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert.ok(records.length > 0, "Source archive is empty");
  return records;
}

export function isExcludedSourcePath(path) {
  const components = path.split("/").filter(Boolean);
  return components.some((component) => EXCLUDED_COMPONENTS.has(component))
    || path.startsWith("packages/terminal/native/") && components.includes("prebuilds")
    || NATIVE_BINARY_EXTENSION.test(components.at(-1) ?? "");
}

export async function inspectSourceArchive(archivePath, options) {
  const archive = await readFile(archivePath);
  const records = parseTar(gunzipSync(archive));
  assert.match(options.root, /^[0-9A-Za-z][0-9A-Za-z._-]*$/u, "Source archive root is invalid");
  const rootPrefix = `${options.root}/`;
  const entries = records.map(({ path }) => path);
  assert.equal(new Set(entries).size, entries.length, "Source archive contains duplicate paths");
  for (const { path: entry, type, data } of records) {
    assert.ok(entry.length > 0 && entry.length <= 4_096, "Source archive contains an invalid path length");
    assert.equal(entry.includes("\\"), false, `Source archive contains a non-portable path: ${entry}`);
    const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    assert.ok(path !== "" && !entry.startsWith("/") && (type === "5" || !entry.endsWith("/")),
      `Source archive contains an invalid path: ${entry}`);
    const components = path.split("/");
    assert.ok(components.every((component) => component !== "" && component !== "." && component !== ".."),
      `Source archive contains an unsafe path: ${entry}`);
    assert.ok(entry === options.root || entry === rootPrefix || entry.startsWith(rootPrefix),
      `Source archive contains a path outside ${rootPrefix}`);
    assert.ok(type !== "5" || data.length === 0, `Source archive directory contains data: ${entry}`);
    const relative = entry.startsWith(rootPrefix) ? entry.slice(rootPrefix.length) : "";
    assert.equal(isExcludedSourcePath(relative), false, `Source archive contains excluded path: ${relative}`);
  }
  const files = new Map(records.filter(({ type }) => type === "0" || type === "\0")
    .map(({ path, data }) => [path, Buffer.from(data)]));
  for (const required of options.requiredPaths ?? REQUIRED_SOURCE_PATHS) {
    assert.ok(files.has(`${rootPrefix}${required}`), `Source archive is missing required path: ${required}`);
  }
  return { archive, entries, files };
}

async function git(repositoryRoot, args, label) {
  return await runBoundedCommand("git", args, {
    cwd: repositoryRoot,
    env: process.env,
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024 * 1024,
    label,
  });
}

export async function createSourceArchive({
  repositoryRoot = REPOSITORY_ROOT,
  version,
  ref = "HEAD",
  output,
  requiredPaths = REQUIRED_SOURCE_PATHS,
}) {
  assert.match(version, VERSION_PATTERN, `Invalid release version: ${version}`);
  assert.equal(typeof output, "string", "Source archive output is required");
  const root = `rigyn-v${version}`;
  const commit = (await git(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    "source archive ref resolution")).stdout.trim();
  assert.match(commit, /^[0-9a-f]{40,64}$/u, "Source archive ref did not resolve to a commit");
  const committedManifest = JSON.parse((await git(repositoryRoot, ["show", `${commit}:package.json`],
    "source archive version read")).stdout);
  assert.equal(version, committedManifest.version,
    `Source archive version ${version} does not match package version ${committedManifest.version} at ${ref}`);

  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const temporaryTar = `${outputPath}.tar-${nonce}`;
  const temporaryArchive = `${outputPath}.tmp-${nonce}`;
  try {
    await git(repositoryRoot, [
      "-c",
      "core.autocrlf=false",
      "archive",
      "--format=tar",
      `--prefix=${root}/`,
      `--output=${temporaryTar}`,
      commit,
      "--",
      ".",
      ...GIT_EXCLUSIONS,
    ], "source archive creation");
    const compressed = gzipSync(await readFile(temporaryTar), { level: 9, mtime: 0 });
    compressed.fill(0, 4, 8);
    compressed[9] = 0xff;
    await writeFile(temporaryArchive, compressed, { mode: 0o600 });
    await inspectSourceArchive(temporaryArchive, { root, requiredPaths });
    await rm(outputPath, { force: true });
    await rename(temporaryArchive, outputPath);
    return {
      schemaVersion: 1,
      file: basename(outputPath),
      root,
      commit,
      sha256: createHash("sha256").update(compressed).digest("hex"),
      bytes: compressed.byteLength,
    };
  } finally {
    await Promise.all([
      rm(temporaryTar, { force: true }),
      rm(temporaryArchive, { force: true }),
    ]);
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--version", "--ref", "--output"].includes(name)) throw new Error(`Unknown argument: ${name ?? ""}`);
    if (value === undefined || value === "") throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be specified only once`);
    values.set(name, value);
  }
  for (const name of ["--version", "--output"]) if (!values.has(name)) throw new Error(`${name} is required`);
  return {
    version: values.get("--version"),
    ref: values.get("--ref") ?? "HEAD",
    output: resolve(process.cwd(), values.get("--output")),
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await createSourceArchive(options);
    writeFileSync(1, `${options.output}\n`);
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { parseArguments as parseSourceArchiveArguments };
