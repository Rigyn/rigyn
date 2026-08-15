import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { getProjectSettingsPath, TrustStore } from "../config/index.js";
import type { ResourceDiagnostic } from "../core/diagnostics.js";
import { errorMessage } from "../core/errors.js";
import { listLocalObservabilityFiles } from "../core/local-observability.js";
import { resolveObservabilityLevel } from "../core/observability.js";
import {
  DefaultPackageManager,
  type DeclaredResourceMetadata,
  type PackageDiagnostic,
  type ResolvedResource,
  type ResolvedPaths,
} from "../core/package-manager.js";
import { SettingsManager } from "../core/settings-manager.js";
import { loadSkills } from "../core/skills.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { bundledAuthoringResources } from "../prompts/resources.js";
import { canonicalizePath } from "../utils/paths.js";
import { RIGYN_VERSION } from "../version.js";
import { discoverProjectTrustResources } from "./project-trust.js";
import { flagString, type ManagementArguments as ParsedArguments } from "./management-args.js";
import { agentPaths, expandPath } from "./paths.js";

const DIAGNOSTIC_TEXT_BYTES = 4 * 1024;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const TRUNCATION_MARKER = "...";
const DIAGNOSTIC_RECORDS = 256;
const MAX_SETTINGS_BYTES = 256 * 1024;

export interface DiagnosticBundleOptions {
  workspace?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => Date;
}

interface PathSummary {
  path: string;
  kind: "missing" | "file" | "directory" | "symlink" | "other" | "unreadable";
  sizeBytes?: number;
  mode?: string;
  ownerOnly?: boolean;
  error?: string;
}

