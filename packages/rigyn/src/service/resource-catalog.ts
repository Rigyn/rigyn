import { Buffer } from "node:buffer";

import type { ModelInfo } from "../core/types.js";
import type { JsonValue } from "../core/json.js";
import type { SkillMetadata } from "../context/skills.js";
import type {
  ExtensionCatalog,
} from "../extensions/catalog.js";
import type { HarnessTool, ToolExecutionMode } from "../tools/types.js";
import { INTERACTIVE_COMMANDS, type InteractiveActivePolicy } from "../interactive/commands.js";

export const HARNESS_RESOURCE_CATALOG_SCHEMA_VERSION = 1 as const;

export const HARNESS_RESOURCE_CATALOG_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxTools: 256,
  maxCommands: 512,
  maxPrompts: 512,
  maxSkills: 512,
  maxThemes: 256,
  maxProviders: 128,
  maxModels: 2_048,
  maxPackages: 256,
  maxExtensions: 256,
  maxDiagnostics: 512,
  maxToolSchemaBytes: 16 * 1024,
  maxTextBytes: 4 * 1024,
  sectionBytes: Object.freeze({
    tools: 768 * 1024,
    commands: 256 * 1024,
    prompts: 384 * 1024,
    skills: 384 * 1024,
    themes: 128 * 1024,
    providers: 1024 * 1024,
    packages: 256 * 1024,
    extensions: 384 * 1024,
    diagnostics: 256 * 1024,
  }),
});

export type HarnessResourceOwner =
  | { kind: "builtin" }
  | { kind: "extension"; extensionId: string }
  | { kind: "host" };

export interface HarnessResourceTool {
  name: string;
  description: string;
  executionMode: ToolExecutionMode;
  owner: HarnessResourceOwner;
  inputSchema?: Record<string, JsonValue>;
  inputSchemaOmitted?: true;
}

export interface HarnessResourceBuiltinCommand {
  name: string;
  aliasFor?: string;
  syntax: string;
  activePolicy: InteractiveActivePolicy;
  hidden: boolean;
}

export interface HarnessResourceRuntimeCommand {
  name: string;
  baseName: string;
  extensionId: string;
  scope: "builtin" | "user" | "project" | "invocation";
  trusted: boolean;
  description?: string;
  argumentHint?: string;
}

export interface HarnessResourceTemplateCommand {
  name: string;
  extensionId: string;
  description?: string;
  argumentHint?: string;
  sha256: string;
}

export interface HarnessResourcePrompt {
  id: string;
  extensionId: string;
  description?: string;
  argumentHint?: string;
  sha256: string;
}

export interface HarnessResourceSkill {
  name: string;
  description: string;
  scope: "user" | "workspace";
  trusted: boolean;
  disableModelInvocation: boolean;
  metadataTruncated: boolean;
}

export interface HarnessResourceTheme {
  name: string;
  extensionId: string;
  description?: string;
  base: "dark" | "light";
  sha256: string;
}

export interface HarnessResourceModel {
  id: string;
  displayName?: string;
  description?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  capabilities: ModelInfo["capabilities"];
}

export interface HarnessResourceProvider {
  id: string;
  modelCount: number;
  modelsOmitted: number;
  models: HarnessResourceModel[];
}

export type HarnessResourcePackageProvenance = {
  kind: "local" | "npm" | "git";
  installedAt: string;
  updatedAt?: string;
  manifestSha256: string;
  packageName?: string;
  resolvedVersion?: string;
  archiveSha256?: string;
  revision?: string;
};

export interface HarnessResourcePackage {
  id: string;
  name: string;
  version?: string;
  description?: string;
  scope: "user" | "project" | "invocation";
  trusted: boolean;
  enabled: boolean;
  manifestModified: boolean;
  provenance: HarnessResourcePackageProvenance;
  project?: {
    source: ProjectPackageDeclarationSource;
    disabledResources: string[];
    resolved: ProjectPackageResolvedSource;
  };
}

type ProjectPackageDeclarationSource =
  | { kind: "npm"; package: string; selector: string }
  | { kind: "git"; repository: string; ref?: string }
  | { kind: "local"; path: string };

type ProjectPackageResolvedSource =
  | { kind: "npm"; source: string; packageName: string; resolvedVersion: string; archiveSha256: string; manifestSha256: string; contentSha256: string; dependencyLockSha256?: string; dependencyContentSha256?: string }
  | { kind: "git"; source: string; revision: string; manifestSha256: string; contentSha256: string; dependencyLockSha256?: string; dependencyContentSha256?: string }
  | { kind: "local"; path: string; manifestSha256: string; contentSha256: string; dependencyLockSha256?: string; dependencyContentSha256?: string };

interface ProjectPackageCatalogEntry {
  id: string;
  source: ProjectPackageDeclarationSource;
  disabledResources: string[];
  resolved: ProjectPackageResolvedSource;
}

type ExtensionPackageProvenance = {
  schemaVersion: 1;
  id: string;
  scope: "user" | "project";
  installedAt: string;
  updatedAt?: string;
  manifestSha256: string;
} & (
  | { kind: "local"; sourcePath: string }
  | { kind: "npm"; source: string; packageName: string; resolvedVersion: string; archiveSha256: string }
  | { kind: "git"; source: string; revision: string }
);

