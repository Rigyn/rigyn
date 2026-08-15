import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "./bounded-command.mjs";
import {
  releaseNpmResolutionEnvironment,
} from "./release-npm-resolution.mjs";
import { createStandaloneArchive } from "./standalone-archive.mjs";
import {
  STANDALONE_PRODUCTION_LOCK,
  assertStandaloneProductionGraph,
  createStandaloneProductionLock,
  standaloneProductionInstallArguments,
  standaloneProductionPackageJson,
} from "./standalone-production-lock.mjs";
import {
  STANDALONE_PRODUCTION_CONTENT,
  assertStandaloneProductionContent,
  createStandaloneProductionContent,
  verifyStandaloneProductionCapabilities,
} from "./standalone-production-payload.mjs";
import { createThirdPartyLicenseBundle } from "./third-party-licenses.mjs";
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

function createStandaloneInstallPlan(root) {
  return {
    environment: isolatedEnvironment(root),
    args: standaloneProductionInstallArguments(),
  };
}

function standaloneProductionInstallTimeoutMs(platform) {
  return platform === "win32" ? 10 * 60_000 : 300_000;
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
  if (process.platform !== "win32") {
    const linkedLauncherDirectory = resolve(dirname(cwd), "linked-launcher");
    const linkedLauncher = resolve(linkedLauncherDirectory, "rigyn");
    await mkdir(linkedLauncherDirectory, { mode: 0o700 });
    await symlink(launcher, linkedLauncher);
    const linkedLauncherResult = await runBoundedCommand(linkedLauncher, ["--version"], {
      cwd, env: environment, timeoutMs: 30_000, label: "standalone installed launcher version check",
    });
    assert.equal(linkedLauncherResult.stdout, `${version}\n`);
    assert.equal(linkedLauncherResult.stderr, "");
  }
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
  const workspaceLock = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "package-lock.json"), "utf8"));
  const packageManifests = Object.fromEntries(await Promise.all(RIGYN_PACKAGE_GRAPH.map(async ({ name, directory }) => [
    name,
    JSON.parse(await readFile(resolve(REPOSITORY_ROOT, directory, "package.json"), "utf8")),
  ])));
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
      mkdir(resolve(installRoot, "archives"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(temporaryRoot, "home"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(temporaryRoot, "tmp"), { recursive: true, mode: 0o700 }),
    ]);
    assert.deepEqual(manifest.archives.map(({ name }) => name), RIGYN_PACKAGE_GRAPH.map(({ name }) => name));
    for (const archiveMetadata of manifest.archives) {
      const archivePath = resolve(directory, archiveMetadata.file);
      assert.equal(dirname(archivePath), directory, `${archiveMetadata.name} archive path escapes staging`);
      const archive = await readFile(archivePath);
      assert.equal(archive.byteLength, archiveMetadata.bytes, `${archiveMetadata.name} archive size does not match staging`);
      assert.equal(
        createHash("sha256").update(archive).digest("hex"),
        archiveMetadata.sha256,
        `${archiveMetadata.name} archive SHA-256 does not match staging`,
      );
      assert.equal(
        `sha512-${createHash("sha512").update(archive).digest("base64")}`,
        archiveMetadata.integrity,
        `${archiveMetadata.name} archive integrity does not match staging`,
      );
      await writeFile(resolve(installRoot, "archives", archiveMetadata.file), archive, { mode: 0o600 });
    }
    const productionLock = createStandaloneProductionLock({
      workspaceLock,
      packageManifests,
      archives: manifest.archives,
    });
    await Promise.all([
      writeFile(
        resolve(installRoot, "package.json"),
        `${JSON.stringify(standaloneProductionPackageJson(productionLock), null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        resolve(installRoot, "package-lock.json"),
        `${JSON.stringify(productionLock, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    const { args, environment } = createStandaloneInstallPlan(temporaryRoot);
    const invocation = await resolveNpmInvocation(args);
    await runBoundedCommand(invocation.command, invocation.args, {
      cwd: installRoot,
      env: environment,
      timeoutMs: standaloneProductionInstallTimeoutMs(process.platform),
      label: "standalone production dependency install",
    });
    assert.deepEqual(
      JSON.parse(await readFile(resolve(installRoot, "package-lock.json"), "utf8")),
      productionLock,
      "npm ci changed the generated production lock",
    );
    await assertStandaloneProductionGraph(resolve(installRoot, "node_modules"), productionLock);
    const installedManifest = JSON.parse(await readFile(resolve(installRoot, "node_modules/rigyn/package.json"), "utf8"));
    assert.equal(installedManifest.version, manifest.version);
    await rename(resolve(installRoot, "node_modules"), resolve(payloadRoot, "lib/node_modules"));
    await cp(runtimeSource, resolve(payloadRoot, "bin", runtimeName));
    await Promise.all([
      cp(resolve(PRODUCT_ROOT, "LICENSE"), resolve(payloadRoot, "LICENSES/rigyn.txt")),
      cp(runtimeLicense, resolve(payloadRoot, "LICENSES/node.txt")),
      writeFile(
        resolve(payloadRoot, STANDALONE_PRODUCTION_LOCK),
        `${JSON.stringify(productionLock, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    await createThirdPartyLicenseBundle(
      resolve(payloadRoot, "lib/node_modules"),
      resolve(payloadRoot, "LICENSES"),
    );
    const cli = resolve(payloadRoot, "lib/node_modules/rigyn", installedManifest.bin.rigyn);
    const runtime = resolve(payloadRoot, "bin", runtimeName);
    if (process.platform === "win32") {
      await writeFile(resolve(payloadRoot, "bin/rigyn.cmd"), [
        "@echo off",
        'set "RIGYN_DISTRIBUTION=standalone"',
        '"%~dp0node.exe" -e "const fs=require(\'node:fs\'),path=require(\'node:path\');try{const root=path.join(process.env.USERPROFILE,\'.rigyn\');if(!fs.existsSync(root))fs.mkdirSync(root,{mode:0o700});let value=fs.lstatSync(root);if(!value.isDirectory()||value.isSymbolicLink())process.exit(1);const temporary=path.join(root,\'tmp\');if(!fs.existsSync(temporary))fs.mkdirSync(temporary,{mode:0o700});value=fs.lstatSync(temporary);if(!value.isDirectory()||value.isSymbolicLink())process.exit(1)}catch{process.exit(1)}"',
        "if errorlevel 1 exit /b 1",
        'set "TMPDIR=%USERPROFILE%\\.rigyn\\tmp"',
        'set "TMP=%USERPROFILE%\\.rigyn\\tmp"',
        'set "TEMP=%USERPROFILE%\\.rigyn\\tmp"',
        '"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\rigyn\\dist\\bin\\rigyn.js" %*',
        "",
      ].join("\r\n"));
    } else {
      await writeFile(resolve(payloadRoot, "bin/rigyn"), [
        "#!/bin/sh",
        "set -eu",
        'launcher_path=$0',
        'while [ -L "$launcher_path" ]; do',
        '  launcher_directory=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd -P)',
        '  launcher_target=$(readlink "$launcher_path")',
        '  case "$launcher_target" in',
        '    /*) launcher_path=$launcher_target ;;',
        '    *) launcher_path=$launcher_directory/$launcher_target ;;',
        '  esac',
        'done',
        'bin_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd -P)',
        "export RIGYN_DISTRIBUTION=standalone",
        'if [ ! -e "$HOME/.rigyn" ] && [ ! -L "$HOME/.rigyn" ]; then mkdir -m 700 "$HOME/.rigyn"; fi',
        '[ -d "$HOME/.rigyn" ] && [ ! -L "$HOME/.rigyn" ] || exit 1',
        'chmod 700 "$HOME/.rigyn"',
        'if [ ! -e "$HOME/.rigyn/tmp" ] && [ ! -L "$HOME/.rigyn/tmp" ]; then mkdir -m 700 "$HOME/.rigyn/tmp"; fi',
        '[ -d "$HOME/.rigyn/tmp" ] && [ ! -L "$HOME/.rigyn/tmp" ] || exit 1',
        'chmod 700 "$HOME/.rigyn/tmp"',
        'TMPDIR="$HOME/.rigyn/tmp"',
        'TMP="$HOME/.rigyn/tmp"',
        'TEMP="$HOME/.rigyn/tmp"',
        "export TMPDIR TMP TEMP",
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
    const productionModules = resolve(payloadRoot, "lib/node_modules");
    const productionContent = await createStandaloneProductionContent(productionModules);
    await writeFile(
      resolve(payloadRoot, STANDALONE_PRODUCTION_CONTENT),
      `${JSON.stringify(productionContent, null, 2)}\n`,
      { mode: 0o600 },
    );
    await runSmoke(runtime, cli, resolve(payloadRoot, buildMetadata.entrypoint), payloadRoot, environment, manifest.version);
    await verifyStandaloneProductionCapabilities({
      runtime,
      packageRoot: resolve(payloadRoot, "lib/node_modules/rigyn"),
      cwd: payloadRoot,
      environment,
      label: "standalone payload",
    });
    await assertStandaloneProductionContent(productionModules, productionContent);
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
  standaloneProductionInstallTimeoutMs,
};
