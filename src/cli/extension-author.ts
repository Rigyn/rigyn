import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXTENSION_PACKAGE_PROVENANCE,
  LocalExtensionPackageManager,
  discoverExtensions,
  loadRuntimeExtensions,
  parseExtensionManifest,
  type ExtensionMetadata,
  type ExtensionRuntimeEntry,
  type RuntimeExtensionHost,
} from "../extensions/index.js";
import { parseExtensionGalleryIndex, type ExtensionGalleryIndex } from "../extensions/gallery.js";
import { runProcess, resolveExecutable } from "../process/runner.js";
import { sha256 } from "../tools/hash.js";

const MAX_FILES = 4096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export interface ExtensionAuthorFile {
  path: string;
  size: number;
  sha256?: string;
}

export interface ExtensionAuthorValidation {
  package: {
    id: string;
    name: string;
    version?: string;
    description?: string;
    hostVersionRange?: string;
    enabled: boolean;
    contributions: ExtensionMetadata["contributions"];
  };
  compatibility: "compatible";
  integrity: { status: "verified" | "not-declared"; declaredFiles: number };
  diagnostics: [];
}

export interface ExtensionAuthorPackedInspection {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: ExtensionAuthorFile[];
}

export interface ExtensionAuthorSmokeResult {
  packageId: string;
  runtimeEntries: number;
  toolCount: number;
  commandCount: number;
  providerCount: number;
  disposed: true;
}

export interface ExtensionAuthorReloadResult extends ExtensionAuthorSmokeResult {
  reloaded: true;
  warnings: string[];
}

export interface ExtensionAuthorCheck {
  name: "validate" | "inspect" | "smoke" | "reload";
  status: "success" | "error";
  summary: string;
  detail?: unknown;
}

export interface ExtensionAuthorReport {
  status: "success" | "error";
  summary: string;
  nextActions: string[];
  artifacts: string[];
  checks: ExtensionAuthorCheck[];
}

interface NpmPackRecord {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string; size: number }>;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function inside(root: string, target: string): boolean {
  const selected = relative(root, target);
  return selected === "" || (!selected.startsWith(`..${sep}`) && selected !== ".." && !isAbsolute(selected));
}

async function localPackageDirectory(source: string): Promise<string> {
  const selected = resolve(source);
  const information = await lstat(selected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Extension author commands require a real local package directory");
  }
  return await realpath(selected);
}

