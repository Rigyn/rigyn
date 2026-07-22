import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "./bounded-command.mjs";
import {
  releaseNpmResolutionArguments,
  releaseNpmResolutionEnvironment,
} from "./release-npm-resolution.mjs";
import { createStandaloneArchive } from "./standalone-archive.mjs";
import { RIGYN_PACKAGE_GRAPH, resolveNpmInvocation } from "../packages/rigyn/scripts/lifecycle-common.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_ROOT = resolve(REPOSITORY_ROOT, "packages/rigyn");
const SENSITIVE_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--directory", "--output", "--runtime-root"].includes(name)) throw new Error(`Unknown argument: ${name ?? ""}`);
    if (value === undefined || value === "") throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be specified only once`);
    values.set(name, value);
  }
  for (const name of ["--directory", "--output"]) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  const defaultRuntimeRoot = process.platform === "win32" ? dirname(process.execPath) : dirname(dirname(process.execPath));
  return {
    directory: resolve(REPOSITORY_ROOT, values.get("--directory")),
    output: resolve(REPOSITORY_ROOT, values.get("--output")),
    runtimeRoot: resolve(REPOSITORY_ROOT, values.get("--runtime-root") ?? defaultRuntimeRoot),
  };
}

function isolatedEnvironment(root) {
  const inheritedNames = new Set(["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"]);
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && inheritedNames.has(name.toLowerCase()) && !SENSITIVE_NAME.test(name)) environment[name] = value;
  }
  return {
    ...environment,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "home", "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "home", "AppData", "Local"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    NO_COLOR: "1",
    TERM: "dumb",
    npm_config_audit: "false",
    npm_config_cache: process.env.npm_config_cache ?? (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache")
      : join(homedir(), ".npm")),
    npm_config_fund: "false",
    npm_config_loglevel: "error",
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
    ...releaseNpmResolutionEnvironment(),
  };
}

function createStandaloneInstallPlan(root, archivePaths) {
  return {
    environment: isolatedEnvironment(root),
    args: [
      "install", "--global=false", "--omit=dev", "--omit=peer", "--include=optional", "--legacy-peer-deps",
      "--no-audit", "--no-fund", "--package-lock=false", "--ignore-scripts",
      ...releaseNpmResolutionArguments(),
      ...archivePaths,
    ],
  };
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to replace existing standalone output: ${path}`);
}

function launcherInvocation(launcher, args) {
  if (process.platform !== "win32") return { command: launcher, args };
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", launcher, ...args],
  };
}

async function runSmoke(runtime, cli, launcher, cwd, environment, version) {
  const versionResult = await runBoundedCommand(runtime, [cli, "--version"], {
    cwd, env: environment, timeoutMs: 30_000, label: "standalone CLI version check",
  });
  assert.equal(versionResult.stdout, `${version}\n`);
  assert.equal(versionResult.stderr, "");
  const launcherCommand = launcherInvocation(launcher, ["--version"]);
  const launcherResult = await runBoundedCommand(launcherCommand.command, launcherCommand.args, {
    cwd, env: environment, timeoutMs: 30_000, label: "standalone launcher version check",
  });
  assert.equal(launcherResult.stdout, `${version}\n`);
  assert.equal(launcherResult.stderr, "");
  const helpResult = await runBoundedCommand(runtime, [cli, "--help"], {
    cwd, env: environment, timeoutMs: 30_000, label: "standalone CLI help check",
  });
  assert.match(helpResult.stdout, /^rigyn\b/mu);
  assert.equal(helpResult.stderr, "");
  const rpcResult = await runBoundedCommand(runtime, [cli,
    "--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"], {
    cwd, env: environment, timeoutMs: 30_000, label: "standalone offline RPC startup check",
  });
  assert.equal(rpcResult.stdout, "");
  assert.equal(rpcResult.stderr, "");
}

