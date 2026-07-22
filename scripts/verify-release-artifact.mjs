import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkReleaseMetadata } from "./check-release-metadata.mjs";
import { runBoundedCommand } from "./bounded-command.mjs";
import {
  releaseNpmResolutionArguments,
  releaseNpmResolutionEnvironment,
} from "./release-npm-resolution.mjs";
import { inspectSourceArchive } from "./source-archive.mjs";
import { assertSourceMetadata } from "./verify-source-archive.mjs";
import { RIGYN_PACKAGE_GRAPH, resolveNpmInvocation } from "../packages/rigyn/scripts/lifecycle-common.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_ROOT = resolve(REPOSITORY_ROOT, "packages/rigyn");
const SENSITIVE_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const OUTPUT_MARKER = ".rigyn-release-output.json";
const SHARP_SMOKE_PROGRAM = [
  'import assert from "node:assert/strict";',
  'import { pathToFileURL } from "node:url";',
  'const sharp = (await import(pathToFileURL(process.argv[1]).href)).default;',
  "const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();",
  'assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "sharp did not produce a PNG");',
].join("\n");

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--directory", "--expected-platform", "--expected-arch"].includes(name)) {
      throw new Error(`Unknown argument: ${name ?? ""}`);
    }
    if (value === undefined || value === "") throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be specified only once`);
    values.set(name, value);
  }
  for (const name of ["--directory", "--expected-platform", "--expected-arch"]) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  return {
    directory: resolve(REPOSITORY_ROOT, values.get("--directory")),
    expectedPlatform: values.get("--expected-platform"),
    expectedArch: values.get("--expected-arch"),
  };
}

function isolatedEnvironment(paths) {
  const inheritedNames = new Set([
    "comspec",
    "lang",
    "lc_all",
    "path",
    "pathext",
    "systemroot",
    "tz",
    "windir",
  ]);
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && inheritedNames.has(name.toLowerCase()) && !SENSITIVE_NAME.test(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    TMPDIR: paths.temporary,
    TMP: paths.temporary,
    TEMP: paths.temporary,
    NO_COLOR: "1",
    TERM: "dumb",
    npm_config_audit: "false",
    npm_config_cache: paths.npmCache,
    npm_config_fund: "false",
    npm_config_globalconfig: paths.npmGlobalConfig,
    npm_config_loglevel: "error",
    npm_config_logs_dir: paths.npmLogs,
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: paths.npmUserConfig,
    ...releaseNpmResolutionEnvironment(),
  };
}

function assertManifest(manifest, platformPolicy, expectedPlatform, expectedArch) {
  assert.equal(manifest.schemaVersion, 4, "Unsupported release manifest schema");
  assert.equal(manifest.product, "rigyn");
  assert.equal(manifest.tag, `v${manifest.version}`);
  assert.equal(manifest.packaging, "npm-and-standalone");
  assert.equal(manifest.node, "^24.15.0 || >=26.0.0");
  assert.equal(manifest.nodeRuntime, platformPolicy.nodeRuntime.version);
  assert.equal(manifest.checksumFile, "SHA256SUMS");
  assert.equal(manifest.releaseNotes, "RELEASE_NOTES.md");
  assert.deepEqual(manifest.targets, platformPolicy.targets, "Staged targets do not match release/platforms.json");
  assert.deepEqual(
    manifest.archives?.map(({ name }) => name),
    RIGYN_PACKAGE_GRAPH.map(({ name }) => name),
    "Release manifest must contain the complete package graph in dependency order",
  );
  assert.deepEqual(
    manifest.standalones?.map(({ platform, arch }) => ({ platform, arch })),
    platformPolicy.targets.map(({ platform, arch }) => ({ platform, arch })),
    "Release manifest must contain one standalone archive per target",
  );
  const files = new Set();
  for (const archive of manifest.archives) {
    assert.deepEqual(
      Object.keys(archive).sort(),
      ["name", "version", "file", "sha256", "integrity", "bytes"].sort(),
      `Archive metadata for ${archive.name} must use the exact schema`,
    );
    assert.equal(archive.version, manifest.version, `${archive.name} version must match the release`);
    assert.equal(typeof archive.file, "string");
    assert.equal(basename(archive.file), archive.file, "Archive file must be a basename");
    assert.equal(files.has(archive.file), false, `Archive filename must be unique: ${archive.file}`);
    files.add(archive.file);
    assert.match(archive.sha256, /^[0-9a-f]{64}$/u);
    assert.match(archive.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    assert.ok(Number.isSafeInteger(archive.bytes) && archive.bytes > 0, "Archive byte size must be positive");
  }
  assert.deepEqual(
    manifest.archive,
    manifest.archives.find(({ name }) => name === manifest.product),
    "Primary archive must be the staged product archive",
  );
  assertSourceMetadata(manifest.source, manifest.version);
  assert.equal(files.has(manifest.source.file), false, `Archive filename must be unique: ${manifest.source.file}`);
  files.add(manifest.source.file);
  assert.ok(
    manifest.targets.some((target) => target.platform === expectedPlatform && target.arch === expectedArch),
    `Release manifest does not declare ${expectedPlatform}/${expectedArch}`,
  );
  for (const standalone of manifest.standalones) {
    assert.deepEqual(Object.keys(standalone).sort(), [
      "arch", "bytes", "entrypoint", "file", "node", "platform", "product", "schemaVersion", "sha256", "version",
    ].sort(), `Standalone metadata for ${standalone.platform}/${standalone.arch} must use the exact schema`);
    assert.equal(standalone.schemaVersion, 1);
    assert.equal(standalone.product, manifest.product);
    assert.equal(standalone.version, manifest.version);
    assert.equal(standalone.node, manifest.nodeRuntime);
    assert.equal(basename(standalone.file), standalone.file);
    assert.match(standalone.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(standalone.bytes) && standalone.bytes > 0);
  }
}

async function main() {
  const { directory, expectedPlatform, expectedArch } = parseArguments(process.argv.slice(2));
  assert.equal(process.platform, expectedPlatform, `Runner platform is ${process.platform}, expected ${expectedPlatform}`);
  assert.equal(process.arch, expectedArch, `Runner architecture is ${process.arch}, expected ${expectedArch}`);
  const releasePolicy = await checkReleaseMetadata(REPOSITORY_ROOT);
  const productManifest = JSON.parse(await readFile(resolve(PRODUCT_ROOT, "package.json"), "utf8"));
  const platformPolicy = JSON.parse(await readFile(resolve(PRODUCT_ROOT, "release/platforms.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(directory, "release-manifest.json"), "utf8"));
  assertManifest(manifest, platformPolicy, expectedPlatform, expectedArch);
  assert.equal(manifest.version, releasePolicy.version, "Staged version does not match the checkout");
  const archivePaths = [];
  for (const archiveMetadata of manifest.archives) {
    const archivePath = resolve(directory, archiveMetadata.file);
    assert.equal(dirname(archivePath), directory, "Archive path escapes the release directory");
    const archive = await readFile(archivePath);
    assert.equal(archive.byteLength, archiveMetadata.bytes, `${archiveMetadata.name} archive size does not match the manifest`);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    assert.equal(sha256, archiveMetadata.sha256, `${archiveMetadata.name} archive SHA-256 does not match the manifest`);
    assert.equal(integrity, archiveMetadata.integrity, `${archiveMetadata.name} archive SHA-512 integrity does not match the manifest`);
    archivePaths.push(archivePath);
  }
  const sourcePath = resolve(directory, manifest.source.file);
  assert.equal(dirname(sourcePath), directory, "Source archive path escapes the release directory");
  const sourceArchive = await readFile(sourcePath);
  assert.equal(sourceArchive.byteLength, manifest.source.bytes, "Source archive size does not match the manifest");
  assert.equal(createHash("sha256").update(sourceArchive).digest("hex"), manifest.source.sha256,
    "Source archive SHA-256 does not match the manifest");
  await inspectSourceArchive(sourcePath, { root: manifest.source.root });
  for (const standalone of manifest.standalones) {
    const archivePath = resolve(directory, standalone.file);
    assert.equal(dirname(archivePath), directory, "Standalone archive path escapes the release directory");
    const archive = await readFile(archivePath);
    assert.equal(archive.byteLength, standalone.bytes, `${standalone.file} size does not match the manifest`);
    assert.equal(createHash("sha256").update(archive).digest("hex"), standalone.sha256,
      `${standalone.file} SHA-256 does not match the manifest`);
  }
  const outputMarker = JSON.parse(await readFile(resolve(directory, OUTPUT_MARKER), "utf8"));
  assert.deepEqual(Object.keys(outputMarker).sort(), [
    "product",
    "schemaVersion",
    "version",
    "archives",
  ].sort(), "Release output ownership marker must use the exact schema");
  assert.equal(outputMarker.product, "rigyn");
  assert.equal(outputMarker.schemaVersion, 2);
  assert.equal(outputMarker.version, manifest.version);
  assert.deepEqual(
    outputMarker.archives,
    [
      ...manifest.archives.map(({ file, sha256 }) => ({ file, sha256 })),
      { file: manifest.source.file, sha256: manifest.source.sha256 },
      ...manifest.standalones.map(({ file, sha256 }) => ({ file, sha256 })),
    ],
  );
  assert.equal(
    await readFile(resolve(directory, manifest.checksumFile), "utf8"),
    [
      ...manifest.archives.map(({ file, sha256 }) => ({ file, sha256 })),
      { file: manifest.source.file, sha256: manifest.source.sha256 },
      ...manifest.standalones.map(({ file, sha256 }) => ({ file, sha256 })),
    ].map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""),
    "SHA256SUMS does not match the archives",
  );
  assert.equal(
    await readFile(resolve(directory, manifest.releaseNotes), "utf8"),
    `# Rigyn ${manifest.version}\n\n${releasePolicy.releaseBody}\n`,
    "Release notes must be the current changelog section",
  );

  const root = await mkdtemp(join(tmpdir(), "rigyn-release-verify-"));
  const paths = {
    root,
    home: join(root, "home"),
    appData: join(root, "home", "AppData", "Roaming"),
    localAppData: join(root, "home", "AppData", "Local"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    state: join(root, "state"),
    temporary: join(root, "tmp"),
    npmCache: process.env.npm_config_cache ?? (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache")
      : join(homedir(), ".npm")),
    npmLogs: join(root, "npm-logs"),
    npmUserConfig: join(root, "npmrc"),
    npmGlobalConfig: join(root, "npmrc-global"),
    install: join(root, "install"),
  };
  try {
    await Promise.all([
      paths.home,
      paths.appData,
      paths.localAppData,
      paths.cache,
      paths.config,
      paths.state,
      paths.temporary,
      paths.npmLogs,
      paths.install,
    ].map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })));
    await Promise.all([
      writeFile(paths.npmUserConfig, "", { mode: 0o600 }),
      writeFile(paths.npmGlobalConfig, "", { mode: 0o600 }),
      writeFile(resolve(paths.install, "package.json"), `${JSON.stringify({
        name: "rigyn-release-verification",
        private: true,
        version: "0.0.0",
        overrides: { "@types/node": productManifest.devDependencies["@types/node"] },
      }, null, 2)}\n`, { mode: 0o600 }),
    ]);
    const environment = isolatedEnvironment(paths);
    const standalone = manifest.standalones.find(({ platform, arch }) =>
      platform === expectedPlatform && arch === expectedArch);
    assert.ok(standalone, `Missing standalone archive for ${expectedPlatform}/${expectedArch}`);
    const extracted = resolve(root, "standalone");
    await mkdir(extracted, { recursive: true, mode: 0o700 });
    const archiveListing = await runBoundedCommand("tar", ["-tzf", resolve(directory, standalone.file)], {
      cwd: extracted,
      env: environment,
      timeoutMs: 120_000,
      label: "standalone archive path verification",
    });
    const expectedRoot = standalone.file.slice(0, -".tar.gz".length);
    const archiveEntries = archiveListing.stdout.split(/\r?\n/u).filter(Boolean);
    assert.ok(archiveEntries.length > 0, "Standalone archive is empty");
    assert.ok(archiveEntries.every((entry) => entry === `${expectedRoot}/` || entry.startsWith(`${expectedRoot}/`)),
      "Standalone archive contains an entry outside its target root");
    await runBoundedCommand("tar", ["-xzf", resolve(directory, standalone.file), "-C", extracted], {
      cwd: extracted,
      env: environment,
      timeoutMs: 120_000,
      label: "standalone archive extraction",
    });
    const standaloneRoot = resolve(extracted, expectedRoot);
    const buildMetadata = JSON.parse(await readFile(resolve(standaloneRoot, "BUILD-METADATA.json"), "utf8"));
    assert.deepEqual(buildMetadata, Object.fromEntries(Object.entries(standalone).filter(([key]) =>
      !["bytes", "file", "sha256"].includes(key))));
    const standaloneRuntime = resolve(standaloneRoot, "bin", expectedPlatform === "win32" ? "node.exe" : "node");
    assert.ok((await stat(standaloneRuntime)).size >= 10 * 1024 * 1024, "Standalone Node runtime is unexpectedly small");
    await Promise.all([
      access(resolve(standaloneRoot, "LICENSES/rigyn.txt")),
      access(resolve(standaloneRoot, "LICENSES/node.txt")),
      access(resolve(standaloneRoot, standalone.entrypoint)),
    ]);
    const standaloneCli = resolve(standaloneRoot, "lib/node_modules/rigyn/dist/bin/rigyn.js");
    const standaloneVersion = await runBoundedCommand(standaloneRuntime, [standaloneCli, "--version"], {
      cwd: standaloneRoot, env: environment, timeoutMs: 30_000, label: "standalone extracted CLI version check",
    });
    assert.equal(standaloneVersion.stdout, `${manifest.version}\n`);
    assert.equal(standaloneVersion.stderr, "");
    const standaloneLauncher = resolve(standaloneRoot, standalone.entrypoint);
    const launcherCommand = expectedPlatform === "win32"
      ? {
          command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
          args: ["/d", "/s", "/v:off", "/c", standaloneLauncher, "--version"],
        }
      : { command: standaloneLauncher, args: ["--version"] };
    const launcherVersion = await runBoundedCommand(launcherCommand.command, launcherCommand.args, {
      cwd: standaloneRoot, env: environment, timeoutMs: 30_000, label: "standalone extracted launcher version check",
    });
    assert.equal(launcherVersion.stdout, `${manifest.version}\n`);
    assert.equal(launcherVersion.stderr, "");
    const standaloneHelp = await runBoundedCommand(standaloneRuntime, [standaloneCli, "--help"], {
      cwd: standaloneRoot, env: environment, timeoutMs: 30_000, label: "standalone extracted CLI help check",
    });
    assert.match(standaloneHelp.stdout, /^Rigyn\b/mu);
    assert.equal(standaloneHelp.stderr, "");
    const standaloneRpc = await runBoundedCommand(standaloneRuntime, [standaloneCli,
      "--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"], {
      cwd: standaloneRoot, env: environment, timeoutMs: 30_000, label: "standalone extracted offline RPC startup check",
    });
    assert.equal(standaloneRpc.stdout, "");
    assert.equal(standaloneRpc.stderr, "");
    const invocation = await resolveNpmInvocation([
      "install",
      "--global=false",
      "--omit=dev",
      "--omit=peer",
      "--include=optional",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--ignore-scripts",
      "--prefix",
      paths.install,
      ...releaseNpmResolutionArguments(),
      ...archivePaths,
    ]);
    await runBoundedCommand(invocation.command, invocation.args, {
      cwd: paths.install,
      env: environment,
      timeoutMs: 300_000,
      label: "release archive install",
    });
    const installedPackages = new Map();
    for (const { name } of RIGYN_PACKAGE_GRAPH) {
      const root = resolve(paths.install, "node_modules", ...name.split("/"));
      const installedManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      assert.equal(installedManifest.name, name);
      assert.equal(installedManifest.version, manifest.version);
      const entry = installedManifest.exports?.["."]?.import ?? installedManifest.main;
      assert.equal(typeof entry, "string", `${name} must expose an importable main entry`);
      const entryPath = resolve(root, entry);
      assert.equal(
        entryPath.startsWith(`${root}/`) || entryPath.startsWith(`${root}\\`),
        true,
        `${name} main entry escapes its package root`,
      );
      await import(`${pathToFileURL(entryPath).href}?release-package=${encodeURIComponent(name)}`);
      installedPackages.set(name, { root, manifest: installedManifest });
    }
    const tuiPackage = installedPackages.get("@rigyn/terminal");
    assert.ok(tuiPackage);
    const nativeVerification = await runBoundedCommand(
      process.execPath,
      [resolve(tuiPackage.root, "scripts/verify-native.mjs"), "--release"],
      {
        cwd: tuiPackage.root,
        env: environment,
        timeoutMs: 30_000,
        label: "packed native helper verification",
      },
    );
    assert.match(nativeVerification.stdout, /all native release artifacts verified/u);
    if (expectedPlatform === "darwin" || expectedPlatform === "win32") {
      assert.match(
        nativeVerification.stdout,
        new RegExp(`runtime verified for ${expectedPlatform}-${expectedArch}`, "u"),
        "The packed matching native helper was not loaded",
      );
    }
    assert.equal(nativeVerification.stderr, "");
    const productPackage = installedPackages.get("rigyn");
    assert.ok(productPackage);
    const { root: packageRoot, manifest: packageManifest } = productPackage;

    const cli = await runBoundedCommand(process.execPath, [resolve(packageRoot, packageManifest.bin["rigyn"]), "--version"], {
      cwd: paths.install,
      env: environment,
      timeoutMs: 30_000,
      label: "release CLI version check",
    });
    assert.equal(cli.stdout, `${manifest.version}\n`);
    assert.equal(cli.stderr, "");

    for (const subpath of Object.keys(packageManifest.exports)) {
      const exported = packageManifest.exports[subpath];
      if (subpath === "./package.json") {
        assert.equal(exported, "./package.json");
        continue;
      }
      assert.equal(typeof exported?.import, "string", `Missing import target for ${subpath}`);
      const target = resolve(packageRoot, exported.import);
      assert.equal(target.startsWith(`${packageRoot}/`) || target.startsWith(`${packageRoot}\\`), true, `${subpath} escapes the package root`);
      if (subpath === "./rpc-entry") {
        const rpcEntry = await runBoundedCommand(process.execPath, [target,
          "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"], {
          cwd: paths.install,
          env: environment,
          timeoutMs: 30_000,
          label: "release RPC entry check",
        });
        assert.equal(rpcEntry.stdout, "");
        assert.equal(rpcEntry.stderr, "");
        continue;
      }
      await import(`${pathToFileURL(target).href}?release-verification=${encodeURIComponent(subpath)}`);
    }

    const requireFromPackage = createRequire(resolve(packageRoot, "package.json"));
    const sharpEntry = requireFromPackage.resolve("sharp");
    const sharpSmoke = await runBoundedCommand(process.execPath, [
      "--input-type=module",
      "--eval",
      SHARP_SMOKE_PROGRAM,
      sharpEntry,
    ], {
      cwd: packageRoot,
      env: environment,
      timeoutMs: 30_000,
      label: "sharp dependency smoke",
    });
    assert.equal(sharpSmoke.stdout, "");
    assert.equal(sharpSmoke.stderr, "");

    const ripgrepModule = await import(pathToFileURL(resolve(packageRoot, "dist/tools/ripgrep.js")).href);
    const ripgrep = await ripgrepModule.resolveRipgrep({ environment: { PATH: "" } });
    assert.equal(typeof ripgrep, "string", "Bundled ripgrep is unavailable");
    const ripgrepVersion = await runBoundedCommand(ripgrep, ["--version"], {
      cwd: paths.install,
      env: { ...environment, PATH: "" },
      timeoutMs: 30_000,
      label: "bundled ripgrep version check",
    });
    assert.match(ripgrepVersion.stdout, /^ripgrep \d+/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  writeFileSync(1,
    `Verified ${manifest.archives.length} npm archives, the source archive, and the ${expectedPlatform}/${expectedArch} standalone archive.\n`);
}

try {
  await main();
} catch (error) {
  writeFileSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