async function withManagedPackage<T>(source: string, operation: (input: {
  root: string;
  metadata: ExtensionMetadata;
  runtimeEntries: ExtensionRuntimeEntry[];
}) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "rigyn-author-"));
  const managed = join(temporary, "managed");
  const manager = new LocalExtensionPackageManager({ user: managed });
  try {
    const installed = await manager.install(source);
    const catalog = await discoverExtensions(manager.sources(false));
    const metadata = catalog.list().find((entry) => entry.id === installed.id);
    if (metadata === undefined || (metadata.status !== "active" && metadata.status !== "disabled") || !catalog.doctor().healthy) {
      const diagnostic = catalog.doctor().diagnostics.find((entry) => entry.extensionId === installed.id);
      throw new Error(diagnostic?.message ?? `Package ${installed.id} did not pass extension validation`);
    }
    return await operation({
      root: installed.packageRoot,
      metadata,
      runtimeEntries: catalog.bundle().runtime.filter((entry) => entry.extensionId === installed.id),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withStagedPackage<T>(source: string, operation: (input: {
  root: string;
  metadata: ExtensionMetadata;
  runtimeEntries: ExtensionRuntimeEntry[];
}) => Promise<T>): Promise<T> {
  return await withManagedPackage(await localPackageDirectory(source), operation);
}

export async function validateExtensionPackage(source: string): Promise<ExtensionAuthorValidation> {
  return await withStagedPackage(source, async ({ root, metadata }) => {
    const manifest = parseExtensionManifest(JSON.parse(await readFile(join(root, "extension.json"), "utf8")) as unknown);
    return {
      package: {
        id: metadata.id,
        name: metadata.name,
        ...(metadata.version === undefined ? {} : { version: metadata.version }),
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
        ...(metadata.hostVersionRange === undefined ? {} : { hostVersionRange: metadata.hostVersionRange }),
        enabled: metadata.status === "active",
        contributions: { ...metadata.contributions },
      },
      compatibility: "compatible",
      integrity: {
        status: manifest.integrity.size === 0 ? "not-declared" : "verified",
        declaredFiles: manifest.integrity.size,
      },
      diagnostics: [],
    };
  });
}

async function inspectFiles(root: string): Promise<ExtensionAuthorFile[]> {
  const files: ExtensionAuthorFile[] = [];
  let totalBytes = 0;
  const visit = async (relativePath: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Package file inspection exceeded 64 directory levels");
    const directory = await opendir(relativePath === "" ? root : join(root, ...relativePath.split("/")));
    try {
      const entries = [] as Array<{ name: string; directory: boolean; file: boolean }>;
      for await (const entry of directory) entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const child = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        if (child === EXTENSION_PACKAGE_PROVENANCE || child === "node_modules" || child.startsWith("node_modules/")) continue;
        const absolute = join(root, ...child.split("/"));
        const information = await lstat(absolute);
        if (information.isSymbolicLink()) throw new Error(`Package file is a symbolic link: ${child}`);
        if (entry.directory && information.isDirectory()) await visit(child, depth + 1);
        else if (entry.file && information.isFile()) {
          if (information.size > MAX_FILE_BYTES) throw new Error(`Package file exceeds ${MAX_FILE_BYTES} bytes: ${child}`);
          totalBytes += information.size;
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Package files exceed ${MAX_TOTAL_BYTES} bytes`);
          const bytes = await readFile(absolute);
          files.push({ path: child, size: bytes.length, sha256: sha256(bytes) });
          if (files.length > MAX_FILES) throw new Error(`Package contains more than ${MAX_FILES} files`);
        } else throw new Error(`Package path is not a regular file or directory: ${child}`);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };
  await visit("", 0);
  return files;
}

async function hasPackageJson(root: string): Promise<boolean> {
  try {
    return (await lstat(join(root, "package.json"))).isFile();
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

function npmEnvironment(home: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    LANG: "C",
    LC_ALL: "C",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_package_lock: "false",
    npm_config_update_notifier: "false",
    npm_config_progress: "false",
    npm_config_loglevel: "warn",
    npm_config_userconfig: join(home, "npmrc"),
    npm_config_globalconfig: join(home, "npmrc-global"),
    npm_config_cache: join(home, "npm-cache"),
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "TMPDIR", "TMP", "TEMP"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function npmArgv(): Promise<[string, ...string[]]> {
  if (process.platform === "win32") {
    const npmCli = process.env.npm_execpath;
    if (npmCli === undefined || npmCli === "" || !(await stat(npmCli)).isFile()) {
      throw new Error("npm pack requires npm_execpath on Windows");
    }
    return [process.execPath, npmCli];
  }
  const executable = await resolveExecutable("npm");
  if (executable === undefined) throw new Error("npm pack requires npm on PATH");
  return [executable];
}

function validPackPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value === "." || value === ".." || value.startsWith("../") || value.includes("/../")) {
    throw new Error(`${label} escapes the archive`);
  }
  return value;
}

function parseNpmPackOutput(value: Buffer): NpmPackRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch (error) {
    throw new Error("npm pack returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== "object") {
    throw new Error("npm pack returned an unexpected result");
  }
  const input = parsed[0] as Record<string, unknown>;
  if (typeof input.name !== "string" || typeof input.version !== "string" || typeof input.filename !== "string") {
    throw new Error("npm pack omitted package identity");
  }
  if (
    !Number.isSafeInteger(input.size) || (input.size as number) < 0 || (input.size as number) > MAX_TOTAL_BYTES ||
    !Number.isSafeInteger(input.unpackedSize) || (input.unpackedSize as number) < 0 || (input.unpackedSize as number) > MAX_TOTAL_BYTES ||
    !Array.isArray(input.files)
  ) {
    throw new Error("npm pack omitted bounded file metadata");
  }
  const files = input.files.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`npm pack files[${index}] is invalid`);
    const file = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > MAX_FILE_BYTES) {
      throw new Error(`npm pack files[${index}].size is invalid`);
    }
    return { path: validPackPath(file.path, `npm pack files[${index}].path`), size: file.size as number };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (files.length > MAX_FILES) throw new Error(`npm pack selected more than ${MAX_FILES} files`);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) throw new Error(`npm pack files exceed ${MAX_TOTAL_BYTES} bytes`);
  return {
    name: input.name,
    version: input.version,
    filename: validPackPath(input.filename, "npm pack filename"),
    size: input.size as number,
    unpackedSize: input.unpackedSize as number,
    files,
  };
}

async function runNpmPack(sourceRoot: string, destination: string, dryRun: boolean): Promise<NpmPackRecord> {
  if (!(await hasPackageJson(sourceRoot))) throw new Error("npm pack inspection requires a package.json");
  const home = await mkdtemp(join(tmpdir(), "rigyn-npm-pack-"));
  try {
    await writeFile(join(home, "npmrc"), "", { mode: 0o600, flag: "wx" });
    await writeFile(join(home, "npmrc-global"), "", { mode: 0o600, flag: "wx" });
    const argv = await npmArgv();
    const result = await runProcess({
      argv: [argv[0], ...argv.slice(1), "pack", "--json", "--ignore-scripts=true", "--pack-destination", destination, ...(dryRun ? ["--dry-run"] : []), "."],
      cwd: sourceRoot,
      env: npmEnvironment(home),
      inheritEnv: false,
      timeoutMs: COMMAND_TIMEOUT_MS,
      outputLimitBytes: MAX_COMMAND_OUTPUT,
    }, new AbortController().signal);
    if (result.timedOut) throw new Error(`npm pack timed out after ${COMMAND_TIMEOUT_MS}ms`);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?").trim().slice(-4096);
      throw new Error(`npm pack failed with exit ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`);
    }
    return parseNpmPackOutput(result.stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function inspectExtensionPackage(source: string): Promise<{
  validation: ExtensionAuthorValidation;
  fileSet: "npm-pack" | "managed-source";
  files: ExtensionAuthorFile[];
  packed?: Omit<ExtensionAuthorPackedInspection, "files">;
}> {
  const sourceRoot = await localPackageDirectory(source);
  const validation = await validateExtensionPackage(sourceRoot);
  if (await hasPackageJson(sourceRoot)) {
    const temporary = await mkdtemp(join(tmpdir(), "rigyn-pack-dry-run-"));
    try {
      const packed = await runNpmPack(sourceRoot, temporary, true);
      return {
        validation,
        fileSet: "npm-pack",
        files: packed.files,
        packed: {
          name: packed.name,
          version: packed.version,
          filename: packed.filename,
          size: packed.size,
          unpackedSize: packed.unpackedSize,
        },
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return await withStagedPackage(sourceRoot, async ({ root }) => ({
    validation,
    fileSet: "managed-source" as const,
    files: await inspectFiles(root),
  }));
}

export async function packExtensionPackage(source: string, destination: string): Promise<{
  artifact: string;
  sha256: string;
  packed: ExtensionAuthorPackedInspection;
}> {
  const sourceRoot = await localPackageDirectory(source);
  await validateExtensionPackage(sourceRoot);
  const destinationRoot = resolve(destination);
  await mkdir(destinationRoot, { recursive: true });
  const canonicalDestination = await realpath(destinationRoot);
  const packed = await runNpmPack(sourceRoot, canonicalDestination, false);
  const artifact = await realpath(join(canonicalDestination, packed.filename));
  if (!inside(canonicalDestination, artifact)) throw new Error("npm pack artifact escaped the destination");
  const information = await stat(artifact);
  if (!information.isFile() || information.size > MAX_TOTAL_BYTES) throw new Error("npm pack artifact is missing or too large");
  const bytes = await readFile(artifact);
  await withManagedPackage(`npm:${pathToFileURL(artifact).href}`, async () => undefined);
  return { artifact, sha256: sha256(bytes), packed: { ...packed, files: packed.files } };
}

function runtimeCounts(host: RuntimeExtensionHost, runtimeEntries: readonly ExtensionRuntimeEntry[]): Omit<ExtensionAuthorSmokeResult, "packageId" | "disposed"> {
  return {
    runtimeEntries: runtimeEntries.length,
    toolCount: host.tools().length,
    commandCount: host.commands().length,
    providerCount: host.providers().length,
  };
}

function assertRuntimeDiagnostics(host: RuntimeExtensionHost): void {
  const diagnostics = host.diagnostics();
  if (diagnostics.length > 0) throw new Error(`Runtime activation reported: ${diagnostics.map((entry) => entry.message).join("; ")}`);
}

export async function smokeExtensionPackage(source: string): Promise<ExtensionAuthorSmokeResult> {
  const sourceRoot = await localPackageDirectory(source);
  return await withStagedPackage(sourceRoot, async ({ metadata, runtimeEntries }) => {
    if (metadata.status !== "active") throw new Error(`Package ${metadata.id} is disabled and cannot be smoke tested`);
    const host = await loadRuntimeExtensions(runtimeEntries, { workspace: sourceRoot });
    const counts = runtimeCounts(host, runtimeEntries);
    try {
      assertRuntimeDiagnostics(host);
    } finally {
      await host.close();
    }
    return { packageId: metadata.id, ...counts, disposed: true };
  });
}

export async function reloadExtensionPackage(source: string): Promise<ExtensionAuthorReloadResult> {
  const sourceRoot = await localPackageDirectory(source);
  return await withStagedPackage(sourceRoot, async ({ metadata, runtimeEntries }) => {
    if (metadata.status !== "active") throw new Error(`Package ${metadata.id} is disabled and cannot be reload tested`);
    const active = await loadRuntimeExtensions(runtimeEntries, { workspace: sourceRoot });
    let candidate: RuntimeExtensionHost | undefined;
    try {
      assertRuntimeDiagnostics(active);
      candidate = await loadRuntimeExtensions(runtimeEntries, { workspace: sourceRoot });
      assertRuntimeDiagnostics(candidate);
      const counts = runtimeCounts(candidate, runtimeEntries);
      await active.close();
      return { packageId: metadata.id, ...counts, disposed: true, reloaded: true, warnings: [] };
    } finally {
      await active.close().catch(() => undefined);
      await candidate?.close().catch(() => undefined);
    }
  });
}

async function check(name: ExtensionAuthorCheck["name"], operation: () => Promise<unknown>): Promise<ExtensionAuthorCheck> {
  try {
    const detail = await operation();
    return { name, status: "success", summary: `${name} passed`, detail };
  } catch (error) {
    return { name, status: "error", summary: error instanceof Error ? error.message : String(error) };
  }
}

export async function reportExtensionPackage(source: string): Promise<ExtensionAuthorReport> {
  const checks: ExtensionAuthorCheck[] = [];
  checks.push(await check("validate", async () => await validateExtensionPackage(source)));
  checks.push(await check("inspect", async () => await inspectExtensionPackage(source)));
  checks.push(await check("smoke", async () => await smokeExtensionPackage(source)));
  checks.push(await check("reload", async () => await reloadExtensionPackage(source)));
  const failed = checks.filter((entry) => entry.status === "error");
  return failed.length === 0
    ? {
        status: "success",
        summary: "Extension package passed validation, packed-file inspection, activation/disposal, and reload checks.",
        nextActions: ["Review the exact archive, then publish an immutable version and gallery record."],
        artifacts: [],
        checks,
      }
    : {
        status: "error",
        summary: `${failed.length} extension author check${failed.length === 1 ? "" : "s"} failed.`,
        nextActions: failed.map((entry) => `Fix ${entry.name}: ${entry.summary}`),
        artifacts: [],
        checks,
      };
}

export async function loadExtensionGalleryIndex(path: string): Promise<ExtensionGalleryIndex> {
  const selected = resolve(path);
  const information = await lstat(selected);
  if (!information.isFile() || information.isSymbolicLink() || information.size > 4 * 1024 * 1024) {
    throw new Error("Gallery index must be a real JSON file no larger than 4 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(selected, "utf8"));
  } catch (error) {
    throw new Error("Gallery index is not valid JSON", { cause: error });
  }
  return parseExtensionGalleryIndex(value);
}
