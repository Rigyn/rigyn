import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkReleaseMetadata } from "./check-release-metadata.mjs";
import { runBoundedCommand } from "./bounded-command.mjs";
import { createSourceArchive } from "./source-archive.mjs";
import {
  RIGYN_PACKAGE_GRAPH,
  inside,
  resolveNpmInvocation,
  withLifecycleLock,
} from "../packages/rigyn/scripts/lifecycle-common.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_ROOT = resolve(REPOSITORY_ROOT, "packages/rigyn");
const TUI_ROOT = resolve(REPOSITORY_ROOT, "packages/terminal");
const SENSITIVE_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const OUTPUT_MARKER = ".rigyn-release-output.json";
const MAX_MARKER_BYTES = 16 * 1024;

function parseArguments(argv) {
  let output = resolve(REPOSITORY_ROOT, ".release");
  let sourceRef = "HEAD";
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--output", "--source-ref"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value === "") throw new Error(`${argument} requires a value`);
    if (seen.has(argument)) throw new Error(`${argument} may be specified only once`);
    seen.add(argument);
    if (argument === "--output") output = resolve(REPOSITORY_ROOT, value);
    else sourceRef = value;
    index += 1;
  }
  if (output === REPOSITORY_ROOT || output === parse(output).root) {
    throw new Error("Release output cannot be the project or filesystem root");
  }
  return { output, sourceRef };
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

