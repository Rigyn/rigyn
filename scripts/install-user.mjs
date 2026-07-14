import { randomBytes } from "node:crypto";
import {
  chmod,
  cp,
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

function errno(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentName.test(name)));
}

async function runNpm(args, cwd) {
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
    label: `npm ${args[0]}`,
  });
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
    return;
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
  await Promise.all([
    rm(staging, { recursive: true, force: true }),
    rm(buildStaging, { recursive: true, force: true }),
    rm(transactionPath, { force: true }),
  ]);
}

async function prepareRoot() {
  await recoverInterruptedUninstall(installRoot);
  const rootExisted = await exists(installRoot);
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
    await recoverInstallTransaction(markerRecord);
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

async function ensureLocalCredentialKey() {
  if (process.platform === "win32") return;
  const directory = join(installRoot, "config", "rigyn");
  const path = join(directory, "credentials.key");
  await ensurePrivateDirectory(directory);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Credential key must be a regular file: ${path}`);
    }
    await chmod(path, 0o600);
  }
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
  const sourceCheckout = await exists(join(projectRoot, "src"))
    && await exists(join(projectRoot, "tsconfig.json"))
    && await exists(join(projectRoot, "package-lock.json"));
  await assertProtectedInstallRoot(installRoot, {
    callerCwd: process.cwd(),
    projectRoot,
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
      await writeFileAtomically(transactionPath, `${JSON.stringify({
        product: "rigyn",
        schemaVersion: 1,
        transactionId: randomBytes(16).toString("hex"),
        pid: process.pid,
        createdAt: Date.now(),
        rootExisted: rootState.rootExisted,
        rootMode: rootState.rootMode,
        previousMarkerSha256: rootState.markerRecord === undefined ? null : sha256(rootState.markerRecord.contents),
      }, null, 2)}\n`, 0o600);
      transactionStarted = true;
      await prepareInstallDirectories();

      await rm(buildStaging, { recursive: true, force: true });
      let packageSource = projectRoot;
      if (sourceCheckout) {
        await mkdir(buildStaging, { recursive: true, mode: 0o700 });
        await Promise.all([
          ...["package.json", "package-lock.json", "tsconfig.json", "CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md"].map(async (path) =>
            await cp(join(projectRoot, path), join(buildStaging, path))),
          ...["src", "docs", "examples", "resources", "scripts"].map(async (path) =>
            await cp(join(projectRoot, path), join(buildStaging, path), { recursive: true })),
        ]);
        await runNpm(["ci", "--global=false", "--include=dev", "--include=optional", "--bin-links=true", "--ignore-scripts", "--no-audit", "--no-fund"], buildStaging);
        await runNpm(["run", "build"], buildStaging);
        packageSource = buildStaging;
      } else if (!(await exists(join(projectRoot, "dist", "bin", "rigyn.js")))) {
        throw new Error("Package contains neither build sources nor a built Rigyn executable");
      }

      const sourceManifest = JSON.parse(await readFile(join(packageSource, "package.json"), "utf8"));
      if (sourceManifest?.name !== "rigyn" || typeof sourceManifest.version !== "string" || sourceManifest.version === "") {
        throw new Error("Source package identity is invalid");
      }

      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFile(join(staging, "package.json"), `${JSON.stringify({
        name: "rigyn-user-install",
        private: true,
        version: "0.0.0",
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
        packageSource,
      ], staging);
      await writeFile(join(staging, "package.json"), `${JSON.stringify({
        name: "rigyn-user-install",
        private: true,
        version: "0.0.0",
        dependencies: { "rigyn": sourceManifest.version },
      }, null, 2)}\n`);
      await Promise.all([
        rm(join(staging, "package-lock.json"), { force: true }),
        rm(join(staging, "node_modules", ".package-lock.json"), { force: true }),
      ]);

      const stagedPackage = join(staging, "node_modules", "rigyn");
      const stagedMetadata = await lstat(stagedPackage);
      if (!stagedMetadata.isDirectory() || stagedMetadata.isSymbolicLink()) {
        throw new Error("Installed package must be an independent directory");
      }
      if (await realpath(stagedPackage) === await realpath(projectRoot)) {
        throw new Error("Installed package resolves to the source checkout");
      }

      appSwap = await beginAppSwap(join(installRoot, "app"));
      await ensureLocalCredentialKey();
      const launcherContents = process.platform === "win32" ? windowsLauncher() : posixLauncher(installRoot);
      launcherChange = await replaceRegularFile(paths.launcher, launcherContents, 0o755, "Install launcher");
      commandChange = await ensureCommand(paths.launcher, rootState.markerRecord?.marker);
      const commandContents = process.platform === "win32" ? launcherContents : managedCommand(paths.launcher);
      const marker = createInstallationMarker(
        installRoot,
        sourceManifest.version,
        { launcher: launcherContents, command: commandContents },
        rootState.markerRecord?.marker,
      );
      await writeFileAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 0o600);
      committed = true;

      await rm(previousApp, { recursive: true, force: true });
      await rm(transactionPath, { force: true });
      transactionStarted = false;
      process.stdout.write(`Installed a self-contained Rigyn copy at ${installRoot}\n`);
      process.stdout.write(`Installed command at ${paths.command}\n`);
      const commandDirectory = process.platform === "win32" ? join(installRoot, "bin") : join(homedir(), ".local", "bin");
      if ((process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").includes(commandDirectory)) {
        process.stdout.write("Run rigyn from any directory.\n");
      } else {
        process.stdout.write(`Add ${commandDirectory} to PATH, then run rigyn.\n`);
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
          throw new AggregateError(failures, "Rigyn installation failed and rollback was incomplete");
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

await install();