interface InstalledExtensionPackage {
  id: string;
  name: string;
  version?: string;
  description?: string;
  scope: "user" | "project";
  packageRoot: string;
  manifestPath: string;
  manifestModified: boolean;
  provenance: ExtensionPackageProvenance;
}

export interface HarnessResourceExtension {
  id: string;
  name: string;
  version?: string;
  description?: string;
  hostVersionRange?: string;
  scope: "builtin" | "user" | "project" | "invocation";
  trusted: boolean;
  enabled: boolean;
  status: "active" | "blocked" | "disabled" | "invalid" | "shadowed";
  precedence: number;
  manifestSha256?: string;
  contributions: {
    skillRoots: number;
    prompts: number;
    commands: number;
    themes: number;
    runtime: number;
  };
}

export interface HarnessResourceDiagnostic {
  source: "extension" | "runtime" | "package";
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  extensionId?: string;
}

export interface HarnessResourceCatalog {
  schemaVersion: typeof HARNESS_RESOURCE_CATALOG_SCHEMA_VERSION;
  tools: HarnessResourceTool[];
  commands: {
    builtins: HarnessResourceBuiltinCommand[];
    runtimeExtensions: HarnessResourceRuntimeCommand[];
    extensionTemplates: HarnessResourceTemplateCommand[];
  };
  prompts: HarnessResourcePrompt[];
  skills: HarnessResourceSkill[];
  themes: HarnessResourceTheme[];
  providers: HarnessResourceProvider[];
  packages: HarnessResourcePackage[];
  extensions: HarnessResourceExtension[];
  diagnostics: HarnessResourceDiagnostic[];
  bounds: {
    truncated: boolean;
    omitted: {
      tools: number;
      commands: number;
      prompts: number;
      skills: number;
      themes: number;
      providers: number;
      models: number;
      packages: number;
      extensions: number;
      diagnostics: number;
    };
  };
}

export interface HarnessResourceCatalogSources {
  tools: readonly HarnessTool[];
  toolOwner(tool: HarnessTool): HarnessResourceOwner;
  skills: readonly SkillMetadata[];
  providers: readonly { id: string; models: readonly ModelInfo[] }[];
  runtimeCommands?: readonly {
    extensionId: string;
    name: string;
    baseName: string;
    scope: "builtin" | "user" | "project" | "invocation";
    trusted: boolean;
    description?: string;
    argumentHint?: string;
  }[];
  runtimeDiagnostics?: readonly { extensionId: string; message: string }[];
  extensions?: Pick<ExtensionCatalog, "list" | "bundle" | "doctor">;
  packages?: readonly (Omit<InstalledExtensionPackage, "scope"> & {
    scope: InstalledExtensionPackage["scope"] | "invocation";
  })[];
  projectPackages?: readonly ProjectPackageCatalogEntry[];
  packageDiagnostics?: readonly string[];
}

type Omitted = HarnessResourceCatalog["bounds"]["omitted"];

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedText(value: string, maximum = HARNESS_RESOURCE_CATALOG_LIMITS.maxTextBytes): string {
  const normalized = value.replaceAll("\0", "�");
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.byteLength <= maximum) return normalized;
  return bytes.subarray(0, maximum).toString("utf8").replace(/�$/u, "");
}

function optionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedText(value);
}

function sorted<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...values].sort(compare);
}

function takeBounded<T>(
  values: readonly T[],
  countLimit: number,
  byteLimit: number,
): { values: T[]; omitted: number } {
  const selected: T[] = [];
  let bytes = 2;
  for (const value of values) {
    if (selected.length >= countLimit) break;
    const next = byteLength(value) + (selected.length === 0 ? 0 : 1);
    if (bytes + next > byteLimit) break;
    selected.push(value);
    bytes += next;
  }
  return { values: selected, omitted: values.length - selected.length };
}

function toolSchema(tool: HarnessTool): Pick<HarnessResourceTool, "inputSchema" | "inputSchemaOmitted"> {
  try {
    const cloned = structuredClone(tool.definition.inputSchema);
    if (byteLength(cloned) > HARNESS_RESOURCE_CATALOG_LIMITS.maxToolSchemaBytes) return { inputSchemaOmitted: true };
    return { inputSchema: cloned };
  } catch {
    return { inputSchemaOmitted: true };
  }
}

function packageProvenance(value: Pick<InstalledExtensionPackage, "provenance">): HarnessResourcePackageProvenance {
  const common = {
    kind: value.provenance.kind,
    installedAt: value.provenance.installedAt,
    ...(value.provenance.updatedAt === undefined ? {} : { updatedAt: value.provenance.updatedAt }),
    manifestSha256: value.provenance.manifestSha256,
  };
  if (value.provenance.kind === "npm") return {
    ...common,
    packageName: value.provenance.packageName,
    resolvedVersion: value.provenance.resolvedVersion,
    archiveSha256: value.provenance.archiveSha256,
  };
  if (value.provenance.kind === "git") return { ...common, revision: value.provenance.revision };
  return common;
}

