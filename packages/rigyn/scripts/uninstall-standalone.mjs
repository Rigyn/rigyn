import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireLifecycleLock,
  assertNoOtherActiveRuntimes,
  prepareManagedCredentialPurge,
  purgeManagedToolOutput,
  standaloneInstallationId,
  terminateLifecycleProcessTree,
  withCredentialPurgeDisposal,
  writeFileAtomically,
} from "./lifecycle-common.mjs";

const PRODUCT = "rigyn";
const MAX_METADATA_BYTES = 64 * 1024;
const WINDOWS_BROKER_DIAGNOSTIC_MAX_BYTES = 8 * 1024;
const WINDOWS_BROKER_DIAGNOSTIC_RAW_BYTES = WINDOWS_BROKER_DIAGNOSTIC_MAX_BYTES + 256;
const WINDOWS_WORKER_STARTUP_TIMEOUT_MS = 30_000;
const WINDOWS_BROKER_STARTUP_TIMEOUT_MS = 45_000;
const RUNTIME_NAME = /^rigyn-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-(linux|darwin|win32)-(x64|arm64)$/u;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const activeRuntime = resolve(packageRoot, "../../..");
const installRoot = resolve(process.env.RIGYN_INSTALL_DIR ?? join(homedir(), ".rigyn"));
const launcher = join(installRoot, "bin", process.platform === "win32" ? "rigyn.cmd" : "rigyn");
const command = process.platform === "win32" ? launcher : join(homedir(), ".local", "bin", "rigyn");

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function inside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep));
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertRealDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

