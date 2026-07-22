import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALLATION_MARKER,
  INSTALL_TRANSACTION,
  RIGYN_PRODUCT_PACKAGE_GRAPH,
  assertNoOtherActiveRuntimes,
  assertOwnedLaunchers,
  assertProtectedInstallRoot,
  createInstallationMarker,
  ensurePrivateDirectory,
  exists,
  installationPaths,
  managedCommand,
  posixLauncher,
  readInstallationMarker,
  recoverInterruptedUninstall,
  resolveNpmInvocation,
  runLifecycleChild,
  sha256,
  windowsLauncher,
  withLifecycleLock,
  writeFileAtomically,
} from "./lifecycle-common.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(projectRoot, "../..");
const installRoot = resolve(process.env.RIGYN_INSTALL_DIR ?? join(homedir(), ".rigyn"));
const markerPath = join(installRoot, INSTALLATION_MARKER);
const transactionPath = join(installRoot, INSTALL_TRANSACTION);
const staging = join(installRoot, ".app-install");
const buildStaging = join(installRoot, ".build-install");
const previousApp = join(installRoot, ".app-previous");
const npmHome = join(installRoot, "home");
const npmUserConfig = join(installRoot, "config", "npm", "user.npmrc");
const npmGlobalConfig = join(installRoot, "config", "npm", "global.npmrc");
const paths = installationPaths(installRoot);
const sensitiveEnvironmentName = /(?:^|_)(?:api_?key|auth(?:orization|_?token)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const agentScaffoldTemplates = [
  { destination: "AGENTS.md", source: "AGENTS.md", label: "Agent instructions" },
  { destination: "settings.json", source: "settings.example.json", label: "Agent settings" },
];

function errno(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentName.test(name)));
}