export function buildHarnessResourceCatalog(sources: HarnessResourceCatalogSources): HarnessResourceCatalog {
  const omitted: Omitted = {
    tools: 0,
    commands: 0,
    prompts: 0,
    skills: 0,
    themes: 0,
    providers: 0,
    models: 0,
    packages: 0,
    extensions: 0,
    diagnostics: 0,
  };
  const extensionCatalog = sources.extensions;
  const bundle = extensionCatalog?.bundle();
  const extensions = extensionCatalog?.list() ?? [];
  const knownExtensionIds = new Set(extensions.map((entry) => entry.id));
  const activeTrustedExtensionIds = new Set(extensions.flatMap((entry) =>
    entry.status === "active" && entry.trusted ? [entry.id] : []));
  const contributionAllowed = (extensionId: string): boolean =>
    !knownExtensionIds.has(extensionId) || activeTrustedExtensionIds.has(extensionId);
  const statusByPackage = new Map<string, (typeof extensions)[number]>();
  for (const entry of extensions) {
    const key = `${entry.scope}\0${entry.id}`;
    const current = statusByPackage.get(key);
    if (current === undefined || (current.status !== "active" && entry.status === "active")) statusByPackage.set(key, entry);
  }
  const declaredProjectPackages = new Map((sources.projectPackages ?? []).map((entry) => [entry.id, entry]));

  const toolCandidates = sorted(sources.tools, (left, right) => left.definition.name.localeCompare(right.definition.name)).flatMap((tool) => {
    const owner = sources.toolOwner(tool);
    if (owner.kind === "extension" && !contributionAllowed(owner.extensionId)) return [];
    return [{
      name: boundedText(tool.definition.name),
      description: boundedText(tool.definition.description),
      executionMode: tool.executionMode ?? "parallel",
      owner,
      ...toolSchema(tool),
    } satisfies HarnessResourceTool];
  });
  const tools = takeBounded(
    toolCandidates,
    HARNESS_RESOURCE_CATALOG_LIMITS.maxTools,
    HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.tools,
  );
  omitted.tools = tools.omitted;

  const builtins = INTERACTIVE_COMMANDS.map(({ palette: _palette, help: _help, ...command }) => ({ ...command }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const runtimeCommands = sorted(sources.runtimeCommands ?? [], (left, right) =>
    left.name.localeCompare(right.name) || left.extensionId.localeCompare(right.extensionId)).filter((command) =>
    command.trusted && contributionAllowed(command.extensionId)).map((command) => {
    const description = optionalText(command.description);
    const argumentHint = optionalText(command.argumentHint);
    return {
      name: boundedText(command.name),
      baseName: boundedText(command.baseName),
      extensionId: boundedText(command.extensionId),
      scope: command.scope,
      trusted: true,
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
    };
  });
  const templateCommands = sorted(bundle?.commands ?? [], (left, right) =>
    left.name.localeCompare(right.name) || left.extensionId.localeCompare(right.extensionId)).filter((command) =>
    contributionAllowed(command.extensionId)).map((command) => ({
    name: command.name,
    extensionId: command.extensionId,
    ...(command.description === undefined ? {} : { description: boundedText(command.description) }),
    ...(command.argumentHint === undefined ? {} : { argumentHint: boundedText(command.argumentHint) }),
    sha256: command.sha256,
  }));
  const commandCandidates = [
    ...builtins.map((value) => ({ kind: "builtin" as const, value })),
    ...runtimeCommands.map((value) => ({ kind: "runtime" as const, value })),
    ...templateCommands.map((value) => ({ kind: "template" as const, value })),
  ];
  const commands = takeBounded(
    commandCandidates,
    HARNESS_RESOURCE_CATALOG_LIMITS.maxCommands,
    HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.commands,
  );
  omitted.commands = commands.omitted;

  const promptCandidates = sorted(bundle?.prompts ?? [], (left, right) =>
    left.id.localeCompare(right.id) || left.extensionId.localeCompare(right.extensionId)).filter((prompt) =>
    contributionAllowed(prompt.extensionId)).map((prompt) => ({
    id: prompt.id,
    extensionId: prompt.extensionId,
    ...(prompt.description === undefined ? {} : { description: boundedText(prompt.description) }),
    ...(prompt.argumentHint === undefined ? {} : { argumentHint: boundedText(prompt.argumentHint) }),
    sha256: prompt.sha256,
  }));
  const prompts = takeBounded(promptCandidates, HARNESS_RESOURCE_CATALOG_LIMITS.maxPrompts, HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.prompts);
  omitted.prompts = prompts.omitted;

  const skillCandidates = sorted(sources.skills, (left, right) =>
    left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope)).map((skill) => ({
    name: skill.name,
    description: boundedText(skill.description),
    scope: skill.scope,
    trusted: skill.trusted,
    disableModelInvocation: skill.disableModelInvocation,
    metadataTruncated: skill.metadataTruncated,
  }));
  const skills = takeBounded(skillCandidates, HARNESS_RESOURCE_CATALOG_LIMITS.maxSkills, HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.skills);
  omitted.skills = skills.omitted;

  const themeCandidates = sorted(bundle?.themes ?? [], (left, right) =>
    left.name.localeCompare(right.name) || left.extensionId.localeCompare(right.extensionId)).filter((theme) =>
    contributionAllowed(theme.extensionId)).map((theme) => ({
    name: theme.name,
    extensionId: theme.extensionId,
    ...(theme.description === undefined ? {} : { description: boundedText(theme.description) }),
    base: theme.definition.base,
    sha256: theme.sha256,
  }));
  const themes = takeBounded(themeCandidates, HARNESS_RESOURCE_CATALOG_LIMITS.maxThemes, HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.themes);
  omitted.themes = themes.omitted;

  const providerCandidates: HarnessResourceProvider[] = [];
  let remainingModels: number = HARNESS_RESOURCE_CATALOG_LIMITS.maxModels;
  let providerBytes = 2;
  const orderedProviders = sorted(sources.providers, (left, right) => left.id.localeCompare(right.id));
  for (const provider of orderedProviders) {
    if (providerCandidates.length >= HARNESS_RESOURCE_CATALOG_LIMITS.maxProviders) break;
    const models = sorted(provider.models, (left, right) => left.id.localeCompare(right.id));
    const selected: HarnessResourceModel[] = [];
    for (const model of models) {
      if (remainingModels === 0) break;
      const candidate: HarnessResourceModel = {
        id: boundedText(model.id),
        ...(model.displayName === undefined ? {} : { displayName: boundedText(model.displayName) }),
        ...(model.description === undefined ? {} : { description: boundedText(model.description) }),
        ...(model.contextTokens === undefined ? {} : { contextTokens: model.contextTokens }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        capabilities: structuredClone(model.capabilities),
      };
      const projected: HarnessResourceProvider = {
        id: boundedText(provider.id),
        modelCount: models.length,
        modelsOmitted: models.length - selected.length - 1,
        models: [...selected, candidate],
      };
      const projectedBytes = byteLength(projected) + (providerCandidates.length === 0 ? 0 : 1);
      if (providerBytes + projectedBytes > HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.providers) break;
      selected.push(candidate);
      remainingModels -= 1;
    }
    const candidate = {
      id: boundedText(provider.id),
      modelCount: models.length,
      modelsOmitted: models.length - selected.length,
      models: selected,
    };
    const candidateBytes = byteLength(candidate) + (providerCandidates.length === 0 ? 0 : 1);
    if (providerBytes + candidateBytes > HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.providers) break;
    providerCandidates.push(candidate);
    providerBytes += candidateBytes;
    omitted.models += models.length - selected.length;
  }
  omitted.providers = orderedProviders.length - providerCandidates.length;
  for (const provider of orderedProviders.slice(providerCandidates.length)) omitted.models += provider.models.length;

  const packageCandidates = sorted(sources.packages ?? [], (left, right) =>
    left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id)).map((entry) => {
    const metadata = statusByPackage.get(`${entry.scope}\0${entry.id}`);
    const project = entry.scope === "project" ? declaredProjectPackages.get(entry.id) : undefined;
    return {
      id: entry.id,
      name: entry.name,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      ...(entry.description === undefined ? {} : { description: boundedText(entry.description) }),
      scope: entry.scope,
      trusted: entry.scope === "user" || entry.scope === "invocation" || metadata?.trusted === true,
      enabled: metadata?.status === "active",
      manifestModified: entry.manifestModified,
      provenance: packageProvenance(entry),
      ...(project === undefined ? {} : {
        project: {
          source: { ...project.source },
          disabledResources: [...project.disabledResources],
          resolved: { ...project.resolved },
        },
      }),
    } satisfies HarnessResourcePackage;
  });
  const packages = takeBounded(packageCandidates, HARNESS_RESOURCE_CATALOG_LIMITS.maxPackages, HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.packages);
  omitted.packages = packages.omitted;

  const extensionCandidates = sorted(extensions, (left, right) =>
    left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id) || left.precedence - right.precedence).map((entry) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.description === undefined ? {} : { description: boundedText(entry.description) }),
    ...(entry.hostVersionRange === undefined ? {} : { hostVersionRange: boundedText(entry.hostVersionRange) }),
    scope: entry.scope,
    trusted: entry.trusted,
    enabled: entry.status === "active",
    status: entry.status,
    precedence: entry.precedence,
    ...(entry.manifestSha256 === undefined ? {} : { manifestSha256: entry.manifestSha256 }),
    contributions: { ...entry.contributions },
  }));
  const selectedExtensions = takeBounded(
    extensionCandidates,
    HARNESS_RESOURCE_CATALOG_LIMITS.maxExtensions,
    HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.extensions,
  );
  omitted.extensions = selectedExtensions.omitted;

  const diagnosticCandidates: HarnessResourceDiagnostic[] = [
    ...(extensionCatalog?.doctor().diagnostics ?? []).map((entry) => ({
      source: "extension" as const,
      severity: entry.severity,
      code: boundedText(entry.code),
      message: boundedText(entry.message),
      ...(entry.extensionId === undefined ? {} : { extensionId: boundedText(entry.extensionId) }),
    })),
    ...(sources.runtimeDiagnostics ?? []).map((entry) => ({
      source: "runtime" as const,
      severity: "warning" as const,
      code: "RUNTIME_EXTENSION",
      message: boundedText(entry.message),
      extensionId: boundedText(entry.extensionId),
    })),
    ...(sources.packageDiagnostics ?? []).map((message) => ({
      source: "package" as const,
      severity: "warning" as const,
      code: "PACKAGE_CATALOG",
      message: boundedText(message),
    })),
  ];
  diagnosticCandidates.sort((left, right) =>
    left.source.localeCompare(right.source)
    || (left.extensionId ?? "").localeCompare(right.extensionId ?? "")
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));
  const diagnostics = takeBounded(
    diagnosticCandidates,
    HARNESS_RESOURCE_CATALOG_LIMITS.maxDiagnostics,
    HARNESS_RESOURCE_CATALOG_LIMITS.sectionBytes.diagnostics,
  );
  omitted.diagnostics = diagnostics.omitted;

  const catalog: HarnessResourceCatalog = {
    schemaVersion: HARNESS_RESOURCE_CATALOG_SCHEMA_VERSION,
    tools: tools.values,
    commands: {
      builtins: commands.values.flatMap((entry) => entry.kind === "builtin" ? [entry.value] : []),
      runtimeExtensions: commands.values.flatMap((entry) => entry.kind === "runtime" ? [entry.value] : []),
      extensionTemplates: commands.values.flatMap((entry) => entry.kind === "template" ? [entry.value] : []),
    },
    prompts: prompts.values,
    skills: skills.values,
    themes: themes.values,
    providers: providerCandidates,
    packages: packages.values,
    extensions: selectedExtensions.values,
    diagnostics: diagnostics.values,
    bounds: { truncated: Object.values(omitted).some((value) => value > 0), omitted },
  };
  return parseHarnessResourceCatalog(catalog);
}

