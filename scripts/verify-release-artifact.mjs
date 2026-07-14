import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkReleaseMetadata } from "./check-release-metadata.mjs";
import { resolveNpmInvocation } from "./lifecycle-common.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
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
    directory: resolve(PROJECT_ROOT, values.get("--directory")),
    expectedPlatform: values.get("--expected-platform"),
    expectedArch: values.get("--expected-arch"),
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
  };
}

function assertManifest(manifest, platformPolicy, expectedPlatform, expectedArch) {
  assert.equal(manifest.schemaVersion, 1, "Unsupported release manifest schema");
  assert.equal(manifest.product, "rigyn");
  assert.equal(manifest.tag, `v${manifest.version}`);
  assert.equal(manifest.packaging, "node-native-npm");
  assert.equal(manifest.node, "^24.15.0 || >=26.0.0");
  assert.equal(manifest.checksumFile, "SHA256SUMS");
  assert.equal(manifest.releaseNotes, "RELEASE_NOTES.md");
  assert.deepEqual(manifest.targets, platformPolicy.targets, "Staged targets do not match release/platforms.json");
  assert.equal(typeof manifest.archive?.file, "string");
  assert.equal(basename(manifest.archive.file), manifest.archive.file, "Archive file must be a basename");
  assert.match(manifest.archive.sha256, /^[0-9a-f]{64}$/u);
  assert.match(manifest.archive.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
  assert.ok(Number.isSafeInteger(manifest.archive.bytes) && manifest.archive.bytes > 0, "Archive byte size must be positive");
  assert.ok(
    manifest.targets.some((target) => target.platform === expectedPlatform && target.arch === expectedArch),
    `Release manifest does not declare ${expectedPlatform}/${expectedArch}`,
  );
}

async function main() {
  const { directory, expectedPlatform, expectedArch } = parseArguments(process.argv.slice(2));
  assert.equal(process.platform, expectedPlatform, `Runner platform is ${process.platform}, expected ${expectedPlatform}`);
  assert.equal(process.arch, expectedArch, `Runner architecture is ${process.arch}, expected ${expectedArch}`);
  const releasePolicy = await checkReleaseMetadata(PROJECT_ROOT);
  const platformPolicy = JSON.parse(await readFile(resolve(PROJECT_ROOT, "release/platforms.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(directory, "release-manifest.json"), "utf8"));
  assertManifest(manifest, platformPolicy, expectedPlatform, expectedArch);
  assert.equal(manifest.version, releasePolicy.version, "Staged version does not match the checkout");
  const archivePath = resolve(directory, manifest.archive.file);
  assert.equal(dirname(archivePath), directory, "Archive path escapes the release directory");
  const archive = await readFile(archivePath);
  assert.equal(archive.byteLength, manifest.archive.bytes, "Archive size does not match the manifest");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(sha256, manifest.archive.sha256, "Archive SHA-256 does not match the manifest");
  assert.equal(integrity, manifest.archive.integrity, "Archive SHA-512 integrity does not match the manifest");
  const outputMarker = JSON.parse(await readFile(resolve(directory, OUTPUT_MARKER), "utf8"));
  assert.deepEqual(Object.keys(outputMarker).sort(), [
    "product",
    "schemaVersion",
    "version",
    "archive",
    "archiveSha256",
  ].sort(), "Release output ownership marker must use the exact schema");
  assert.equal(outputMarker.product, "rigyn");
  assert.equal(outputMarker.schemaVersion, 1);
  assert.equal(outputMarker.version, manifest.version);
  assert.equal(outputMarker.archive, manifest.archive.file);
  assert.equal(outputMarker.archiveSha256, sha256);
  assert.equal(
    await readFile(resolve(directory, manifest.checksumFile), "utf8"),
    `${sha256}  ${manifest.archive.file}\n`,
    "SHA256SUMS does not match the archive",
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
    npmCache: join(root, "npm-cache"),
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
      paths.npmCache,
      paths.npmLogs,
      paths.install,
    ].map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })));
    await Promise.all([
      writeFile(paths.npmUserConfig, "", { mode: 0o600 }),
      writeFile(paths.npmGlobalConfig, "", { mode: 0o600 }),
    ]);
    const environment = isolatedEnvironment(paths);
    const invocation = await resolveNpmInvocation([
      "install",
      "--global=false",
      "--omit=dev",
      "--include=optional",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefix",
      paths.install,
      archivePath,
    ]);
    await run(invocation.command, invocation.args, {
      cwd: paths.install,
      env: environment,
      timeoutMs: 300_000,
      label: "release archive install",
    });
    const packageRoot = resolve(paths.install, "node_modules", "rigyn");
    const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    assert.equal(packageManifest.name, manifest.product);
    assert.equal(packageManifest.version, manifest.version);

    const cli = await run(process.execPath, [resolve(packageRoot, packageManifest.bin["rigyn"]), "--version"], {
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
      await import(`${pathToFileURL(target).href}?release-verification=${encodeURIComponent(subpath)}`);
    }

    const requireFromPackage = createRequire(resolve(packageRoot, "package.json"));
    const sharpEntry = requireFromPackage.resolve("sharp");
    const sharpSmoke = await run(process.execPath, [
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
    const ripgrepVersion = await run(ripgrep, ["--version"], {
      cwd: paths.install,
      env: { ...environment, PATH: "" },
      timeoutMs: 30_000,
      label: "bundled ripgrep version check",
    });
    assert.match(ripgrepVersion.stdout, /^ripgrep \d+/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  process.stdout.write(`Verified ${manifest.archive.file} on ${expectedPlatform}/${expectedArch}.\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