async function runNpm(args, cwd, label = `npm ${args[0]}`) {
  const invocation = await resolveNpmInvocation(args);
  await runLifecycleChild(invocation.command, invocation.args, {
    cwd,
    env: {
      ...childEnvironment(),
      HOME: npmHome,
      USERPROFILE: npmHome,
      XDG_CONFIG_HOME: join(installRoot, "config"),
      XDG_STATE_HOME: join(installRoot, "state"),
      XDG_CACHE_HOME: join(installRoot, "cache"),
      XDG_DATA_HOME: join(installRoot, "data"),
      TMPDIR: join(installRoot, "tmp"),
      TMP: join(installRoot, "tmp"),
      TEMP: join(installRoot, "tmp"),
      npm_config_cache: process.env.RIGYN_INSTALL_NPM_CACHE ?? join(installRoot, "cache", "npm"),
      npm_config_global: "false",
      npm_config_globalconfig: npmGlobalConfig,
      npm_config_prefix: join(installRoot, "npm-prefix"),
      npm_config_userconfig: npmUserConfig,
      npm_config_bin_links: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    label,
  });
}

const sourcePackageContents = new Map([
  ["packages/terminal", ["package.json", "tsconfig.build.json", "LICENSE", "README.md", "native", "scripts", "src"]],
  ["packages/models", ["package.json", "tsconfig.build.json", "LICENSE", "README.md", "scripts", "src"]],
  ["packages/kernel", ["package.json", "tsconfig.build.json", "LICENSE", "README.md", "src"]],
  ["packages/rigyn", [
    "package.json",
    "tsconfig.json",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "docs",
    "examples",
    "resources",
    "scripts",
    "src",
  ]],
]);

async function isSourceCheckout() {
  if (!(await exists(join(projectRoot, "src")))
    || !(await exists(join(repositoryRoot, "package.json")))
    || !(await exists(join(repositoryRoot, "package-lock.json")))) return false;
  return (await Promise.all(RIGYN_PRODUCT_PACKAGE_GRAPH.map(async ({ directory }) =>
    await exists(join(repositoryRoot, directory, "package.json"))))).every(Boolean);
}

async function assertCopyableSource(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Source build input must not be a symbolic link: ${path}`);
  if (!metadata.isDirectory()) {
    if (!metadata.isFile()) throw new Error(`Source build input must be a regular file or directory: ${path}`);
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || /^\.env(?:\.|$)/iu.test(entry.name)) {
      throw new Error(`Source build input contains private or installed state: ${join(path, entry.name)}`);
    }
    await assertCopyableSource(join(path, entry.name));
  }
}

export function sourceBuildSteps(platform = process.platform) {
  const nativePlatform = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : undefined;
  return [
    ["@rigyn/terminal", "build", "rigyn terminal source build"],
    ...(nativePlatform === undefined ? [] : [
      ["@rigyn/terminal", "native:build", `${nativePlatform} native terminal helper build`],
      ["@rigyn/terminal", "native:verify", `${nativePlatform} native terminal helper verification`],
    ]),
    ["@rigyn/models", "build:offline", "rigyn model catalog source build"],
    ["@rigyn/kernel", "build", "rigyn kernel source build"],
    ["rigyn", "build", "rigyn application source build"],
  ];
}

async function prepareSourcePackages() {
  const workspace = join(buildStaging, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await Promise.all([
    assertCopyableSource(join(repositoryRoot, "package.json")),
    assertCopyableSource(join(repositoryRoot, "package-lock.json")),
  ]);
  await Promise.all([
    cp(join(repositoryRoot, "package.json"), join(workspace, "package.json")),
    cp(join(repositoryRoot, "package-lock.json"), join(workspace, "package-lock.json")),
    ...RIGYN_PRODUCT_PACKAGE_GRAPH.flatMap(({ directory }) => sourcePackageContents.get(directory).map(async (path) => {
      const source = join(repositoryRoot, directory, path);
      const destination = join(workspace, directory, path);
      await assertCopyableSource(source);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await cp(source, destination, { recursive: true });
    })),
  ]);
  await runNpm([
    "ci",
    "--global=false",
    "--include=dev",
    "--include=optional",
    "--bin-links=true",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], workspace);
  for (const [name, script, label] of sourceBuildSteps()) {
    await runNpm(["run", script, "--workspace", name], workspace, label);
  }
  return new Map(RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name, directory }) => [name, join(workspace, directory)]));
}

async function installedPackageRoots() {
  const requireFromProduct = createRequire(join(projectRoot, "package.json"));
  const roots = new Map([["rigyn", projectRoot]]);
  for (const { name } of RIGYN_PRODUCT_PACKAGE_GRAPH) {
    if (name === "rigyn") continue;
    roots.set(name, dirname(requireFromProduct.resolve(`${name}/package.json`)));
  }
  return roots;
}

async function packPackages(packageRoots) {
  const tarballDirectory = join(buildStaging, "tarballs");
  await mkdir(tarballDirectory, { recursive: true, mode: 0o700 });
  const tarballs = [];
  const versions = new Map();
  let nodeTypesVersion;
  for (const { name } of RIGYN_PRODUCT_PACKAGE_GRAPH) {
    const packageRoot = packageRoots.get(name);
    if (packageRoot === undefined) throw new Error(`Package root is missing for ${name}`);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (manifest?.name !== name || typeof manifest.version !== "string" || manifest.version === "") {
      throw new Error(`Source package identity is invalid for ${name}`);
    }
    versions.set(name, manifest.version);
    if (name === "rigyn") nodeTypesVersion = manifest.devDependencies?.["@types/node"];
    const before = new Set(await readdir(tarballDirectory));
    await runNpm([
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      tarballDirectory,
      packageRoot,
    ], tarballDirectory);
    const created = (await readdir(tarballDirectory)).filter((entry) => !before.has(entry));
    if (created.length !== 1 || !created[0].endsWith(".tgz")) {
      throw new Error(`npm pack must produce exactly one archive for ${name}`);
    }
    const tarball = join(tarballDirectory, created[0]);
    const metadata = await lstat(tarball);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`npm pack produced an unsafe archive for ${name}`);
    }
    tarballs.push(tarball);
  }
  const productVersion = versions.get("rigyn");
  for (const [name, version] of versions) {
    if (version !== productVersion) throw new Error(`${name} version ${version} does not match rigyn ${productVersion}`);
  }
  if (typeof nodeTypesVersion !== "string" || nodeTypesVersion === "") {
    throw new Error("rigyn must pin @types/node for reproducible offline installation");
  }
  return { tarballs, productVersion, nodeTypesVersion };
}

async function readControlJson(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024) {
    throw new Error(`${label} must be a bounded regular file: ${path}`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${path}`, { cause: error });
  }
}