function plainJson(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error("Resource catalog exceeds the maximum nesting depth");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Resource catalog contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) plainJson(item, depth + 1);
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Resource catalog must contain callback-free plain JSON values");
  }
  for (const entry of Object.values(value as Record<string, unknown>)) plainJson(entry, depth + 1);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} entries`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > HARNESS_RESOURCE_CATALOG_LIMITS.maxTextBytes) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function optionalStringValue(value: unknown, label: string): void {
  if (value !== undefined) stringValue(value, label);
}

function booleanValue(value: unknown, label: string): void {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function countValue(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function enumValue(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is invalid`);
}

function validateOwner(value: unknown): void {
  const owner = record(value, "Resource catalog tool owner");
  enumValue(owner.kind, ["builtin", "extension", "host"], "Resource catalog tool owner kind");
  exactKeys(owner, owner.kind === "extension" ? ["kind", "extensionId"] : ["kind"], "Resource catalog tool owner");
  if (owner.kind === "extension") stringValue(owner.extensionId, "Resource catalog tool owner extensionId");
}

function validateCapability(value: unknown, label: string): void {
  const capability = record(value, label);
  exactKeys(capability, ["value", "source", "observedAt"], label);
  enumValue(capability.value, ["supported", "unsupported", "unknown"], `${label} value`);
  enumValue(capability.source, ["provider", "configuration", "maintained", "observed"], `${label} source`);
  stringValue(capability.observedAt, `${label} observedAt`);
}

