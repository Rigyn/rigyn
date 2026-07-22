import { lstatSync, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { TrustStore } from "../config/trust.js";
import { FileSettingsStorage, SettingsManager, type SettingsScope } from "../core/settings-manager.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { editTextExternally } from "../tui/external-editor.js";
import { agentPaths } from "./paths.js";
import {
  flagBoolean,
  flagString,
  type ManagementArguments,
} from "./management-args.js";

const MAX_SETTINGS_BYTES = 256 * 1024;

interface ProjectTrustReader {
  isTrusted(workspace: string): Promise<boolean>;
}

export interface SettingsConfigCommandOptions {
  projectTrustResolver?: ProjectTrustReader;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  edit?: typeof editTextExternally;
  write?: (value: string) => void;
}

interface SettingsFileSnapshot {
  contents: string;
  device: number;
  inode: number;
}

function settingsScope(argumentsValue: ManagementArguments): "user" | "project" {
  const explicit = flagString(argumentsValue, "scope");
  const local = flagBoolean(argumentsValue, "local");
  if (explicit !== undefined && local) throw new Error("--scope and -l are mutually exclusive");
  const value = explicit ?? (local ? "project" : "user");
  if (value !== "user" && value !== "project") throw new Error("--scope must be user or project");
  return value;
}

function regularSettingsFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function sameFile(stats: Stats, snapshot: Pick<SettingsFileSnapshot, "device" | "inode">): boolean {
  return stats.dev === snapshot.device && stats.ino === snapshot.inode;
}

function unsafeSettingsPath(path: string): Error {
  return new Error(`Settings path must be a regular file and cannot be a symbolic link: ${path}`);
}

async function verifySettingsDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  let stats: Stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Settings directory must be a directory and cannot be a symbolic link: ${directory}`);
  }
}

async function optionalFile(path: string): Promise<SettingsFileSnapshot | undefined> {
  await verifySettingsDirectory(path);
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!regularSettingsFile(before)) throw unsafeSettingsPath(path);
  if (before.size > MAX_SETTINGS_BYTES) {
    throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(opened, { device: before.dev, inode: before.ino })) {
      throw new Error("Settings changed while it was being opened; retry the edit");
    }
    if (opened.size > MAX_SETTINGS_BYTES) {
      throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    const contents = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, length, contents.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    const after = await lstat(path);
    if (after.size > MAX_SETTINGS_BYTES) throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    if (!regularSettingsFile(after) || !sameFile(after, { device: before.dev, inode: before.ino })) {
      throw new Error("Settings changed while it was being read; retry the edit");
    }
    return { contents: contents.subarray(0, length).toString("utf8"), device: before.dev, inode: before.ino };
  } finally {
    await handle.close();
  }
}

function normalizedSettings(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`Settings must contain valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Settings must contain a JSON object");
  }
  const normalized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(normalized, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error(`Normalized settings exceed ${MAX_SETTINGS_BYTES} bytes`);
  }
  return normalized;
}

function verifyLockedFile(path: string, snapshot: SettingsFileSnapshot | undefined): void {
  let current: Stats | undefined;
  try {
    current = lstatSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (current !== undefined && !regularSettingsFile(current)) throw unsafeSettingsPath(path);
  if (snapshot === undefined ? current !== undefined : current === undefined || !sameFile(current, snapshot)) {
    throw new Error("Settings changed while the external editor was open; no changes were written");
  }
}

export async function runSettingsConfigCommand(
  argumentsValue: ManagementArguments,
  options: SettingsConfigCommandOptions = {},
): Promise<boolean> {
  const action = argumentsValue.positionals[0];
  if (action !== "path" && action !== "edit") return false;
  if (argumentsValue.positionals.length !== 1) throw new Error(`config ${action} does not accept positional arguments`);

  const environment = options.environment ?? process.env;
  const paths = agentPaths(environment);
  const workspace = await realpath(resolve(flagString(argumentsValue, "workspace") ?? options.cwd ?? process.cwd()));
  const scope = settingsScope(argumentsValue);
  const path = scope === "user" ? paths.settings : join(workspace, ".rigyn", "settings.json");
  const write = options.write ?? ((value: string) => { writeMachineOutput(value); });
  const json = flagBoolean(argumentsValue, "json");

  if (action === "path") {
    write(json ? `${JSON.stringify({ scope, path })}\n` : `${path}\n`);
    return true;
  }
  if (json) throw new Error("--json is valid for config path only");

  if (scope === "project") {
    const approve = flagBoolean(argumentsValue, "approve");
    const deny = flagBoolean(argumentsValue, "no-approve");
    const trusted = approve || (!deny && (
      options.projectTrustResolver === undefined
        ? await new TrustStore(paths.trustStore).isTrusted(workspace)
        : await options.projectTrustResolver.isTrusted(workspace)
    ));
    if (!trusted) throw new Error("Project settings can be edited only after the workspace is trusted");
  }

  const snapshot = await optionalFile(path);
  const original = snapshot?.contents;
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: scope === "project" });
  const edit = options.edit ?? editTextExternally;
  const updated = await edit(original ?? "{}\n", {
    environment,
    cwd: workspace,
    command: settings.getExternalEditorCommand(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const normalized = normalizedSettings(updated);
  const storage = new FileSettingsStorage(workspace, paths.agentDirectory);
  const storageScope: SettingsScope = scope === "user" ? "global" : "project";
  storage.withLock(storageScope, (current) => {
    verifyLockedFile(path, snapshot);
    if (current !== original) throw new Error("Settings changed while the external editor was open; no changes were written");
    return normalized;
  });
  const written = await lstat(path);
  if (!regularSettingsFile(written)) throw unsafeSettingsPath(path);
  const writtenHandle = await open(path, "r");
  try {
    const opened = await writtenHandle.stat();
    if (!opened.isFile() || !sameFile(opened, { device: written.dev, inode: written.ino })) {
      throw new Error("Settings changed while permissions were being secured");
    }
    await writtenHandle.chmod(0o600);
    const secured = await lstat(path);
    if (!regularSettingsFile(secured) || !sameFile(secured, { device: opened.dev, inode: opened.ino })) {
      throw new Error("Settings changed while permissions were being secured");
    }
  } finally {
    await writtenHandle.close();
  }
  write(`Updated ${path}\n`);
  return true;
}