function parseInstallTransaction(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.product !== "rigyn" || value.schemaVersion !== 1
    || !/^[a-f0-9]{32}$/u.test(value.transactionId)
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.rootExisted !== "boolean"
    || !Number.isSafeInteger(value.rootMode) || value.rootMode < 0 || value.rootMode > 0o777
    || !(value.previousMarkerSha256 === null || /^[a-f0-9]{64}$/u.test(value.previousMarkerSha256))) {
    throw new Error(`Install transaction is invalid: ${transactionPath}`);
  }
  return value;
}

async function removeRecoveredCommand() {
  if (process.platform === "win32" || !(await exists(paths.command))) return;
  const metadata = await lstat(paths.command);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return;
  if (await readFile(paths.command, "utf8") === managedCommand(paths.launcher)) {
    await rm(paths.command, { force: true });
  }
}

async function recoverInstallTransaction(markerRecord) {
  if (!(await exists(transactionPath))) return;
  const transaction = parseInstallTransaction(await readControlJson(transactionPath, "Install transaction"));
  if (markerRecord === undefined) {
    await removeRecoveredCommand();
    await rm(installRoot, { recursive: true, force: true });
    if (transaction.rootExisted) {
      await mkdir(installRoot, { recursive: true, mode: transaction.rootMode });
      if (process.platform !== "win32") await chmod(installRoot, transaction.rootMode);
    }
    return { rootExisted: transaction.rootExisted, rootMode: transaction.rootMode };
  }

  const markerUnchanged = transaction.previousMarkerSha256 === sha256(markerRecord.contents);
  const app = join(installRoot, "app");
  if (await exists(previousApp)) {
    if (markerUnchanged) {
      await rm(app, { recursive: true, force: true });
      await rename(previousApp, app);
    } else if (await exists(app)) {
      await rm(previousApp, { recursive: true, force: true });
    } else {
      throw new Error("Committed installation is missing its active application directory");
    }
  } else if (!markerUnchanged && !(await exists(app))) {
    throw new Error("Committed installation is missing its active application directory");
  }
  if (!markerUnchanged) {
    await rm(buildStaging, { recursive: true, force: true });
    await mkdir(buildStaging, { recursive: true, mode: 0o700 });
    await ensureAgentScaffold(
      join(installRoot, "agent"),
      join(app, "node_modules", "rigyn", "resources"),
      buildStaging,
    );
  }
  await Promise.all([
    rm(staging, { recursive: true, force: true }),
    rm(buildStaging, { recursive: true, force: true }),
    rm(transactionPath, { force: true }),
  ]);
}