async function existingPathType(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
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
  const physicalProject = await realpath(REPOSITORY_ROOT);
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
  if (marker.product !== "rigyn" || typeof marker.version !== "string" || marker.version === "") {
    throw new Error(`Release output marker is invalid: ${path}`);
  }
  let archives;
  if (marker.schemaVersion === 1) {
    const keys = Object.keys(marker).sort();
    const expectedKeys = ["product", "schemaVersion", "version", "archive", "archiveSha256"].sort();
    if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
      throw new Error(`Release output marker is invalid: ${path}`);
    }
    archives = [{ file: marker.archive, sha256: marker.archiveSha256 }];
  } else if (marker.schemaVersion === 2) {
    const keys = Object.keys(marker).sort();
    const expectedKeys = ["product", "schemaVersion", "version", "archives"].sort();
    if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
      || !Array.isArray(marker.archives) || marker.archives.length < 1 || marker.archives.length > 64) {
      throw new Error(`Release output marker is invalid: ${path}`);
    }
    archives = marker.archives;
  } else {
    throw new Error(`Release output marker is invalid: ${path}`);
  }
  const files = new Set();
  for (const archive of archives) {
    if (archive === null || typeof archive !== "object" || Array.isArray(archive)
      || Object.keys(archive).sort().join("\0") !== ["file", "sha256"].sort().join("\0")
      || typeof archive.file !== "string" || basename(archive.file) !== archive.file
      || files.has(archive.file)
      || !/^[a-f0-9]{64}$/u.test(archive.sha256 ?? "")) {
      throw new Error(`Release output marker is invalid: ${path}`);
    }
    files.add(archive.file);
    const contents = await readFile(resolve(storagePath, archive.file));
    if (createHash("sha256").update(contents).digest("hex") !== archive.sha256) {
      throw new Error(`Release output archive does not match its ownership marker: ${storagePath}`);
    }
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

async function stage(output, sourceRef) {
  const previous = `${output}.previous`;
  await recoverPreviousOutput(output, previous);
  const metadata = await checkReleaseMetadata(REPOSITORY_ROOT);
  const nativeTargets = JSON.parse(await readFile(resolve(TUI_ROOT, "native/targets.json"), "utf8"));
  await runBoundedCommand(process.execPath, [resolve(TUI_ROOT, "scripts/verify-native.mjs"), "--release"], {
    cwd: TUI_ROOT,
    env: releaseEnvironment(),
    timeoutMs: 30_000,
    label: "native release artifact verification",
  });
  const packageManifests = new Map(await Promise.all(RIGYN_PACKAGE_GRAPH.map(async ({ name, directory }) => [
    name,
    JSON.parse(await readFile(resolve(REPOSITORY_ROOT, directory, "package.json"), "utf8")),
  ])));
  const manifest = packageManifests.get("rigyn");
  const platformPolicy = JSON.parse(await readFile(resolve(PRODUCT_ROOT, "release/platforms.json"), "utf8"));
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.staging-${process.pid}-${randomBytes(6).toString("hex")}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const archives = [];
    for (const { name, directory } of RIGYN_PACKAGE_GRAPH) {
      const packageManifest = packageManifests.get(name);
      const packageRoot = resolve(REPOSITORY_ROOT, directory);
      const invocation = await resolveNpmInvocation([
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        staging,
        packageRoot,
      ]);
      const packedOutput = await runBoundedCommand(invocation.command, invocation.args, {
        cwd: packageRoot,
        env: releaseEnvironment(),
        timeoutMs: 120_000,
        label: `npm pack ${name}`,
      });
      const packed = JSON.parse(packedOutput.stdout);
      assert.equal(packed.length, 1, `npm pack must produce exactly one archive for ${name}`);
      assert.equal(packed[0]?.name, packageManifest.name, `Packed package name does not match ${directory}/package.json`);
      assert.equal(packed[0]?.version, packageManifest.version, `Packed package version does not match ${directory}/package.json`);
      if (name === "@rigyn/terminal") {
        const packedFiles = new Set((packed[0]?.files ?? []).map(({ path }) => path));
        for (const target of nativeTargets.targets) {
          assert.ok(packedFiles.has(target.output), `Packed @rigyn/terminal archive is missing ${target.output}`);
        }
      }
      const file = packed[0]?.filename;
      assert.equal(typeof file, "string", `npm pack did not report an archive filename for ${name}`);
      assert.equal(file.includes("/") || file.includes("\\"), false, "Archive filename must be a basename");
      const archive = await readFile(resolve(staging, file));
      const sha256 = createHash("sha256").update(archive).digest("hex");
      const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
      if (packed[0]?.integrity !== undefined) {
        assert.equal(packed[0].integrity, integrity, `npm pack integrity does not match the staged ${name} archive`);
      }
      archives.push({ name, version: packageManifest.version, file, sha256, integrity, bytes: archive.byteLength });
    }
    const archive = archives.find(({ name }) => name === manifest.name);
    const source = await createSourceArchive({
      repositoryRoot: REPOSITORY_ROOT,
      version: manifest.version,
      ref: sourceRef,
      output: resolve(staging, `rigyn-v${manifest.version}-source.tar.gz`),
    });
    const releaseManifest = {
      schemaVersion: 4,
      product: manifest.name,
      version: manifest.version,
      tag: `v${manifest.version}`,
      packaging: platformPolicy.packaging,
      node: manifest.engines.node,
      nodeRuntime: platformPolicy.nodeRuntime.version,
      archive,
      archives,
      source,
      standalones: [],
      checksumFile: "SHA256SUMS",
      releaseNotes: "RELEASE_NOTES.md",
      targets: platformPolicy.targets,
    };
    const checksums = [...archives, source].map(({ file, sha256 }) => `${sha256}  ${file}\n`).join("");
    await Promise.all([
      writeFile(resolve(staging, "SHA256SUMS"), checksums, { mode: 0o600 }),
      writeFile(
        resolve(staging, "RELEASE_NOTES.md"),
        `# rigyn ${manifest.version}\n\n${metadata.releaseBody}\n`,
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
          schemaVersion: 2,
          version: manifest.version,
          archives: [...archives, source].map(({ file, sha256 }) => ({ file, sha256 })),
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
    writeFileSync(1, `Staged ${archives.length} package archives, one source archive, and release metadata in ${output}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const { output, sourceRef } = parseArguments(process.argv.slice(2));
  await assertSafeOutputPath(output);
  await withLifecycleLock(output, async () => await stage(output, sourceRef));
}

try {
  await main();
} catch (error) {
  writeFileSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