/** Validates and clones a catalog crossing an RPC or extension boundary. */
export function parseHarnessResourceCatalog(value: unknown): HarnessResourceCatalog {
  plainJson(value);
  if (byteLength(value) > HARNESS_RESOURCE_CATALOG_LIMITS.maxBytes) throw new Error("Resource catalog exceeds its byte limit");
  const input = record(value, "Resource catalog");
  exactKeys(input, [
    "schemaVersion", "tools", "commands", "prompts", "skills", "themes", "providers", "packages", "extensions", "diagnostics", "bounds",
  ], "Resource catalog");
  if (input.schemaVersion !== HARNESS_RESOURCE_CATALOG_SCHEMA_VERSION) throw new Error("Resource catalog schema version is unsupported");
  const tools = array(input.tools, "Resource catalog tools", HARNESS_RESOURCE_CATALOG_LIMITS.maxTools);
  for (const value of tools) {
    const tool = record(value, "Resource catalog tool");
    exactKeys(tool, ["name", "description", "executionMode", "owner", "inputSchema", "inputSchemaOmitted"], "Resource catalog tool");
    stringValue(tool.name, "Resource catalog tool name");
    stringValue(tool.description, "Resource catalog tool description");
    enumValue(tool.executionMode, ["parallel", "sequential"], "Resource catalog tool executionMode");
    validateOwner(tool.owner);
    if (tool.inputSchema !== undefined) {
      record(tool.inputSchema, "Resource catalog tool inputSchema");
      if (byteLength(tool.inputSchema) > HARNESS_RESOURCE_CATALOG_LIMITS.maxToolSchemaBytes) {
        throw new Error("Resource catalog tool inputSchema exceeds its byte limit");
      }
    }
    if (tool.inputSchemaOmitted !== undefined && tool.inputSchemaOmitted !== true) throw new Error("Resource catalog tool inputSchemaOmitted must be true");
    if ((tool.inputSchema === undefined) === (tool.inputSchemaOmitted === undefined)) {
      throw new Error("Resource catalog tool must contain inputSchema or inputSchemaOmitted");
    }
  }
  const commands = record(input.commands, "Resource catalog commands");
  exactKeys(commands, ["builtins", "runtimeExtensions", "extensionTemplates"], "Resource catalog commands");
  const builtinCommands = array(commands.builtins, "Resource catalog builtin commands", HARNESS_RESOURCE_CATALOG_LIMITS.maxCommands);
  const runtimeCommands = array(commands.runtimeExtensions, "Resource catalog runtime commands", HARNESS_RESOURCE_CATALOG_LIMITS.maxCommands);
  const templateCommands = array(commands.extensionTemplates, "Resource catalog template commands", HARNESS_RESOURCE_CATALOG_LIMITS.maxCommands);
  const commandCount = builtinCommands.length + runtimeCommands.length + templateCommands.length;
  if (commandCount > HARNESS_RESOURCE_CATALOG_LIMITS.maxCommands) throw new Error("Resource catalog commands exceed their entry limit");
  for (const value of builtinCommands) {
    const command = record(value, "Resource catalog builtin command");
    exactKeys(command, ["name", "aliasFor", "syntax", "activePolicy", "hidden"], "Resource catalog builtin command");
    stringValue(command.name, "Resource catalog builtin command name");
    optionalStringValue(command.aliasFor, "Resource catalog builtin command aliasFor");
    stringValue(command.syntax, "Resource catalog builtin command syntax");
    enumValue(command.activePolicy, ["cancel", "follow_up", "defer"], "Resource catalog builtin command activePolicy");
    booleanValue(command.hidden, "Resource catalog builtin command hidden");
  }
  for (const value of runtimeCommands) {
    const command = record(value, "Resource catalog runtime command");
    exactKeys(command, ["name", "baseName", "extensionId", "scope", "trusted", "description", "argumentHint"], "Resource catalog runtime command");
    stringValue(command.name, "Resource catalog runtime command name");
    stringValue(command.baseName, "Resource catalog runtime command baseName");
    stringValue(command.extensionId, "Resource catalog runtime command extensionId");
    enumValue(command.scope, ["builtin", "user", "project", "invocation"], "Resource catalog runtime command scope");
    booleanValue(command.trusted, "Resource catalog runtime command trusted");
    optionalStringValue(command.description, "Resource catalog runtime command description");
    optionalStringValue(command.argumentHint, "Resource catalog runtime command argumentHint");
  }
  for (const value of templateCommands) {
    const command = record(value, "Resource catalog template command");
    exactKeys(command, ["name", "extensionId", "description", "argumentHint", "sha256"], "Resource catalog template command");
    stringValue(command.name, "Resource catalog template command name");
    stringValue(command.extensionId, "Resource catalog template command extensionId");
    optionalStringValue(command.description, "Resource catalog template command description");
    optionalStringValue(command.argumentHint, "Resource catalog template command argumentHint");
    stringValue(command.sha256, "Resource catalog template command sha256");
  }
  const prompts = array(input.prompts, "Resource catalog prompts", HARNESS_RESOURCE_CATALOG_LIMITS.maxPrompts);
  for (const value of prompts) {
    const prompt = record(value, "Resource catalog prompt");
    exactKeys(prompt, ["id", "extensionId", "description", "argumentHint", "sha256"], "Resource catalog prompt");
    stringValue(prompt.id, "Resource catalog prompt id");
    stringValue(prompt.extensionId, "Resource catalog prompt extensionId");
    optionalStringValue(prompt.description, "Resource catalog prompt description");
    optionalStringValue(prompt.argumentHint, "Resource catalog prompt argumentHint");
    stringValue(prompt.sha256, "Resource catalog prompt sha256");
  }
  const skills = array(input.skills, "Resource catalog skills", HARNESS_RESOURCE_CATALOG_LIMITS.maxSkills);
  for (const value of skills) {
    const skill = record(value, "Resource catalog skill");
    exactKeys(skill, ["name", "description", "scope", "trusted", "disableModelInvocation", "metadataTruncated"], "Resource catalog skill");
    stringValue(skill.name, "Resource catalog skill name");
    stringValue(skill.description, "Resource catalog skill description");
    enumValue(skill.scope, ["user", "workspace"], "Resource catalog skill scope");
    booleanValue(skill.trusted, "Resource catalog skill trusted");
    booleanValue(skill.disableModelInvocation, "Resource catalog skill disableModelInvocation");
    booleanValue(skill.metadataTruncated, "Resource catalog skill metadataTruncated");
  }
  const themes = array(input.themes, "Resource catalog themes", HARNESS_RESOURCE_CATALOG_LIMITS.maxThemes);
  for (const value of themes) {
    const theme = record(value, "Resource catalog theme");
    exactKeys(theme, ["name", "extensionId", "description", "base", "sha256"], "Resource catalog theme");
    stringValue(theme.name, "Resource catalog theme name");
    stringValue(theme.extensionId, "Resource catalog theme extensionId");
    optionalStringValue(theme.description, "Resource catalog theme description");
    enumValue(theme.base, ["dark", "light"], "Resource catalog theme base");
    stringValue(theme.sha256, "Resource catalog theme sha256");
  }
  const providers = array(input.providers, "Resource catalog providers", HARNESS_RESOURCE_CATALOG_LIMITS.maxProviders);
  let modelCount = 0;
  for (const provider of providers) {
    const entry = record(provider, "Resource catalog provider");
    exactKeys(entry, ["id", "modelCount", "modelsOmitted", "models"], "Resource catalog provider");
    stringValue(entry.id, "Resource catalog provider id");
    countValue(entry.modelCount, "Resource catalog provider modelCount");
    countValue(entry.modelsOmitted, "Resource catalog provider modelsOmitted");
    const models = array(entry.models, "Resource catalog provider models", HARNESS_RESOURCE_CATALOG_LIMITS.maxModels);
    if ((entry.modelCount as number) !== models.length + (entry.modelsOmitted as number)) throw new Error("Resource catalog provider model counts are inconsistent");
    modelCount += models.length;
    for (const value of models) {
      const model = record(value, "Resource catalog model");
      exactKeys(model, ["id", "displayName", "description", "contextTokens", "maxOutputTokens", "capabilities"], "Resource catalog model");
      stringValue(model.id, "Resource catalog model id");
      optionalStringValue(model.displayName, "Resource catalog model displayName");
      optionalStringValue(model.description, "Resource catalog model description");
      if (model.contextTokens !== undefined) countValue(model.contextTokens, "Resource catalog model contextTokens");
      if (model.maxOutputTokens !== undefined) countValue(model.maxOutputTokens, "Resource catalog model maxOutputTokens");
      const capabilities = record(model.capabilities, "Resource catalog model capabilities");
      exactKeys(capabilities, ["tools", "reasoning", "images"], "Resource catalog model capabilities");
      validateCapability(capabilities.tools, "Resource catalog model tools capability");
      validateCapability(capabilities.reasoning, "Resource catalog model reasoning capability");
      validateCapability(capabilities.images, "Resource catalog model images capability");
    }
  }
  if (modelCount > HARNESS_RESOURCE_CATALOG_LIMITS.maxModels) throw new Error("Resource catalog models exceed their entry limit");
  const packages = array(input.packages, "Resource catalog packages", HARNESS_RESOURCE_CATALOG_LIMITS.maxPackages);
  for (const value of packages) {
    const entry = record(value, "Resource catalog package");
    exactKeys(entry, ["id", "name", "version", "description", "scope", "trusted", "enabled", "manifestModified", "provenance", "project"], "Resource catalog package");
    stringValue(entry.id, "Resource catalog package id");
    stringValue(entry.name, "Resource catalog package name");
    optionalStringValue(entry.version, "Resource catalog package version");
    optionalStringValue(entry.description, "Resource catalog package description");
    enumValue(entry.scope, ["user", "project", "invocation"], "Resource catalog package scope");
    booleanValue(entry.trusted, "Resource catalog package trusted");
    booleanValue(entry.enabled, "Resource catalog package enabled");
    booleanValue(entry.manifestModified, "Resource catalog package manifestModified");
    const provenance = record(entry.provenance, "Resource catalog package provenance");
    exactKeys(provenance, ["kind", "installedAt", "updatedAt", "manifestSha256", "packageName", "resolvedVersion", "archiveSha256", "revision"], "Resource catalog package provenance");
    enumValue(provenance.kind, ["local", "npm", "git"], "Resource catalog package provenance kind");
    stringValue(provenance.installedAt, "Resource catalog package provenance installedAt");
    optionalStringValue(provenance.updatedAt, "Resource catalog package provenance updatedAt");
    stringValue(provenance.manifestSha256, "Resource catalog package provenance manifestSha256");
    optionalStringValue(provenance.packageName, "Resource catalog package provenance packageName");
    optionalStringValue(provenance.resolvedVersion, "Resource catalog package provenance resolvedVersion");
    optionalStringValue(provenance.archiveSha256, "Resource catalog package provenance archiveSha256");
    optionalStringValue(provenance.revision, "Resource catalog package provenance revision");
    if (entry.project !== undefined) {
      if (entry.scope !== "project") throw new Error("Only project packages may contain declarative project metadata");
      const project = record(entry.project, "Resource catalog project package metadata");
      exactKeys(project, ["source", "disabledResources", "resolved"], "Resource catalog project package metadata");
      const source = record(project.source, "Resource catalog project package source");
      const sourceKind = source.kind;
      enumValue(sourceKind, ["local", "npm", "git"], "Resource catalog project package source kind");
      if (sourceKind === "local") {
        exactKeys(source, ["kind", "path"], "Resource catalog local project package source");
        stringValue(source.path, "Resource catalog local project package source path");
      } else if (sourceKind === "npm") {
        exactKeys(source, ["kind", "package", "selector"], "Resource catalog npm project package source");
        stringValue(source.package, "Resource catalog npm project package name");
        stringValue(source.selector, "Resource catalog npm project package selector");
      } else {
        exactKeys(source, ["kind", "repository", "ref"], "Resource catalog Git project package source");
        stringValue(source.repository, "Resource catalog Git project package repository");
        optionalStringValue(source.ref, "Resource catalog Git project package ref");
      }
      for (const value of array(project.disabledResources, "Resource catalog disabled resources", 512)) {
        stringValue(value, "Resource catalog disabled resource");
      }
      const resolved = record(project.resolved, "Resource catalog resolved project package");
      const resolvedKind = resolved.kind;
      enumValue(resolvedKind, ["local", "npm", "git"], "Resource catalog resolved project package kind");
      const commonResolved = ["kind", "manifestSha256", "contentSha256", "dependencyLockSha256", "dependencyContentSha256"];
      if (resolvedKind === "local") {
        exactKeys(resolved, [...commonResolved, "path"], "Resource catalog resolved local project package");
        stringValue(resolved.path, "Resource catalog resolved local project package path");
      } else if (resolvedKind === "npm") {
        exactKeys(resolved, [...commonResolved, "source", "packageName", "resolvedVersion", "archiveSha256"], "Resource catalog resolved npm project package");
        for (const key of ["source", "packageName", "resolvedVersion", "archiveSha256"] as const) {
          stringValue(resolved[key], `Resource catalog resolved npm project package ${key}`);
        }
      } else {
        exactKeys(resolved, [...commonResolved, "source", "revision"], "Resource catalog resolved Git project package");
        stringValue(resolved.source, "Resource catalog resolved Git project package source");
        stringValue(resolved.revision, "Resource catalog resolved Git project package revision");
      }
      stringValue(resolved.manifestSha256, "Resource catalog resolved project package manifestSha256");
      stringValue(resolved.contentSha256, "Resource catalog resolved project package contentSha256");
      optionalStringValue(resolved.dependencyLockSha256, "Resource catalog resolved project package dependencyLockSha256");
      optionalStringValue(resolved.dependencyContentSha256, "Resource catalog resolved project package dependencyContentSha256");
    }
  }
  const extensions = array(input.extensions, "Resource catalog extensions", HARNESS_RESOURCE_CATALOG_LIMITS.maxExtensions);
  for (const value of extensions) {
    const entry = record(value, "Resource catalog extension");
    exactKeys(entry, ["id", "name", "version", "description", "hostVersionRange", "scope", "trusted", "enabled", "status", "precedence", "manifestSha256", "contributions"], "Resource catalog extension");
    stringValue(entry.id, "Resource catalog extension id");
    stringValue(entry.name, "Resource catalog extension name");
    optionalStringValue(entry.version, "Resource catalog extension version");
    optionalStringValue(entry.description, "Resource catalog extension description");
    optionalStringValue(entry.hostVersionRange, "Resource catalog extension hostVersionRange");
    enumValue(entry.scope, ["builtin", "user", "project", "invocation"], "Resource catalog extension scope");
    booleanValue(entry.trusted, "Resource catalog extension trusted");
    booleanValue(entry.enabled, "Resource catalog extension enabled");
    enumValue(entry.status, ["active", "blocked", "disabled", "invalid", "shadowed"], "Resource catalog extension status");
    if (entry.enabled !== (entry.status === "active")) throw new Error("Resource catalog extension enabled state conflicts with status");
    countValue(entry.precedence, "Resource catalog extension precedence");
    optionalStringValue(entry.manifestSha256, "Resource catalog extension manifestSha256");
    const contributions = record(entry.contributions, "Resource catalog extension contributions");
    exactKeys(contributions, ["skillRoots", "prompts", "commands", "themes", "runtime"], "Resource catalog extension contributions");
    for (const key of ["skillRoots", "prompts", "commands", "themes", "runtime"]) countValue(contributions[key], `Resource catalog extension contributions ${key}`);
  }
  const diagnostics = array(input.diagnostics, "Resource catalog diagnostics", HARNESS_RESOURCE_CATALOG_LIMITS.maxDiagnostics);
  for (const value of diagnostics) {
    const entry = record(value, "Resource catalog diagnostic");
    exactKeys(entry, ["source", "severity", "code", "message", "extensionId"], "Resource catalog diagnostic");
    enumValue(entry.source, ["extension", "runtime", "package"], "Resource catalog diagnostic source");
    enumValue(entry.severity, ["error", "warning", "info"], "Resource catalog diagnostic severity");
    stringValue(entry.code, "Resource catalog diagnostic code");
    stringValue(entry.message, "Resource catalog diagnostic message");
    optionalStringValue(entry.extensionId, "Resource catalog diagnostic extensionId");
  }
  const bounds = record(input.bounds, "Resource catalog bounds");
  exactKeys(bounds, ["truncated", "omitted"], "Resource catalog bounds");
  if (typeof bounds.truncated !== "boolean") throw new Error("Resource catalog bounds truncated must be a boolean");
  const omitted = record(bounds.omitted, "Resource catalog omitted counts");
  const omittedKeys = ["tools", "commands", "prompts", "skills", "themes", "providers", "models", "packages", "extensions", "diagnostics"];
  exactKeys(omitted, omittedKeys, "Resource catalog omitted counts");
  for (const key of omittedKeys) {
    if (!Number.isSafeInteger(omitted[key]) || (omitted[key] as number) < 0) {
      throw new Error(`Resource catalog omitted ${key} must be a non-negative safe integer`);
    }
  }
  if (bounds.truncated !== Object.values(omitted).some((value) => (value as number) > 0)) {
    throw new Error("Resource catalog bounds truncated conflicts with omitted counts");
  }
  return structuredClone(value) as HarnessResourceCatalog;
}