async function readBoundedJson(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_METADATA_BYTES) {
    throw new Error(`${label} is not a safe file: ${path}`);
  }
  const contents = await readFile(path, "utf8");
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} is not valid JSON: ${path}`);
  }
}

async function assertPosixLink(path, target, label, allowMissing = false) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink()) throw new Error(`${label} is not a managed symbolic link: ${path}`);
    const linked = await readlink(path);
    if (!samePath(resolve(dirname(path), linked), target)) {
      throw new Error(`${label} points outside this installation: ${path}`);
    }
  } catch (error) {
    if (allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function assertWindowsLauncher(path, runtimeName) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
    throw new Error(`Standalone launcher is not a safe managed file: ${path}`);
  }
  const expected = [
    "@echo off",
    "rem rigyn standalone managed command",
    `"%USERPROFILE%\\.rigyn\\runtime\\${runtimeName}\\bin\\rigyn.cmd" %*`,
    "",
  ].join("\r\n");
  if (await readFile(path, "utf8") !== expected) {
    throw new Error(`Standalone launcher ownership check failed: ${path}`);
  }
}

async function validateInstallation() {
  const runtimeName = basename(activeRuntime);
  const match = RUNTIME_NAME.exec(runtimeName);
  if (match === null || match[4] !== process.platform || match[5] !== process.arch) {
    throw new Error(`Active standalone runtime has an unrecognized name: ${activeRuntime}`);
  }
  if (!samePath(packageRoot, join(activeRuntime, "lib", "node_modules", PRODUCT))) {
    throw new Error("Standalone package is outside its active runtime");
  }
  if (!samePath(dirname(activeRuntime), join(installRoot, "runtime"))) {
    throw new Error(`Active standalone runtime is outside the managed installation: ${installRoot}`);
  }
  if (inside(installRoot, process.cwd())) {
    throw new Error(`Run the uninstall command from outside the installation directory: ${installRoot}`);
  }

  await assertRealDirectory(installRoot, "Standalone installation root");
  await assertRealDirectory(join(installRoot, "runtime"), "Standalone runtime root");
  await assertRealDirectory(activeRuntime, "Active standalone runtime");
  if (await exists(join(installRoot, ".installation.json"))) {
    throw new Error(`A source-built installation owns ${installRoot}; refusing standalone removal`);
  }

  const packageManifest = await readBoundedJson(join(packageRoot, "package.json"), "Package manifest");
  const metadata = await readBoundedJson(join(activeRuntime, "BUILD-METADATA.json"), "Standalone build metadata");
  const expectedEntrypoint = process.platform === "win32" ? "bin/rigyn.cmd" : "bin/rigyn";
  if (
    packageManifest?.name !== PRODUCT
    || typeof packageManifest.version !== "string"
    || metadata?.schemaVersion !== 1
    || metadata.product !== PRODUCT
    || metadata.version !== packageManifest.version
    || metadata.platform !== process.platform
    || metadata.arch !== process.arch
    || metadata.entrypoint !== expectedEntrypoint
  ) {
    throw new Error(`Standalone metadata does not identify this installation: ${activeRuntime}`);
  }

  if (process.platform === "win32") {
    await assertWindowsLauncher(launcher, runtimeName);
  } else {
    await assertPosixLink(launcher, join(activeRuntime, "bin", "rigyn"), "Standalone launcher");
    await assertPosixLink(command, launcher, "Managed command", true);
  }
}

export async function uninstallPosix(options = {}) {
  const selectedInstallRoot = options.installRoot ?? installRoot;
  const selectedCommand = options.command ?? command;
  const selectedLauncher = options.launcher ?? launcher;
  const purgeCredentials = options.purgeCredentials ?? (async () => undefined);
  return await withCredentialPurgeDisposal(purgeCredentials, async () => {
    const runtimeName = options.runtimeName ?? basename(activeRuntime);
    if (RUNTIME_NAME.exec(runtimeName) === null) {
      throw new Error(`Standalone uninstall runtime name is invalid: ${runtimeName}`);
    }
    const recordPath = `${selectedInstallRoot}.uninstall.json`;
    const tombstone = `${selectedInstallRoot}.uninstalling`;
    const persistRecord = options.persistRecord ?? writeFileAtomically;
    const writeRecord = async (phase) => {
      await persistRecord(recordPath, `${JSON.stringify({
        product: PRODUCT,
        schemaVersion: 1,
        distribution: "standalone",
        phase,
        runtime: runtimeName,
      })}\n`, 0o600);
    };
    if (await exists(recordPath)) throw new Error(`Standalone uninstall transaction already exists: ${recordPath}`);
    if (await exists(tombstone)) throw new Error(`Standalone uninstall tombstone already exists: ${tombstone}`);
    await writeRecord("prepared");
    let removedCommandTarget;
    try {
      await rename(selectedInstallRoot, tombstone);
      await writeRecord("isolated");
      if (await exists(selectedCommand)) {
        await assertPosixLink(selectedCommand, selectedLauncher, "Managed command");
        removedCommandTarget = await readlink(selectedCommand);
        await rm(selectedCommand, { force: true });
      }
      await writeRecord("command-removed");
    } catch (error) {
      const rollbackErrors = [];
      if (await exists(tombstone)) {
        try {
          await rename(tombstone, selectedInstallRoot);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (removedCommandTarget !== undefined) {
        try {
          await symlink(removedCommandTarget, selectedCommand);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length === 0) {
        try {
          await rm(recordPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Standalone uninstall failed and rollback was incomplete",
        );
      }
      throw error;
    }
    await purgeCredentials();
    await rm(tombstone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(recordPath, { force: true });
    if (options.quiet !== true) {
      writeFileSync(1, `Fully removed the standalone rigyn installation at ${selectedInstallRoot}\n`);
    }
  });
}

function windowsCleanupScript() {
  return String.raw`param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Tombstone,
  [Parameter(Mandatory = $true)][string]$TokenPath,
  [Parameter(Mandatory = $true)][string]$ExpectedToken,
  [Parameter(Mandatory = $true)][string]$RecordPath,
  [Parameter(Mandatory = $true)][string]$ExpectedTokenSha256,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [string]$LockPath = "",
  [string]$ExpectedLockToken = ""
)
$ErrorActionPreference = "Stop"
function Get-LifecycleLockOwner {
  if ([string]::IsNullOrEmpty($LockPath)) { return $null }
  $item = Get-Item -LiteralPath $LockPath -Force
  if ($item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -gt 16384) {
    throw "Standalone lifecycle lock is unsafe"
  }
  try {
    $owner = [IO.File]::ReadAllText($LockPath) | ConvertFrom-Json
  } catch {
    throw "Standalone lifecycle lock is invalid"
  }
  if ($owner.schemaVersion -ne 1 -or
      [string]$owner.token -cne $ExpectedLockToken -or
      -not [String]::Equals(
        [IO.Path]::GetFullPath([string]$owner.installRoot),
        [IO.Path]::GetFullPath($Root),
        [StringComparison]::OrdinalIgnoreCase
      )) {
    throw "Standalone lifecycle lock ownership changed"
  }
  return $owner
}
function Assert-LifecycleLock {
  if (-not [string]::IsNullOrEmpty($LockPath)) {
    [void](Get-LifecycleLockOwner)
  }
}
function Transfer-LifecycleLock {
  if ([string]::IsNullOrEmpty($LockPath)) { return }
  $owner = Get-LifecycleLockOwner
  $owner.pid = $PID
  $owner.createdAt = [long]([DateTime]::UtcNow - [DateTime]"1970-01-01").TotalMilliseconds
  [IO.File]::WriteAllText($LockPath, (($owner | ConvertTo-Json -Compress) + [Environment]::NewLine))
  Assert-LifecycleLock
}
function Release-LifecycleLock {
  if ([string]::IsNullOrEmpty($LockPath) -or -not (Test-Path -LiteralPath $LockPath)) { return }
  try {
    $owner = Get-LifecycleLockOwner
    if ([int]$owner.pid -eq $PID) {
      Remove-Item -LiteralPath $LockPath -Force
    }
  } catch {
    # Preserve a lock that no longer proves this worker owns it.
  }
}
function Remove-SafeTree {
  param([Parameter(Mandatory = $true)][string]$Path)
  foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      if ($item.PSIsContainer) {
        [IO.Directory]::Delete($item.FullName)
      } else {
        Remove-Item -LiteralPath $item.FullName -Force
      }
    } elseif ($item.PSIsContainer) {
      Remove-SafeTree -Path $item.FullName
    } else {
      Remove-Item -LiteralPath $item.FullName -Force
    }
  }
  Remove-Item -LiteralPath $Path -Force
}
function Write-UninstallRecord {
  param([Parameter(Mandatory = $true)][string]$Phase)
  $temporaryRecord = $RecordPath + ".tmp"
  try {
    $record.phase = $Phase
    $contents = (($record | ConvertTo-Json -Compress) + [Environment]::NewLine)
    [IO.File]::WriteAllText($temporaryRecord, $contents, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryRecord -Destination $RecordPath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryRecord -Force -ErrorAction SilentlyContinue
  }
}
function Assert-UninstallTarget {
  Assert-LifecycleLock
  if (Test-Path -LiteralPath $Tombstone) {
    throw "Standalone uninstall tombstone already exists"
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (-not $rootItem.PSIsContainer -or
      ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Standalone installation root is unsafe"
  }
  if ((Get-Content -LiteralPath $TokenPath -Raw) -cne $ExpectedToken) {
    throw "Standalone uninstall ownership token changed"
  }
  if (Test-Path -LiteralPath (Join-Path $Root ".installation.json")) {
    throw "A source-built installation owns this path"
  }
}
try {
  $resolvedReadyPath = [IO.Path]::GetFullPath($ReadyPath)
  $expectedReadyPath = [IO.Path]::GetFullPath($PSCommandPath + ".ready")
  if (-not [String]::Equals(
    $resolvedReadyPath,
    $expectedReadyPath,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Standalone uninstall ready path is unsafe"
  }
  $resolvedRecordPath = [IO.Path]::GetFullPath($RecordPath)
  $expectedRecordPath = [IO.Path]::GetFullPath($Root + ".uninstall.json")
  if (-not [String]::Equals(
    $resolvedRecordPath,
    $expectedRecordPath,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Standalone uninstall record path is unsafe"
  }
  $rootParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Root))
  $tombstoneParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Tombstone))
  $tombstonePrefix = [IO.Path]::GetFileName($Root) + ".uninstalling-"
  if (-not [String]::Equals($rootParent, $tombstoneParent, [StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFileName($Tombstone).StartsWith($tombstonePrefix, [StringComparison]::Ordinal)) {
    throw "Standalone uninstall tombstone is unsafe"
  }
  $recordItem = Get-Item -LiteralPath $RecordPath -Force
  if ($recordItem.PSIsContainer -or
      ($recordItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $recordItem.Length -gt 16384) {
    throw "Standalone uninstall record is unsafe"
  }
  try {
    $record = [IO.File]::ReadAllText($RecordPath) | ConvertFrom-Json
  } catch {
    throw "Standalone uninstall record is invalid"
  }
  $recordNames = @($record.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $expectedRecordNames = @("distribution", "installRoot", "phase", "product", "schemaVersion", "tokenFile", "tokenSha256", "tombstone")
  if (($recordNames -join [Environment]::NewLine) -cne ($expectedRecordNames -join [Environment]::NewLine) -or
      [string]$record.product -cne "rigyn" -or
      $record.schemaVersion -ne 1 -or
      [string]$record.distribution -cne "standalone" -or
      [string]$record.phase -cne "prepared" -or
      [string]$record.tokenSha256 -cne $ExpectedTokenSha256 -or
      -not [String]::Equals([IO.Path]::GetFullPath([string]$record.installRoot), [IO.Path]::GetFullPath($Root), [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals([IO.Path]::GetFullPath([string]$record.tombstone), [IO.Path]::GetFullPath($Tombstone), [StringComparison]::OrdinalIgnoreCase) -or
      -not [String]::Equals([IO.Path]::GetFullPath((Join-Path $Root ([string]$record.tokenFile))), [IO.Path]::GetFullPath($TokenPath), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Standalone uninstall record ownership changed"
  }
  Assert-UninstallTarget
  Transfer-LifecycleLock
  [IO.File]::WriteAllText($resolvedReadyPath, "ready")

  $moveDeadline = [DateTime]::UtcNow.AddSeconds(60)
  $moved = $false
  $lastMoveError = $null
  while (-not $moved) {
    Assert-UninstallTarget
    try {
      [IO.Directory]::Move($Root, $Tombstone)
      $moved = $true
      $lastMoveError = $null
    } catch {
      $lastMoveError = $_
    }
    if ($moved) { break }
    if ([DateTime]::UtcNow -ge $moveDeadline) {
      if ($null -ne $lastMoveError) { throw $lastMoveError }
      throw "Timed out isolating the standalone rigyn installation"
    }
    Start-Sleep -Milliseconds 100
  }
  Write-UninstallRecord -Phase "isolated"

  $removalDeadline = [DateTime]::UtcNow.AddSeconds(60)
  $lastRemovalError = $null
  while (Test-Path -LiteralPath $Tombstone) {
    $tombstoneItem = Get-Item -LiteralPath $Tombstone -Force
    if (-not $tombstoneItem.PSIsContainer -or
        ($tombstoneItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Standalone uninstall tombstone changed"
    }
    try {
      Remove-SafeTree -Path $Tombstone
      $lastRemovalError = $null
    } catch {
      $lastRemovalError = $_
    }
    if (-not (Test-Path -LiteralPath $Tombstone)) { break }
    if ([DateTime]::UtcNow -ge $removalDeadline) {
      if ($null -ne $lastRemovalError) { throw $lastRemovalError }
      throw "Timed out removing the standalone rigyn installation"
    }
    Start-Sleep -Milliseconds 100
  }
  Write-UninstallRecord -Phase "removed"
  Remove-Item -LiteralPath $RecordPath -Force
} finally {
  Release-LifecycleLock
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
}

async function waitForWindowsBrokerExit(exitPromise, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `Windows cleanup helper process did not exit within ${timeoutMs} ms after termination`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function appendWindowsBrokerDiagnostic(current, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (value.length >= WINDOWS_BROKER_DIAGNOSTIC_RAW_BYTES) {
    return Buffer.from(value.subarray(value.length - WINDOWS_BROKER_DIAGNOSTIC_RAW_BYTES));
  }
  const retained = current.subarray(Math.max(
    0,
    current.length - (WINDOWS_BROKER_DIAGNOSTIC_RAW_BYTES - value.length),
  ));
  return Buffer.concat([retained, value]);
}

function windowsBrokerFailure(error, output, secrets) {
  let detail = output.toString("utf8");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret !== "") detail = detail.split(secret).join("[redacted]");
  }
  detail = detail
    .replace(/\b[a-f0-9]{32,}\b/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (detail === "") return error;
  const bytes = Buffer.from(detail, "utf8");
  if (bytes.length > WINDOWS_BROKER_DIAGNOSTIC_MAX_BYTES) {
    let start = bytes.length - WINDOWS_BROKER_DIAGNOSTIC_MAX_BYTES;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    detail = bytes.subarray(start).toString("utf8");
  }
  const message = error instanceof Error ? error.message : "Windows cleanup handoff failed";
  return new Error(`${message}: ${detail}`, { cause: error });
}

export async function uninstallWindows(options = {}) {
  const environment = options.environment ?? process.env;
  const selectedInstallRoot = options.installRoot ?? installRoot;
  const systemRoot = environment.SystemRoot;
  if (systemRoot === undefined || systemRoot === "") throw new Error("SystemRoot is required for standalone removal");
  const powershell = options.powershell
    ?? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await access(powershell);
  const token = randomBytes(32).toString("hex");
  const tombstone = `${selectedInstallRoot}.uninstalling-${process.pid}-${token}`;
  if (await exists(tombstone)) throw new Error(`Standalone uninstall tombstone already exists: ${tombstone}`);
  const tokenPath = join(selectedInstallRoot, `.standalone-uninstall-${token}`);
  const recordPath = `${selectedInstallRoot}.uninstall.json`;
  if (await exists(recordPath)) throw new Error(`Standalone uninstall transaction already exists: ${recordPath}`);
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const cleanupPath = join(
    options.temporaryDirectory ?? tmpdir(),
    `rigyn-uninstall-${process.pid}-${token}.ps1`,
  );
  const readyPath = `${cleanupPath}.ready`;
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminateProcessTree = options.terminateProcessTree ?? terminateLifecycleProcessTree;
  const startupTimeoutMs = options.startupTimeoutMs ?? WINDOWS_BROKER_STARTUP_TIMEOUT_MS;
  const reaperTimeoutMs = options.reaperTimeoutMs ?? 5_000;
  const workerBootstrap = [
    "& $env:RIGYN_UNINSTALL_SCRIPT",
    "-Root $env:RIGYN_UNINSTALL_ROOT",
    "-Tombstone $env:RIGYN_UNINSTALL_TOMBSTONE",
    "-TokenPath $env:RIGYN_UNINSTALL_TOKEN_PATH",
    "-ExpectedToken $env:RIGYN_UNINSTALL_TOKEN",
    "-RecordPath $env:RIGYN_UNINSTALL_RECORD",
    "-ExpectedTokenSha256 $env:RIGYN_UNINSTALL_TOKEN_SHA256",
    "-ReadyPath $env:RIGYN_UNINSTALL_READY",
    "-LockPath $env:RIGYN_UNINSTALL_LOCK_PATH",
    "-ExpectedLockToken $env:RIGYN_UNINSTALL_LOCK_TOKEN",
  ].join(" ");
  const brokerBootstrap = String.raw`
$ErrorActionPreference = "Stop"
$worker = $null
$handoffComplete = $false
try {
  $workerArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + $env:RIGYN_UNINSTALL_WORKER
  $worker = Start-Process -FilePath $env:RIGYN_UNINSTALL_POWERSHELL -ArgumentList $workerArguments -WorkingDirectory $env:SystemRoot -WindowStyle Hidden -PassThru
  $workerStartupTimeoutMs = [int]$env:RIGYN_UNINSTALL_WORKER_STARTUP_TIMEOUT_MS
  $deadline = [DateTime]::UtcNow.AddMilliseconds($workerStartupTimeoutMs)
  while (-not (Test-Path -LiteralPath $env:RIGYN_UNINSTALL_READY) -or
      [IO.File]::ReadAllText($env:RIGYN_UNINSTALL_READY) -cne "ready") {
    if ($worker.HasExited) {
      throw "Windows cleanup worker exited before startup with code $($worker.ExitCode)"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Windows cleanup worker did not start within $workerStartupTimeoutMs ms"
    }
    Start-Sleep -Milliseconds 25
  }
  $handoffComplete = $true
} finally {
  if ($null -ne $worker) {
    try {
      if (-not $handoffComplete -and -not $worker.HasExited) {
        $worker.Kill()
        $worker.WaitForExit()
      }
    } finally {
      $worker.Dispose()
    }
  }
  if (-not $handoffComplete) {
    Remove-Item -LiteralPath $env:RIGYN_UNINSTALL_READY -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $env:RIGYN_UNINSTALL_SCRIPT -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $env:RIGYN_UNINSTALL_TOKEN_PATH -Force -ErrorAction SilentlyContinue
  }
}
`;
  let child;
  let exitPromise;
  let brokerSpawned = false;
  let brokerExitCode;
  let brokerDiagnostic = Buffer.alloc(0);
  let handoffAccepted = false;
  try {
    await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFileAtomically(recordPath, `${JSON.stringify({
      product: PRODUCT,
      schemaVersion: 1,
      distribution: "standalone",
      phase: "prepared",
      installRoot: resolve(selectedInstallRoot),
      tombstone: resolve(tombstone),
      tokenFile: basename(tokenPath),
      tokenSha256,
    })}\n`, 0o600);
    await writeFile(cleanupPath, windowsCleanupScript(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(readyPath, "pending", { encoding: "utf8", mode: 0o600, flag: "wx" });
    child = spawnProcess(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(brokerBootstrap, "utf16le").toString("base64"),
    ], {
      env: {
        ...environment,
        RIGYN_UNINSTALL_READY: readyPath,
        RIGYN_UNINSTALL_ROOT: selectedInstallRoot,
        RIGYN_UNINSTALL_SCRIPT: cleanupPath,
        RIGYN_UNINSTALL_TOKEN: token,
        RIGYN_UNINSTALL_TOKEN_PATH: tokenPath,
        RIGYN_UNINSTALL_TOMBSTONE: tombstone,
        RIGYN_UNINSTALL_POWERSHELL: powershell,
        RIGYN_UNINSTALL_RECORD: recordPath,
        RIGYN_UNINSTALL_TOKEN_SHA256: tokenSha256,
        RIGYN_UNINSTALL_WORKER_STARTUP_TIMEOUT_MS: String(WINDOWS_WORKER_STARTUP_TIMEOUT_MS),
        RIGYN_UNINSTALL_WORKER: Buffer.from(workerBootstrap, "utf16le").toString("base64"),
        RIGYN_UNINSTALL_LOCK_PATH: options.lifecycleLock?.path ?? "",
        RIGYN_UNINSTALL_LOCK_TOKEN: options.lifecycleLock?.token ?? "",
      },
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.on("data", (chunk) => {
      brokerDiagnostic = appendWindowsBrokerDiagnostic(brokerDiagnostic, chunk);
    });
    // Unlike "exit", "close" waits for the redirected diagnostic stream to drain.
    exitPromise = once(child, "close");
    void exitPromise.catch(() => undefined);
    await once(child, "spawn");
    brokerSpawned = true;
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Windows cleanup helper did not start within ${startupTimeoutMs} ms`));
      }, startupTimeoutMs);
    });
    try {
      [brokerExitCode] = await Promise.race([exitPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
    handoffAccepted = await readFile(readyPath, "utf8").then(
      (value) => value === "ready",
      () => false,
    );
    if (!handoffAccepted) {
      throw new Error(`Windows cleanup helper exited before startup with code ${brokerExitCode}`);
    }
  } catch (error) {
    const cleanupErrors = [];
    if (brokerSpawned && child?.pid !== undefined && brokerExitCode === undefined) {
      let terminated = false;
      try {
        terminated = terminateProcessTree(child.pid, "SIGKILL", {
          environment,
          kill: (_target, signal) => child.kill(signal),
        });
      } catch (terminationError) {
        cleanupErrors.push(terminationError);
      }
      if (!terminated) {
        cleanupErrors.push(new Error(`Could not terminate Windows cleanup helper process tree ${child.pid}`));
      } else {
        try {
          await waitForWindowsBrokerExit(exitPromise, reaperTimeoutMs);
        } catch (reaperError) {
          cleanupErrors.push(reaperError);
        }
      }
    }
    handoffAccepted ||= await readFile(readyPath, "utf8").then(
      (value) => value === "ready",
      () => false,
    );
    try {
      const cleanup = [
        rm(readyPath, { force: true }),
        rm(cleanupPath, { force: true }),
      ];
      if (!handoffAccepted) cleanup.push(
        rm(tokenPath, { force: true }),
        rm(recordPath, { force: true }),
      );
      await Promise.all(cleanup);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const reportedError = windowsBrokerFailure(
      error,
      brokerDiagnostic,
      [token, options.lifecycleLock?.token],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [reportedError, ...cleanupErrors],
        "Windows cleanup handoff failed and its temporary resources could not be fully reaped",
      );
    }
    throw reportedError;
  }
  await rm(readyPath, { force: true });
  writeFileSync(1, `Scheduled full removal of the standalone rigyn installation at ${selectedInstallRoot}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (!process.argv.slice(2).includes("--yes")) {
    throw new Error(`Refusing to remove ${installRoot} without --yes`);
  }
  const lifecycleLock = await acquireLifecycleLock(installRoot);
  let lockTransferred = false;
  let purgeCredentials;
  try {
    await validateInstallation();
    await assertNoOtherActiveRuntimes(installRoot, {
      schemaVersion: 2,
      installationId: standaloneInstallationId(installRoot),
    });
    await purgeManagedToolOutput({ installRoot });
    purgeCredentials = await prepareManagedCredentialPurge(installRoot);
    if (process.platform === "win32") {
      await withCredentialPurgeDisposal(purgeCredentials, async () => {
        await uninstallWindows({ lifecycleLock });
        lockTransferred = true;
      });
    } else {
      await uninstallPosix({ purgeCredentials });
    }
  } finally {
    if (!lockTransferred) await lifecycleLock.release();
  }
}