async function prepareRoot() {
  await recoverInterruptedUninstall(installRoot);
  let rootExisted = await exists(installRoot);
  let rootMode = 0o700;
  let markerRecord;
  if (rootExisted) {
    const metadata = await lstat(installRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Install path must be a real directory: ${installRoot}`);
    }
    rootMode = metadata.mode & 0o777;
    markerRecord = await readInstallationMarker(installRoot);
    if (markerRecord !== undefined) {
      await assertOwnedLaunchers(installRoot, markerRecord.marker, {
        allowMissing: await exists(transactionPath),
      });
      await assertNoOtherActiveRuntimes(installRoot, markerRecord.marker);
    }
    const recoveredRoot = await recoverInstallTransaction(markerRecord);
    if (recoveredRoot !== undefined) {
      rootExisted = recoveredRoot.rootExisted;
      rootMode = recoveredRoot.rootMode;
      await mkdir(installRoot, { recursive: true, mode: 0o700 });
    }
    markerRecord = await readInstallationMarker(installRoot);
    const entries = await readdir(installRoot);
    const abandonedAtomics = entries.filter((entry) => entry.startsWith(`${INSTALL_TRANSACTION}.install-`));
    if (markerRecord === undefined && entries.length > 0 && abandonedAtomics.length === entries.length) {
      await Promise.all(abandonedAtomics.map(async (entry) => await rm(join(installRoot, entry), { force: true })));
    } else if (markerRecord === undefined && entries.length > 0) {
      throw new Error(`Refusing to replace an unrecognized non-empty directory: ${installRoot}`);
    }
    if (markerRecord !== undefined) {
      await assertOwnedLaunchers(installRoot, markerRecord.marker);
      await assertNoOtherActiveRuntimes(installRoot, markerRecord.marker);
    }
  }
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(installRoot, 0o700);
  return { rootExisted, rootMode, markerRecord };
}

async function prepareInstallDirectories() {
  for (const path of [
    join(installRoot, "bin"),
    join(installRoot, "config"),
    join(installRoot, "config", "npm"),
    join(installRoot, "state"),
    join(installRoot, "cache"),
    join(installRoot, "data"),
    join(installRoot, "tmp"),
    join(installRoot, "logs"),
    join(installRoot, "logs", "npm"),
    join(installRoot, "npm-prefix"),
    npmHome,
  ]) await ensurePrivateDirectory(path);
  await Promise.all([
    writeFileAtomically(npmUserConfig, "", 0o600),
    writeFileAtomically(npmGlobalConfig, "", 0o600),
  ]);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readScaffoldTemplate(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} template must be a regular file: ${path}`);
  }
  return await readFile(path);
}

async function inspectScaffoldFile(path, label) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file: ${path}`);
    }
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertAgentDirectory(path, expectedIdentity) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Agent directory must be a real directory: ${path}`);
  }
  if (expectedIdentity !== undefined && !sameFileIdentity(metadata, expectedIdentity)) {
    throw new Error(`Agent directory changed while creating its scaffold: ${path}`);
  }
  return metadata;
}

