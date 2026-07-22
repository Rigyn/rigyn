import type { SkillRoot } from "../context/skills.js";
import type { ThemeDefinition } from "../tui/theme.js";

export type ExtensionScope = "builtin" | "user" | "project" | "invocation";
export type ExtensionStatus = "active" | "blocked" | "disabled" | "invalid" | "shadowed";
export type ExtensionDiagnosticSeverity = "error" | "warning" | "info";

export interface ExtensionSource {
  path: string;
  scope: ExtensionScope;
  trusted: boolean;
  /** Missing conventional roots are an empty catalog, not a diagnostic. */
  optional?: boolean;
}

export interface ExtensionContributionCounts {
  skillRoots: number;
  prompts: number;
  commands: number;
  themes: number;
  runtime: number;
}

export interface ExtensionMetadata {
  id: string;
  name: string;
  version?: string;
  description?: string;
  hostVersionRange?: string;
  scope: ExtensionScope;
  trusted: boolean;
  status: ExtensionStatus;
  sourceRoot: string;
  extensionRoot: string;
  manifestPath: string;
  manifestSha256?: string;
  precedence: number;
  contributions: ExtensionContributionCounts;
}

export interface ExtensionDiagnostic {
  severity: ExtensionDiagnosticSeverity;
  code: string;
  message: string;
  path: string;
  extensionId?: string;
}

export interface ExtensionPromptTemplate {
  id: string;
  extensionId: string;
  description?: string;
  argumentHint?: string;
  sourcePath: string;
  sha256: string;
  template: string;
}

export interface ExtensionSlashCommand {
  name: string;
  extensionId: string;
  description?: string;
  argumentHint?: string;
  sourcePath: string;
  sha256: string;
  template: string;
}

export interface ExtensionTheme {
  name: string;
  extensionId: string;
  description?: string;
  sourcePath: string;
  sha256: string;
  definition: ThemeDefinition;
}

export interface ExtensionRuntimeEntry {
  extensionId: string;
  sourcePath: string;
  sha256: string;
  /** Directory that owns relative resources contributed by this runtime entry. */
  resourceRoot?: string;
  scope?: ExtensionScope;
  trusted?: boolean;
}

export interface ExtensionBundle {
  skillRoots: SkillRoot[];
  prompts: ExtensionPromptTemplate[];
  commands: ExtensionSlashCommand[];
  themes: ExtensionTheme[];
  runtime: ExtensionRuntimeEntry[];
}

export interface ExtensionDoctorReport {
  healthy: boolean;
  active: number;
  blocked: number;
  disabled: number;
  invalid: number;
  shadowed: number;
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionDiscoveryOptions {
  maxExtensions?: number;
  maxDirectoryEntries?: number;
  maxManifestBytes?: number;
  maxTemplateBytes?: number;
  maxIntegrityFileBytes?: number;
  maxExtensionBytes?: number;
  maxDiagnostics?: number;
}
