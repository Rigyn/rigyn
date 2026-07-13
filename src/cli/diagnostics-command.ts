import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { parseHarnessConfig, resolveConfig, TrustStore, type HarnessConfig } from "../config/index.js";
import { discoverSkillsDetailed, type SkillDiagnostic, type SkillRoot } from "../context/skills.js";
import { sharedUserSkillRoots, sharedWorkspaceSkillRoots } from "../context/skill-roots.js";
import { discoverExtensions, LocalExtensionPackageManager, type ExtensionDiagnostic } from "../extensions/index.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { limitText } from "../tools/output.js";
import { RIGYN_VERSION } from "../version.js";
import { discoverProjectTrustResources } from "./project-trust.js";
import { flagString, type ParsedArguments } from "./args.js";
import { expandPath, harnessPaths } from "./paths.js";

const DIAGNOSTIC_TEXT_BYTES = 4 * 1024;
const DIAGNOSTIC_RECORDS = 256;

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
  resources: {
    extensions: Array<{
      id: string;
      version?: string;
      scope: string;
      status: string;
      manifestPath: string;
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
  return limitText(value, DIAGNOSTIC_TEXT_BYTES).text;
}

export function sanitizeDiagnosticText(value: string, workspace: string, homeDirectory = homedir()): string {
  let selected = defaultSecretRedactor.redact(value);
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
    if (isWithin(candidate.root, selected)) {
      const local = relative(candidate.root, selected);
      selected = local === "" ? candidate.replacement : join(candidate.replacement, local);
      break;
    }
    selected = selected.replaceAll(candidate.root, candidate.replacement);
  }
  return bounded(selected);
}

function safeError(error: unknown, workspace: string, homeDirectory: string): string {
  return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), workspace, homeDirectory);
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

function configSummary(
  path: string,
  workspace: string,
  homeDirectory: string,
  enabled: boolean,
): { summary: ConfigSummary; config?: HarnessConfig } {
  if (!enabled) return { summary: { status: "ignored", keys: [] } };
  try {
    const resolved = resolveConfig({ globalPath: path, projectTrusted: false });
    if (resolved.appliedSources.length === 0) return { summary: { status: "absent", keys: [] } };
    const keys = Object.keys(resolved.value).sort((left, right) => left.localeCompare(right));
    return { summary: { status: "valid", keys }, config: parseHarnessConfig(resolved.value) };
  } catch (error) {
    return {
      summary: { status: "invalid", keys: [], error: safeError(error, workspace, homeDirectory) },
    };
  }
}

function extensionDiagnostic(
  value: ExtensionDiagnostic,
  workspace: string,
  homeDirectory: string,
): { severity: string; code: string; path: string; message: string } {
  return {
    severity: value.severity,
    code: bounded(value.code),
    path: sanitizeDiagnosticText(value.path, workspace, homeDirectory),
    message: safeError(value.message, workspace, homeDirectory),
  };
}

function skillDiagnostic(
  value: SkillDiagnostic,
  workspace: string,
  homeDirectory: string,
): { severity: string; code: string; path: string; message: string } {
  return {
    severity: value.severity,
    code: value.code,
    path: sanitizeDiagnosticText(value.path, workspace, homeDirectory),
    message: safeError(value.message, workspace, homeDirectory),
  };
}

export async function createDiagnosticBundle(options: DiagnosticBundleOptions = {}): Promise<DiagnosticBundle> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const workspace = await realpath(resolve(options.workspace ?? process.cwd()));
  const paths = harnessPaths(environment);
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

  const trusted = await timed(
    "trust",
    async () => await new TrustStore(paths.trustStore).isTrusted(workspace),
    false,
  );
  const detectedProjectResources = await timed(
    "projectResources",
    async () => await discoverProjectTrustResources(workspace),
    [],
  );
  const selectedPaths = {
    globalConfig: paths.globalConfig,
    trustStore: paths.trustStore,
    credentialStore: paths.credentialStore,
    credentialKey: paths.credentialKey,
    sessionDatabase: paths.database,
    modelCatalog: paths.modelCatalog,
    userExtensions: paths.userExtensions,
    userSkills: paths.userSkills,
  };
  const pathEntries = await timed(
    "paths",
    async () => await Promise.all(Object.entries(selectedPaths).map(async ([name, path]) => [
      name,
      await inspectPath(path, workspace, homeDirectory),
    ] as const)),
    [],
  );

  const global = configSummary(paths.globalConfig, workspace, homeDirectory, true);
  const projectPath = join(workspace, ".rigyn", "config.jsonc");
  const project = configSummary(projectPath, workspace, homeDirectory, trusted);
  const merged = await timed("configuration", async () => {
    const result = resolveConfig({
      globalPath: paths.globalConfig,
      projectPath,
      projectTrusted: trusted,
    });
    return { config: parseHarnessConfig(result.value), sources: result.appliedSources };
  }, { config: global.config ?? parseHarnessConfig({}), sources: [] as Array<"global" | "project" | "cli"> });

  const catalog = await timed("extensions", async () => {
    const manager = new LocalExtensionPackageManager({
      user: paths.userExtensions,
      project: join(workspace, ".rigyn", "extensions"),
    });
    return await discoverExtensions(manager.sources(trusted));
  }, undefined);
  const extensions = (catalog?.list() ?? []).slice(0, DIAGNOSTIC_RECORDS).map((entry) => ({
    id: bounded(entry.id),
    ...(entry.version === undefined ? {} : { version: bounded(entry.version) }),
    scope: entry.scope,
    status: entry.status,
    manifestPath: sanitizeDiagnosticText(entry.manifestPath, workspace, homeDirectory),
    contributions: { ...entry.contributions },
  }));
  const extensionDiagnostics = (catalog?.doctor().diagnostics ?? [])
    .slice(0, DIAGNOSTIC_RECORDS)
    .map((entry) => extensionDiagnostic(entry, workspace, homeDirectory));

  const skillRoots: SkillRoot[] = [
    { path: paths.userSkills, scope: "user", trusted: true },
    ...sharedUserSkillRoots(homeDirectory),
    ...(catalog?.bundle().skillRoots ?? []),
    ...(trusted ? [{ path: join(workspace, ".rigyn", "skills"), scope: "workspace" as const, trusted: true }] : []),
    ...sharedWorkspaceSkillRoots(workspace, trusted),
    ...merged.config.skillRoots.map((path) => ({
      path: expandPath(path, workspace),
      scope: "workspace" as const,
      trusted,
    })),
  ];
  const discoveredSkills = await timed(
    "skills",
    async () => await discoverSkillsDetailed(skillRoots),
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
      global: global.summary,
      project: project.summary,
      appliedSources: merged.sources,
    },
    resources: {
      extensions,
      extensionDiagnostics,
      skills: discoveredSkills.skills.slice(0, DIAGNOSTIC_RECORDS).map((entry) => ({
        name: bounded(entry.name),
        scope: entry.scope,
        trusted: entry.trusted,
        manifestPath: sanitizeDiagnosticText(entry.manifestPath, workspace, homeDirectory),
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