async function createMissingScaffoldFile(path, contents, label, temporaryDirectory, directoryIdentity) {
  const temporaryPath = join(temporaryDirectory, `.agent-scaffold-${randomBytes(16).toString("hex")}`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await assertAgentDirectory(dirname(path), directoryIdentity);
    try {
      await link(temporaryPath, path);
      return;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    await inspectScaffoldFile(path, label);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Create only missing personalization files. Existing files and permissions are
 * never modified. Files are linked from complete private temporaries so a hard
 * interruption cannot publish a partial settings document.
 */
export async function ensureAgentScaffold(agentDirectory, resourcesDirectory, temporaryDirectory) {
  const templates = await Promise.all(agentScaffoldTemplates.map(async (template) => ({
    ...template,
    contents: await readScaffoldTemplate(join(resourcesDirectory, template.source), template.label),
  })));
  await mkdir(agentDirectory, { recursive: false, mode: 0o700 }).catch((error) => {
    if (errno(error) !== "EEXIST") throw error;
  });
  const directoryMetadata = await assertAgentDirectory(agentDirectory);
  const directoryIdentity = { dev: directoryMetadata.dev, ino: directoryMetadata.ino };
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const temporaryMetadata = await lstat(temporaryDirectory);
  if (!temporaryMetadata.isDirectory() || temporaryMetadata.isSymbolicLink()) {
    throw new Error(`Agent scaffold staging path must be a real directory: ${temporaryDirectory}`);
  }

  const existing = await Promise.all(templates.map(async (template) => await inspectScaffoldFile(
    join(agentDirectory, template.destination),
    template.label,
  )));
  for (const [index, template] of templates.entries()) {
    if (existing[index]) continue;
    await createMissingScaffoldFile(
      join(agentDirectory, template.destination),
      template.contents,
      template.label,
      temporaryDirectory,
      directoryIdentity,
    );
  }
}

async function beginAppSwap(app) {
  const hadApp = await exists(app);
  if (await exists(previousApp)) throw new Error(`Unrecovered application backup remains at ${previousApp}`);
  if (hadApp) await rename(app, previousApp);
  try {
    await rename(staging, app);
  } catch (error) {
    if (hadApp && !(await exists(app))) await rename(previousApp, app);
    throw error;
  }
  return { app, hadApp };
}

async function rollbackAppSwap(transaction) {
  if (await exists(transaction.app)) await rm(transaction.app, { recursive: true, force: true });
  if (transaction.hadApp) await rename(previousApp, transaction.app);
  else await rm(previousApp, { recursive: true, force: true });
}

async function replaceRegularFile(path, contents, mode, label) {
  let previous;
  if (await exists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
    previous = { contents: await readFile(path, "utf8"), mode: metadata.mode & 0o777 };
  }
  await writeFileAtomically(path, contents, mode);
  return { path, previous };
}

async function restoreRegularFile(change) {
  if (change === undefined) return;
  if (change.previous === undefined) await rm(change.path, { force: true });
  else await writeFileAtomically(change.path, change.previous.contents, change.previous.mode);
}

async function ensureCommand(launcher, previousMarker) {
  if (process.platform === "win32") return { path: launcher };
  const commandDirectory = dirname(paths.command);
  await mkdir(commandDirectory, { recursive: true, mode: 0o700 });
  const commandDirectoryMetadata = await lstat(commandDirectory);
  if (!commandDirectoryMetadata.isDirectory() || commandDirectoryMetadata.isSymbolicLink()) {
    throw new Error(`Command directory must be a real directory: ${commandDirectory}`);
  }
  if (await exists(paths.command) && previousMarker === undefined) {
    throw new Error(`Refusing to replace a command not owned by this installation: ${paths.command}`);
  }
  return await replaceRegularFile(paths.command, managedCommand(launcher), 0o755, "Managed command");
}

async function install() {
  const sourceCheckout = await isSourceCheckout();
  await assertProtectedInstallRoot(installRoot, {
    callerCwd: process.cwd(),
    projectRoot: sourceCheckout ? repositoryRoot : projectRoot,
    sourceCheckout,
  });

  await withLifecycleLock(installRoot, async () => {
    let rootState;
    let appSwap;
    let launcherChange;
    let commandChange;
    let transactionStarted = false;
    let committed = false;
    let rollbackComplete = false;
    try {
      rootState = await prepareRoot();
      const installTransaction = {
        product: "rigyn",
        schemaVersion: 1,
        transactionId: randomBytes(16).toString("hex"),
        pid: process.pid,
        createdAt: Date.now(),
        rootExisted: rootState.rootExisted,
        rootMode: rootState.rootMode,
        previousMarkerSha256: rootState.markerRecord === undefined ? null : sha256(rootState.markerRecord.contents),
      };
      await writeFileAtomically(transactionPath, `${JSON.stringify(installTransaction, null, 2)}\n`, 0o600);
      transactionStarted = true;
      await prepareInstallDirectories();

      await rm(buildStaging, { recursive: true, force: true });
      await mkdir(buildStaging, { recursive: true, mode: 0o700 });
      if (!sourceCheckout && !(await exists(join(projectRoot, "dist", "bin", "rigyn.js")))) {
        throw new Error("Package contains neither build sources nor a built rigyn executable");
      }
      const packageRoots = sourceCheckout ? await prepareSourcePackages() : await installedPackageRoots();
      const { tarballs, productVersion, nodeTypesVersion } = await packPackages(packageRoots);

      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFile(join(staging, "package.json"), `${JSON.stringify({
        name: "rigyn-user-install",
        private: true,
        version: "0.0.0",
        overrides: { "@types/node": nodeTypesVersion },
      }, null, 2)}\n`);
      await writeFile(join(staging, ".npmrc"), "install-links=true\n");
      await runNpm([
        "install",
        "--global=false",
        "--install-links",
        "--omit=dev",
        "--include=optional",
        "--bin-links=true",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...tarballs,
      ], staging);
      await writeFile(join(staging, "package.json"), `${JSON.stringify({
        name: "rigyn-user-install",
        private: true,
        version: "0.0.0",
        dependencies: { "rigyn": productVersion },
      }, null, 2)}\n`);
      await Promise.all([
        rm(join(staging, "package-lock.json"), { force: true }),
        rm(join(staging, "node_modules", ".package-lock.json"), { force: true }),
      ]);

      const stagedPackage = join(staging, "node_modules", "rigyn");
      for (const { name } of RIGYN_PRODUCT_PACKAGE_GRAPH) {
        const installedRoot = name === "rigyn"
          ? stagedPackage
          : join(staging, "node_modules", ...name.split("/"));
        const installedMetadata = await lstat(installedRoot);
        if (!installedMetadata.isDirectory() || installedMetadata.isSymbolicLink()) {
          throw new Error(`Installed package must be an independent directory: ${name}`);
        }
        if (await realpath(installedRoot) === await realpath(packageRoots.get(name))) {
          throw new Error(`Installed package resolves to its package source: ${name}`);
        }
        const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
        if (installedManifest?.name !== name || installedManifest.version !== productVersion) {
          throw new Error(`Installed package identity does not match its archive: ${name}`);
        }
      }

      appSwap = await beginAppSwap(join(installRoot, "app"));
      const launcherContents = process.platform === "win32" ? windowsLauncher() : posixLauncher(installRoot);
      launcherChange = await replaceRegularFile(paths.launcher, launcherContents, 0o755, "Install launcher");
      commandChange = await ensureCommand(paths.launcher, rootState.markerRecord?.marker);
      const commandContents = process.platform === "win32" ? launcherContents : managedCommand(paths.launcher);
      const marker = createInstallationMarker(
        installRoot,
        productVersion,
        { launcher: launcherContents, command: commandContents },
        rootState.markerRecord?.marker,
      );
      await writeFileAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 0o600);
      committed = true;
      await ensureAgentScaffold(
        join(installRoot, "agent"),
        join(installRoot, "app", "node_modules", "rigyn", "resources"),
        buildStaging,
      );

      await rm(previousApp, { recursive: true, force: true });
      await rm(transactionPath, { force: true });
      transactionStarted = false;
      writeFileSync(1, `Installed a self-contained rigyn copy at ${installRoot}\n`);
      writeFileSync(1, `Installed command at ${paths.command}\n`);
      const commandDirectory = process.platform === "win32" ? join(installRoot, "bin") : join(homedir(), ".local", "bin");
      if ((process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").includes(commandDirectory)) {
        writeFileSync(1, "Run rigyn from any directory.\n");
      } else {
        writeFileSync(1, `Add ${commandDirectory} to PATH, then run rigyn.\n`);
      }
    } catch (error) {
      if (!committed) {
        const failures = [error];
        for (const rollback of [
          async () => await restoreRegularFile(commandChange),
          async () => await restoreRegularFile(launcherChange),
          async () => { if (appSwap !== undefined) await rollbackAppSwap(appSwap); },
        ]) {
          try {
            await rollback();
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "rigyn installation failed and rollback was incomplete");
        }
        rollbackComplete = true;
      }
      throw error;
    } finally {
      await Promise.all([
        rm(staging, { recursive: true, force: true }),
        rm(buildStaging, { recursive: true, force: true }),
      ]);
      if (!committed && transactionStarted && rollbackComplete) await rm(transactionPath, { force: true });
      if (!committed && rollbackComplete && rootState !== undefined && rootState.markerRecord === undefined) {
        await removeRecoveredCommand();
        await rm(installRoot, { recursive: true, force: true });
        if (rootState.rootExisted) {
          await mkdir(installRoot, { recursive: true, mode: rootState.rootMode });
          if (process.platform !== "win32") await chmod(installRoot, rootState.rootMode);
        }
      }
    }
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await install();