interface ConfigSummary {
  status: "absent" | "ignored" | "valid" | "invalid";
  keys: string[];
  error?: string;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  kind: "rigyn-diagnostics";
  createdAt: string;
  privacy: {
    credentialsRead: false;
    sessionContentRead: false;
    configurationValuesIncluded: false;
    resourceBodiesIncluded: false;
    operationalLogContentRead: false;
  };
  runtime: {
    version: string;
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  workspace: {
    path: "<workspace>";
    trusted: boolean;
    detectedProjectResources: string[];
  };
  paths: Record<string, PathSummary>;
  configuration: {
    global: ConfigSummary;
    project: ConfigSummary;
    appliedSources: string[];
  };
  observability: {
    level: "off" | "error" | "info" | "debug";
    directory: string;
    fileCount: number;
    totalBytes: number;
    partial: boolean;
    newestModifiedAt?: string;
  };
  resources: {
    extensions: Array<{
      id: string;
      version?: string;
      scope: string;
      status: string;
      sourcePath: string;
      contributions: Record<string, number>;
    }>;
    extensionDiagnostics: Array<{ severity: string; code: string; path: string; message: string }>;
    skills: Array<{ name: string; scope: string; trusted: boolean; manifestPath: string }>;
    skillDiagnostics: Array<{ severity: string; code: string; path: string; message: string }>;
  };
  timingsMs: Record<string, number>;
  errors: Array<{ section: string; message: string }>;
}

function isWithin(root: string, path: string): boolean {
  const selected = relative(root, path);
  return selected === "" || (selected !== ".." && !selected.startsWith(`..${sep}`));
}

function bounded(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= DIAGNOSTIC_TEXT_BYTES) return value;
  let end = DIAGNOSTIC_TEXT_BYTES - TRUNCATION_MARKER.length;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${TRUNCATION_MARKER}`;
}

function retainedDiagnosticPrefix(value: string): string {
  // Keep enough input past the output boundary to contain one registered
  // secret at the default redactor's maximum size before redaction.
  let end = Math.min(value.length, DIAGNOSTIC_TEXT_BYTES + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < value.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end -= 1;
  return value.slice(0, end);
}

export function sanitizeDiagnosticText(value: string, workspace: string, homeDirectory = homedir()): string {
  let selected = defaultSecretRedactor.redact(retainedDiagnosticPrefix(value));
  selected = selected.replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@");
  selected = selected.replace(/([?&](?:access_?token|api_?key|code|password|secret|token)=)[^&\s]+/giu, "$1[redacted]");
  selected = selected.replace(/\b(?:bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted]");
  selected = selected.replace(/\b(?:sk|sk-proj|gh[pousr])[-_][A-Za-z0-9_-]{12,}/giu, "[redacted]");
  const candidates = [
    { root: workspace, replacement: "<workspace>" },
    { root: homeDirectory, replacement: "~" },
  ].sort((left, right) => right.root.length - left.root.length);
  for (const candidate of candidates) {
    if (candidate.root === "") continue;
    const replaced = selected.replaceAll(candidate.root, candidate.replacement);
    if (replaced !== selected) {
      selected = replaced;
      continue;
    }
    if (isWithin(candidate.root, selected)) {
      const local = relative(candidate.root, selected);
      selected = local === "" ? candidate.replacement : join(candidate.replacement, local);
    }
  }
  return bounded(selected);
}

/** @internal Convert thrown values without invoking their reflection hooks. */
export function safeError(error: unknown, workspace: string, homeDirectory: string): string {
  return sanitizeDiagnosticText(errorMessage(error), workspace, homeDirectory);
}

const RESOURCE_DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = {
  PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED: "Plugin manifest contains an ignored field",
  PORTABLE_PLUGIN_MANIFEST_INVALID: "Plugin manifest is invalid",
  PORTABLE_PLUGIN_NAMESPACE_INVALID: "Plugin resource namespace is invalid",
  PORTABLE_PLUGIN_SKILLS_INVALID: "Plugin skill directory is invalid",
  PORTABLE_PLUGIN_SKILL_INVALID: "Plugin skill manifest is invalid",
  PORTABLE_PLUGIN_SKILL_PATH_ESCAPE: "Plugin skill path resolves outside the plugin root",
  SKILL_COLLISION: "Multiple discovered skills use the same name",
  SKILL_RUNTIME_ERROR: "Skill discovery reported an error",
  SKILL_RUNTIME_WARNING: "Skill discovery reported a warning",
};

function resourceDiagnosticMessage(
  code: string,
  resource: "extension" | "skill",
  severity: "error" | "warning",
): string {
  return RESOURCE_DIAGNOSTIC_MESSAGES[code]
    ?? `${resource === "extension" ? "Extension resource discovery" : "Skill discovery"} reported ${severity === "error" ? "an error" : "a warning"}`;
}

async function inspectPath(path: string, workspace: string, homeDirectory: string): Promise<PathSummary> {
  const shown = sanitizeDiagnosticText(path, workspace, homeDirectory);
  try {
    const information = await lstat(path);
    const kind = information.isSymbolicLink()
      ? "symlink"
      : information.isFile()
        ? "file"
        : information.isDirectory()
          ? "directory"
          : "other";
    return {
      path: shown,
      kind,
      sizeBytes: information.size,
      ...(process.platform === "win32"
        ? {}
        : {
            mode: (information.mode & 0o777).toString(8).padStart(3, "0"),
            ownerOnly: (information.mode & 0o077) === 0,
          }),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path: shown, kind: "missing" };
    return { path: shown, kind: "unreadable", error: safeError(error, workspace, homeDirectory) };
  }
}

async function settingsSummary(
  path: string,
  workspace: string,
  homeDirectory: string,
  enabled: boolean,
): Promise<ConfigSummary> {
  if (!enabled) return { status: "ignored", keys: [] };
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    let contents: string;
    try {
      const information = await handle.stat();
      if (!information.isFile() || information.size > MAX_SETTINGS_BYTES) {
        throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= MAX_SETTINGS_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SETTINGS_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_SETTINGS_BYTES) throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      contents = Buffer.concat(chunks, total).toString("utf8");
    } finally {
      await handle.close();
    }
    let value: unknown;
    try { value = JSON.parse(contents) as unknown; }
    catch { return { status: "invalid", keys: [], error: "Settings file is not valid JSON" }; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { status: "invalid", keys: [], error: "Settings file does not match the supported schema" };
    }
    try { SettingsManager.inMemory(value as never, { projectTrusted: false }); }
    catch { return { status: "invalid", keys: [], error: "Settings file does not match the supported schema" }; }
    return {
      status: "valid",
      keys: Object.keys(value).sort((left, right) => left.localeCompare(right)),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "absent", keys: [] };
    }
    return { status: "invalid", keys: [], error: safeError(error, workspace, homeDirectory) };
  }
}

function skillDiagnostic(
  value: ResourceDiagnostic,
  workspace: string,
  homeDirectory: string,
): { severity: string; code: string; path: string; message: string } {
  const severity = value.type === "error" ? "error" : "warning";
  const code = value.code ?? (value.type === "collision"
    ? "SKILL_COLLISION"
    : value.type === "error" ? "SKILL_RUNTIME_ERROR" : "SKILL_RUNTIME_WARNING");
  return {
    severity,
    code,
    path: sanitizeDiagnosticText(value.path ?? "", workspace, homeDirectory),
    message: resourceDiagnosticMessage(code, "skill", severity),
  };
}

function contributionCount(
  resources: readonly ResolvedResource[],
  source: string,
  kind?: DeclaredResourceMetadata["kind"],
): number {
  let count = 0;
  for (const resource of resources) {
    if (!resource.enabled || resource.metadata.source !== source) continue;
    if (kind === undefined) {
      count += 1;
      continue;
    }
    const declared = resource.metadata.declaredResources;
    if (declared === undefined || declared.length === 0) {
      if (kind !== "command") count += 1;
      continue;
    }
    const disabled = new Set(resource.metadata.disabledDeclaredResources ?? []);
    count += declared.filter((entry) =>
      entry.kind === kind && !disabled.has(`${entry.kind}:${entry.name}`)).length;
  }
  return count;
}

export async function createDiagnosticBundle(options: DiagnosticBundleOptions = {}): Promise<DiagnosticBundle> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const workspace = await realpath(resolve(options.workspace ?? process.cwd()));
  const paths = agentPaths(environment);
  const timingsMs: Record<string, number> = {};
  const errors: DiagnosticBundle["errors"] = [];
  const timed = async <T>(section: string, operation: () => Promise<T>, fallback: T): Promise<T> => {
    const started = performance.now();
    try {
      return await operation();
    } catch (error) {
      errors.push({ section, message: safeError(error, workspace, homeDirectory) });
      return fallback;
    } finally {
      timingsMs[section] = Number((performance.now() - started).toFixed(3));
    }
  };

  const requestedTrust = await timed(
    "trust",
    async () => await new TrustStore(paths.trustStore).isTrusted(workspace),
    false,
  );
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: requestedTrust });
  const trusted = settings.isProjectTrusted();
  const detectedProjectResources = await timed(
    "projectResources",
    async () => await discoverProjectTrustResources(workspace, homeDirectory, paths.agentDirectory),
    [],
  );
  const selectedPaths = {
    settings: paths.settings,
    trustStore: paths.trustStore,
    auth: paths.auth,
    sessions: paths.sessions,
    modelCatalog: paths.modelCatalog,
    userExtensions: paths.userExtensions,
    userSkills: paths.userSkills,
    logs: paths.logs,
    diagnostics: paths.diagnostics,
    crash: paths.crash,
  };
  const pathEntries = await timed(
    "paths",
    async () => await Promise.all(Object.entries(selectedPaths).map(async ([name, path]) => [
      name,
      await inspectPath(path, workspace, homeDirectory),
    ] as const)),
    [],
  );

  const global = await settingsSummary(paths.settings, workspace, homeDirectory, true);
  const projectPath = getProjectSettingsPath(workspace);
  const project = await settingsSummary(projectPath, workspace, homeDirectory, trusted);
  await timed("settings", async () => {
    try { await settings.refresh(); }
    catch { throw new Error("Settings could not be loaded; see configuration status"); }
  }, undefined);
  const appliedSources = [
    ...(global.status === "valid" ? ["global"] : []),
    ...(project.status === "valid" ? ["project"] : []),
  ];
  const localLogs = await timed(
    "observability",
    async () => await listLocalObservabilityFiles(paths.logs),
    { directory: paths.logs, files: [], totalBytes: 0, partial: true },
  );
  const observabilityLevel = await timed(
    "observabilityLevel",
    async () => resolveObservabilityLevel(settings.getObservabilityLevel(), environment),
    settings.getObservabilityLevel(),
  );

  let packageDiagnostics: PackageDiagnostic[] = [];
  const resolvedResources = await timed("extensions", async () => {
    const manager = new DefaultPackageManager({
      cwd: workspace,
      agentDir: paths.agentDirectory,
      settingsManager: settings,
      homeDirectory,
    });
    const resolved = await manager.resolve();
    packageDiagnostics = manager.getDiagnostics();
    return resolved;
  }, undefined as ResolvedPaths | undefined);
  const extensions = (resolvedResources?.extensions ?? []).slice(0, DIAGNOSTIC_RECORDS).map((entry) => ({
    id: sanitizeDiagnosticText(
		entry.metadata.extensionId ?? (entry.metadata.origin === "package"
		&& entry.metadata.baseDir !== undefined
		&& resolve(dirname(entry.metadata.baseDir)) === resolve(paths.userExtensions)
        ? basename(entry.metadata.baseDir)
			: entry.metadata.source),
      workspace,
      homeDirectory,
    ),
    scope: entry.metadata.scope,
    status: entry.enabled ? "active" : "disabled",
    sourcePath: sanitizeDiagnosticText(entry.path, workspace, homeDirectory),
    contributions: {
      skillRoots: contributionCount(resolvedResources?.skills ?? [], entry.metadata.source),
      prompts: contributionCount(resolvedResources?.prompts ?? [], entry.metadata.source, "prompt"),
      commands: contributionCount(resolvedResources?.prompts ?? [], entry.metadata.source, "command"),
      themes: contributionCount(resolvedResources?.themes ?? [], entry.metadata.source, "theme"),
      runtime: entry.enabled ? 1 : 0,
    },
  }));
  const extensionDiagnostics = packageDiagnostics.slice(0, DIAGNOSTIC_RECORDS).map((entry) => ({
    severity: entry.severity,
    code: entry.code,
    path: sanitizeDiagnosticText(entry.path, workspace, homeDirectory),
    message: resourceDiagnosticMessage(entry.code, "extension", entry.severity),
  }));

  const skillPaths = [
    ...(resolvedResources?.skills ?? []).filter((entry) => entry.enabled).map((entry) => entry.path),
    bundledAuthoringResources().skillRoot,
  ];
  const discoveredSkills = await timed(
    "skills",
    async () => loadSkills({
      cwd: workspace,
      agentDir: paths.agentDirectory,
      skillPaths,
      includeDefaults: false,
      strictSkillRoots: new Map((resolvedResources?.skills ?? []).flatMap((entry) =>
        entry.metadata.skillValidation === undefined
          ? []
          : [[canonicalizePath(entry.path), entry.metadata.skillValidation.root] as const]
      )),
    }),
    { skills: [], diagnostics: [] },
  );

  return {
    schemaVersion: 1,
    kind: "rigyn-diagnostics",
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    privacy: {
      credentialsRead: false,
      sessionContentRead: false,
      configurationValuesIncluded: false,
      resourceBodiesIncluded: false,
      operationalLogContentRead: false,
    },
    runtime: {
      version: RIGYN_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    workspace: { path: "<workspace>", trusted, detectedProjectResources },
    paths: Object.fromEntries(pathEntries),
    configuration: {
      global,
      project,
      appliedSources,
    },
    observability: {
      level: observabilityLevel,
      directory: sanitizeDiagnosticText(localLogs.directory, workspace, homeDirectory),
      fileCount: localLogs.files.length,
      totalBytes: localLogs.totalBytes,
      partial: localLogs.partial,
      ...(localLogs.files.at(-1)?.modifiedAt === undefined
        ? {}
        : { newestModifiedAt: localLogs.files.at(-1)!.modifiedAt }),
    },
    resources: {
      extensions,
      extensionDiagnostics,
      skills: discoveredSkills.skills.slice(0, DIAGNOSTIC_RECORDS).map((entry) => ({
        name: sanitizeDiagnosticText(entry.name, workspace, homeDirectory),
        scope: entry.sourceInfo.scope === "user" ? "user" : "workspace",
        trusted: entry.sourceInfo.scope !== "project" || trusted,
        manifestPath: sanitizeDiagnosticText(entry.filePath, workspace, homeDirectory),
      })),
      skillDiagnostics: discoveredSkills.diagnostics
        .slice(0, DIAGNOSTIC_RECORDS)
        .map((entry) => skillDiagnostic(entry, workspace, homeDirectory)),
    },
    timingsMs,
    errors,
  };
}

export async function runDiagnosticsCommand(argumentsValue: ParsedArguments): Promise<void> {
  if (argumentsValue.positionals.length > 1) throw new Error("diagnostics accepts at most one output file");
  const requestedWorkspace = flagString(argumentsValue, "workspace");
  const workspace = await realpath(resolve(requestedWorkspace ?? process.cwd()));
  const bundle = await createDiagnosticBundle({ workspace });
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const requestedOutput = argumentsValue.positionals[0];
  if (requestedOutput === undefined) {
    writeMachineOutput(serialized);
    return;
  }
  const outputPath = expandPath(requestedOutput, workspace);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const handle = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  writeMachineOutput(`Wrote redacted diagnostic bundle to ${outputPath}\n`);
}