async function build({ directory, output, runtimeRoot }) {
  const manifest = JSON.parse(await readFile(resolve(directory, "release-manifest.json"), "utf8"));
  const platformPolicy = JSON.parse(await readFile(resolve(PRODUCT_ROOT, "release/platforms.json"), "utf8"));
  const productManifest = JSON.parse(await readFile(resolve(PRODUCT_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 4, "Standalone builds require release manifest schema 4");
  assert.equal(manifest.version, productManifest.version);
  assert.deepEqual(manifest.targets, platformPolicy.targets, "Staged target policy does not match the checkout");
  assert.ok(
    platformPolicy.targets.some((target) => target.platform === process.platform && target.arch === process.arch),
    `Unsupported standalone build target: ${process.platform}/${process.arch}`,
  );
  const runtimeName = process.platform === "win32" ? "node.exe" : "node";
  const runtimeSource = process.platform === "win32"
    ? resolve(runtimeRoot, runtimeName)
    : resolve(runtimeRoot, "bin", runtimeName);
  const runtimeLicense = resolve(runtimeRoot, "LICENSE");
  const runtimeMetadata = await stat(runtimeSource);
  assert.ok(runtimeMetadata.isFile() && runtimeMetadata.size >= 10 * 1024 * 1024,
    `Node runtime must be an official self-contained binary (received ${runtimeMetadata.size} bytes)`);
  const runtimeVersion = await runBoundedCommand(runtimeSource, ["--version"], {
    cwd: runtimeRoot, env: process.env, timeoutMs: 30_000, label: "standalone Node runtime version check",
  });
  assert.equal(runtimeVersion.stdout.trim(), `v${platformPolicy.nodeRuntime.version}`,
    `Standalone runtime must be Node ${platformPolicy.nodeRuntime.version}`);
  assert.match(await readFile(runtimeLicense, "utf8"), /Node\.js/u, "Node runtime LICENSE is invalid");

  const targetKey = `${process.platform}-${process.arch}`;
  const archiveRoot = `rigyn-v${manifest.version}-${targetKey}`;
  const archiveFile = `${archiveRoot}.tar.gz`;
  const metadataFile = `${archiveFile}.json`;
  await mkdir(output, { recursive: true, mode: 0o700 });
  await Promise.all([assertAbsent(resolve(output, archiveFile)), assertAbsent(resolve(output, metadataFile))]);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rigyn-standalone-build-"));
  try {
    const installRoot = resolve(temporaryRoot, "install");
    const payloadRoot = resolve(temporaryRoot, archiveRoot);
    await Promise.all([
      mkdir(installRoot, { recursive: true, mode: 0o700 }),
      mkdir(resolve(payloadRoot, "bin"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(payloadRoot, "lib"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(payloadRoot, "LICENSES"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(temporaryRoot, "home"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(temporaryRoot, "tmp"), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(resolve(installRoot, "package.json"), `${JSON.stringify({
      name: "rigyn-standalone-install",
      private: true,
      version: "0.0.0",
      overrides: { "@types/node": productManifest.devDependencies["@types/node"] },
    }, null, 2)}\n`);
    const archivePaths = manifest.archives.map(({ file }) => resolve(directory, file));
    assert.deepEqual(manifest.archives.map(({ name }) => name), RIGYN_PACKAGE_GRAPH.map(({ name }) => name));
    const { args, environment } = createStandaloneInstallPlan(temporaryRoot, archivePaths);
    const invocation = await resolveNpmInvocation(args);
    await runBoundedCommand(invocation.command, invocation.args, {
      cwd: installRoot, env: environment, timeoutMs: 300_000, label: "standalone production dependency install",
    });
    const installedManifest = JSON.parse(await readFile(resolve(installRoot, "node_modules/rigyn/package.json"), "utf8"));
    assert.equal(installedManifest.version, manifest.version);
    await rename(resolve(installRoot, "node_modules"), resolve(payloadRoot, "lib/node_modules"));
    await cp(runtimeSource, resolve(payloadRoot, "bin", runtimeName));
    await Promise.all([
      cp(resolve(PRODUCT_ROOT, "LICENSE"), resolve(payloadRoot, "LICENSES/rigyn.txt")),
      cp(runtimeLicense, resolve(payloadRoot, "LICENSES/node.txt")),
    ]);
    const cli = resolve(payloadRoot, "lib/node_modules/rigyn", installedManifest.bin.rigyn);
    const runtime = resolve(payloadRoot, "bin", runtimeName);
    if (process.platform === "win32") {
      await writeFile(resolve(payloadRoot, "bin/rigyn.cmd"), [
        "@echo off",
        '"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\rigyn\\dist\\bin\\rigyn.js" %*',
        "",
      ].join("\r\n"));
    } else {
      await writeFile(resolve(payloadRoot, "bin/rigyn"), [
        "#!/bin/sh",
        "set -eu",
        'bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'exec "$bin_dir/node" "$bin_dir/../lib/node_modules/rigyn/dist/bin/rigyn.js" "$@"',
        "",
      ].join("\n"), { mode: 0o755 });
    }
    const buildMetadata = {
      schemaVersion: 1,
      product: "rigyn",
      version: manifest.version,
      platform: process.platform,
      arch: process.arch,
      node: platformPolicy.nodeRuntime.version,
      entrypoint: process.platform === "win32" ? "bin/rigyn.cmd" : "bin/rigyn",
    };
    await writeFile(resolve(payloadRoot, "BUILD-METADATA.json"), `${JSON.stringify(buildMetadata, null, 2)}\n`);
    await runSmoke(runtime, cli, resolve(payloadRoot, buildMetadata.entrypoint), payloadRoot, environment, manifest.version);
    const archivePath = resolve(output, archiveFile);
    await createStandaloneArchive(payloadRoot, archivePath, archiveRoot);
    const archive = await readFile(archivePath);
    const standalone = {
      ...buildMetadata,
      file: archiveFile,
      sha256: createHash("sha256").update(archive).digest("hex"),
      bytes: archive.byteLength,
    };
    await writeFile(resolve(output, metadataFile), `${JSON.stringify(standalone, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(1, `Built and runtime-verified ${archiveFile} (${archive.byteLength} bytes).\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await build(parseArguments(process.argv.slice(2)));
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export {
  build as buildStandalone,
  createStandaloneInstallPlan,
  parseArguments as parseStandaloneArguments,
};
