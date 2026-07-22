import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { extname, dirname, join, resolve, sep } from "node:path";

import {
  appendDirectExtensions,
  loadDirectExtensions,
  RuntimeExtensionHost,
  type RuntimeInlineExtension,
  type RuntimeDiscoveredResourcePath,
} from "../extensions/runtime.js";
import {
  ProjectPackageManager,
  projectPackageDeclaredResourceMetadata,
  projectPackageDirectMetadata,
  projectPackageResourceSources,
  type InstalledProjectPackage,
  type ProjectPackageCatalogEntry,
} from "../extensions/project-packages.js";
import type { ExtensionRuntime, LoadExtensionsResult } from "../extensions/direct.js";
import {
  ensureExtensionRuntimeHost,
  getExtensionRuntimeHost,
  projectLoadedExtensionHost,
} from "../extensions/compat.js";
import type { ExtensionTheme } from "../extensions/types.js";
import { CONFIG_DIR_NAME } from "../config/paths.js";
import { sha256 } from "../tools/hash.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import { parseThemeDefinition } from "../tui/theme.js";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import {
  DefaultPackageManager,
  type PathMetadata,
  type ResolvedPaths,
  type ResolvedResource,
} from "./package-manager.js";
import { loadPromptTemplates, type PromptTemplate } from "./prompt-templates.js";
import { createSourceInfo } from "./source-info.js";
import { SettingsManager } from "./settings-manager.js";
import { loadSkills, type Skill } from "./skills.js";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.js";

export interface ResourceExtensionPaths {
  skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
  promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
  themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
  resolveProjectTrust?: (input: { extensionsResult: ResourceExtensionsResult }) => Promise<boolean>;
  /** Exact manager already loaded and validated by a coordinating caller. */
  preparedSettings?: SettingsManager;
  /** Validate a complete candidate before publication and optionally return a synchronous rollback. */
  prepareExtensions?: (extensionsResult: ResourceExtensionsResult) => void | (() => void);
  signal?: AbortSignal;
}

/** Loaded public extensions backed by one private runtime-host generation. */
export type ResourceExtensionsResult = LoadExtensionsResult;

/** Complete resource view consumed by an agent session. */
export interface ResourceLoader {
  /**
   * Opt in to AgentSession's coordinated reload protocol. Legacy loaders may
   * omit this and remain usable, but AgentSession will not reload them because
   * their published state cannot be rolled back generically.
   */
  readonly supportsTransactionalReload?: true;
  getExtensions(): ResourceExtensionsResult;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
  getThemes(): { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): string[];
  getProjectPackageState?(): {
    packages: InstalledProjectPackage[];
    catalog: ProjectPackageCatalogEntry[];
  };
  extendResources(paths: ResourceExtensionPaths): void;
  /** Host hook used after session_start so extension resources see bound session context. */
  extendResourcesFromExtensions?(runtime: ExtensionRuntime, reason: "startup" | "reload"): Promise<void>;
  /**
   * Replace one resource generation. Implementations must invoke a supplied
   * prepareExtensions callback before publication and retain the active
   * generation when it throws. If publication does not follow a successful
   * preparation, implementations must invoke its returned rollback.
   */
  reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

export interface DefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManager;
  eventBus?: EventBus;
  offline?: boolean;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  extensionFactories?: RuntimeInlineExtension[];
  /** Already-active user/invocation factories from the project-trust bootstrap. */
  preloadedExtensions?: RuntimeExtensionHost;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  extensionsOverride?: (base: ResourceExtensionsResult) => ResourceExtensionsResult;
  skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  };
  themesOverride?: (base: { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] }) => {
    themes: ExtensionTheme[];
    diagnostics: ResourceDiagnostic[];
  };
  agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  systemPromptOverride?: (base: string | undefined) => string | undefined;
  appendSystemPromptOverride?: (base: string[]) => string[];
}

function contextFile(directory: string): { path: string; content: string } | undefined {
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      return content.trim() === "" ? undefined : { path, content };
    }
    catch (error) {
      console.error(`Warning: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

export function loadProjectContextFiles(options: {
  cwd: string;
  agentDir: string;
}): Array<{ path: string; content: string }> {
  const cwd = resolvePath(options.cwd);
  const agentDir = resolvePath(options.agentDir);
  const result: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  const global = contextFile(agentDir);
  if (global !== undefined) {
    result.push(global);
    seen.add(global.path);
  }
  const ancestors: Array<{ path: string; content: string }> = [];
  let current = cwd;
  for (;;) {
    const loaded = contextFile(current);
    if (loaded !== undefined && !seen.has(loaded.path)) {
      ancestors.unshift(loaded);
      seen.add(loaded.path);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  result.push(...ancestors);
  return result;
}

function extensionResult(runtime: RuntimeExtensionHost): ResourceExtensionsResult {
  const result = projectLoadedExtensionHost(runtime);
  const activePaths = new Set(runtime.extensions().map((entry) => entry.sourcePath));
  result.errors.push(...runtime.diagnostics()
    .filter((diagnostic) => diagnostic.sourcePath !== "" && !activePaths.has(diagnostic.sourcePath))
    .map((diagnostic) => ({
      path: diagnostic.sourcePath,
      error: diagnostic.message,
    })));
  return result;
}

export class DefaultResourceLoader implements ResourceLoader {
  readonly supportsTransactionalReload = true as const;
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #options: DefaultResourceLoaderOptions;
  readonly #settingsManager: SettingsManager;
  readonly #eventBus: EventBus;
  readonly #packageManager: DefaultPackageManager;
  #extensions: ResourceExtensionsResult;
  #extensionHost: RuntimeExtensionHost;
  #skills: Skill[] = [];
  #skillDiagnostics: ResourceDiagnostic[] = [];
  #prompts: PromptTemplate[] = [];
  #promptDiagnostics: ResourceDiagnostic[] = [];
  #themes: ExtensionTheme[] = [];
  #themeDiagnostics: ResourceDiagnostic[] = [];
  #agentsFiles: Array<{ path: string; content: string }> = [];
  #systemPrompt: string | undefined;
  #appendSystemPrompt: string[] = [];
  #additionalSkillPaths: Array<{ path: string; metadata: PathMetadata }> = [];
  #additionalPromptPaths: Array<{ path: string; metadata: PathMetadata }> = [];
  #additionalThemePaths: Array<{ path: string; metadata: PathMetadata }> = [];
  #lastSkillPaths: string[] = [];
  #lastPromptPaths: string[] = [];
  #lastThemePaths: string[] = [];
  #metadataByPath = new Map<string, PathMetadata>();
  #projectPackages: InstalledProjectPackage[] = [];
  #projectPackageCatalog: ProjectPackageCatalogEntry[] = [];
  #preloadedExtensions: RuntimeExtensionHost | undefined;

  constructor(options: DefaultResourceLoaderOptions) {
    this.#cwd = resolvePath(options.cwd);
    this.#agentDir = resolvePath(options.agentDir);
    this.#options = options;
    this.#settingsManager = options.settingsManager ?? SettingsManager.create(this.#cwd, this.#agentDir);
    this.#eventBus = options.eventBus ?? createEventBus();
    this.#preloadedExtensions = options.preloadedExtensions;
    this.#packageManager = new DefaultPackageManager({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      settingsManager: this.#settingsManager,
      ...(options.offline === undefined ? {} : { offline: options.offline }),
    });
    this.#extensionHost = new RuntimeExtensionHost(this.#cwd, {
      dataRoot: join(this.#agentDir, "state", "extension-data"),
    });
    this.#extensions = extensionResult(this.#extensionHost);
  }

  getExtensions(): ResourceExtensionsResult { return this.#extensions; }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return { skills: [...this.#skills], diagnostics: [...this.#skillDiagnostics] };
  }

  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return { prompts: [...this.#prompts], diagnostics: [...this.#promptDiagnostics] };
  }

  getThemes(): { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] } {
    return { themes: [...this.#themes], diagnostics: [...this.#themeDiagnostics] };
  }

  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
    return { agentsFiles: this.#agentsFiles.map((entry) => ({ ...entry })) };
  }

  getSystemPrompt(): string | undefined { return this.#systemPrompt; }

  getAppendSystemPrompt(): string[] { return [...this.#appendSystemPrompt]; }

  getProjectPackageState(): { packages: InstalledProjectPackage[]; catalog: ProjectPackageCatalogEntry[] } {
    return {
      packages: this.#projectPackages.map((entry) => ({ ...entry, provenance: { ...entry.provenance } })),
      catalog: this.#projectPackageCatalog.map((entry) => ({
        ...entry,
        source: { ...entry.source },
        disabledResources: [...entry.disabledResources],
        resolved: { ...entry.resolved },
      })),
    };
  }

  extendResources(paths: ResourceExtensionPaths): void {
    this.#addExtendedResources(paths, true);
  }

  async loadProjectTrustExtensions(): Promise<ResourceExtensionsResult> {
    this.#settingsManager.setProjectTrusted(false);
    await this.#settingsManager.reload();
    return extensionResult(await this.#loadExtensionHost());
  }

  async extendResourcesFromExtensions(
    runtime: ExtensionRuntime,
    reason: "startup" | "reload",
  ): Promise<void> {
    if (runtime !== this.#extensions.runtime) {
      throw new Error("Extension resources must come from the active resource-loader runtime");
    }
    const host = getExtensionRuntimeHost(runtime);
    if (host === undefined || host !== this.#extensionHost) {
      throw new Error("Extension resources require the active runtime-host generation");
    }
    const discovered = await host.discoverResources(reason);
    const dynamicMetadata = (entry: {
      sourcePath: string;
      resourceRoot: string;
      scope: "builtin" | "user" | "project" | "invocation";
    }): PathMetadata => ({
      source: entry.sourcePath,
      scope: entry.scope === "invocation" ? "temporary" : entry.scope === "builtin" ? "user" : entry.scope,
      origin: "package",
      baseDir: entry.resourceRoot,
    });
    const canonicalDiscovered = async (
      entries: RuntimeDiscoveredResourcePath[],
    ): Promise<Array<{ path: string; metadata: PathMetadata }>> => {
      const selected: Array<{ path: string; metadata: PathMetadata }> = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const path = await this.#resolveDiscoveredPath(host, entry);
        if (path === undefined || seen.has(path)) continue;
        seen.add(path);
        selected.push({ path, metadata: dynamicMetadata(entry) });
      }
      return selected;
    };
    this.#addExtendedResources({
      skillPaths: await canonicalDiscovered(discovered.skillPaths),
      promptPaths: await canonicalDiscovered(discovered.promptPaths),
      themePaths: await canonicalDiscovered(discovered.themePaths),
    }, true);
  }

  #addExtendedResources(paths: ResourceExtensionPaths, refresh: boolean): void {
    const add = (
      target: Array<{ path: string; metadata: PathMetadata }>,
      entries: Array<{ path: string; metadata: PathMetadata }>,
    ): void => {
      const seen = new Set(target.map((entry) => canonicalizePath(entry.path)));
      for (const entry of entries) {
        const path = this.#resolveResourcePath(entry.path);
        const canonical = canonicalizePath(path);
        if (seen.has(canonical)) continue;
        const metadata = {
          ...entry.metadata,
          ...(entry.metadata.baseDir === undefined
            ? {}
            : { baseDir: this.#resolveResourcePath(entry.metadata.baseDir) }),
        };
        target.push({ path, metadata });
        this.#metadataByPath.set(path, metadata);
        seen.add(canonical);
      }
    };
    add(this.#additionalSkillPaths, paths.skillPaths ?? []);
    add(this.#additionalPromptPaths, paths.promptPaths ?? []);
    add(this.#additionalThemePaths, paths.themePaths ?? []);
    if (refresh) {
      this.#lastSkillPaths = this.#mergePaths(this.#lastSkillPaths, this.#additionalSkillPaths.map((entry) => entry.path));
      this.#lastPromptPaths = this.#mergePaths(this.#lastPromptPaths, this.#additionalPromptPaths.map((entry) => entry.path));
      this.#lastThemePaths = this.#mergePaths(this.#lastThemePaths, this.#additionalThemePaths.map((entry) => entry.path));
      this.#updateSkills(this.#lastSkillPaths);
      this.#updatePrompts(this.#lastPromptPaths);
      this.#updateThemes(this.#lastThemePaths);
    }
  }

  async #resolveDiscoveredPath(
    host: RuntimeExtensionHost,
    resource: RuntimeDiscoveredResourcePath,
  ): Promise<string | undefined> {
    try {
      if (!resource.trusted) throw new Error("Resource contribution is not trusted");
      const root = resolve(resource.resourceRoot);
      if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) {
        throw new Error("Resource package root contains a symbolic link");
      }
      const boundary = await WorkspaceBoundary.create(root);
      const target = boundary.lexical(resource.path);
      const local = target === root ? "" : target.slice(root.length + 1);
      let current = root;
      for (const component of local === "" ? [] : local.split(sep)) {
        current = join(current, component);
        if ((await lstat(current)).isSymbolicLink()) throw new Error("Resource path contains a symbolic link");
      }
      const canonical = await boundary.readable(target);
      const information = await lstat(canonical);
      if (!information.isFile() && !information.isDirectory()) {
        throw new Error("Resource path is not a regular file or directory");
      }
      return canonical;
    } catch (error) {
      host.addDiagnostic({
        extensionId: resource.extensionId,
        sourcePath: resource.sourcePath,
        message: `Runtime resource path was ignored: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  async reload(options: ResourceLoaderReloadOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const settingsPrepared = options.preparedSettings === this.#settingsManager;
    if (settingsPrepared && options.resolveProjectTrust !== undefined) {
      throw new Error("Project-trust resolution requires settings reload");
    }
    let trustBootstrap = this.#preloadedExtensions;
    this.#preloadedExtensions = undefined;
    if (options.resolveProjectTrust !== undefined) {
      if (trustBootstrap !== undefined) {
        await trustBootstrap.close().catch(() => undefined);
        throw new Error("A preloaded extension host cannot be combined with project-trust resolution");
      }
      this.#settingsManager.setProjectTrusted(false);
      await this.#settingsManager.reload();
      trustBootstrap = await this.#loadExtensionHost(options.signal);
      const trustExtensions = extensionResult(trustBootstrap);
      try {
        const trusted = await options.resolveProjectTrust({ extensionsResult: trustExtensions });
        options.signal?.throwIfAborted();
        this.#settingsManager.setProjectTrusted(trusted);
      } catch (error) {
        await trustBootstrap.close().catch(() => undefined);
        throw error;
      } finally {
        trustExtensions.runtime.invalidate("Project-trust extension context is no longer active");
      }
    }

    let resolved: ResolvedPaths;
    let projectResolved: ResolvedPaths;
    let projectPackages: InstalledProjectPackage[];
    let projectPackageCatalog: ProjectPackageCatalogEntry[];
    let commandLine: ResolvedPaths;
    try {
      if (!settingsPrepared) await this.#settingsManager.reload();
      const configuredNpm = this.#settingsManager.getNpmCommand();
      const project = await new ProjectPackageManager({
        workspace: this.#cwd,
        projectTrusted: this.#settingsManager.isProjectTrusted(),
        ...(this.#options.offline === undefined ? {} : { offline: this.#options.offline }),
        operationLeaseRoot: join(this.#agentDir, "state", "leases"),
        ...(configuredNpm === undefined || configuredNpm.length === 0 ? {} : {
          commands: { npm: { command: configuredNpm[0]!, prefix: configuredNpm.slice(1) } },
        }),
      }).reconcile(options.signal);
      options.signal?.throwIfAborted();
      projectPackages = project.packages;
      projectPackageCatalog = project.catalog;
      projectResolved = projectPackageDeclaredResourceMetadata(await this.#packageManager.resolveExtensionSources(
        projectPackageResourceSources(projectPackages, projectPackageCatalog),
        { local: true },
      ), projectPackages, projectPackageCatalog);
      resolved = await this.#packageManager.resolve();
      commandLine = await this.#packageManager.resolveExtensionSources(
        this.#options.additionalExtensionPaths ?? [],
        { temporary: true },
      );
      options.signal?.throwIfAborted();
    } catch (error) {
      await trustBootstrap?.close().catch(() => undefined);
      throw error;
    }
    const metadataByPath = new Map<string, PathMetadata>();
    const enabled = (resources: ResolvedResource[]): string[] => {
      for (const resource of resources) {
        if (!metadataByPath.has(resource.path)) metadataByPath.set(resource.path, resource.metadata);
      }
      return resources.filter((resource) => resource.enabled).map((resource) => resource.path);
    };
    const commandExtensions = enabled(commandLine.extensions);
    const projectExtensions = enabled(projectResolved.extensions);
    const configuredExtensions = enabled(resolved.extensions);
    const extensionPaths = this.#options.noExtensions === true
      ? commandExtensions
      : this.#mergePaths(commandExtensions, [...projectExtensions, ...configuredExtensions]);
    const projectDirectMetadata = projectPackageDirectMetadata(
      projectResolved,
      projectPackages,
      projectPackageCatalog,
    );
    const directPathMetadata = new Map(extensionPaths.map((path) => {
      const metadata = metadataByPath.get(path);
      const declared = projectDirectMetadata.get(path);
      return [path, {
        scope: declared?.scope ?? metadata?.scope ?? "temporary",
        trusted: declared?.trusted ?? (metadata?.scope === "project" ? this.#settingsManager.isProjectTrusted() : true),
        ...(declared?.resourceRoot !== undefined
          ? { resourceRoot: declared.resourceRoot }
          : metadata?.baseDir === undefined ? {} : { resourceRoot: metadata.baseDir }),
        ...(declared?.extensionId === undefined ? {} : { extensionId: declared.extensionId }),
        ...(declared?.disabledCommands === undefined ? {} : { disabledCommands: declared.disabledCommands }),
        ...(declared?.disabledResources === undefined ? {} : { disabledResources: declared.disabledResources }),
      }] as const;
    }));

    let nextExtensions: RuntimeExtensionHost | undefined;
    let discardedExtensions: RuntimeExtensionHost | undefined;
    let candidateRuntime: ExtensionRuntime | undefined;
    let rollbackPreparation: (() => void) | undefined;
    const publishedRuntime = this.#extensions.runtime;
    const publishedHost = this.#extensionHost;
    try {
      const extensionOptions = {
        workspace: this.#cwd,
        dataRoot: join(this.#agentDir, "state", "extension-data"),
        eventBus: this.#eventBus,
        projectTrusted: this.#settingsManager.isProjectTrusted(),
        directPathMetadata,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      } as const;
      if (trustBootstrap === undefined) {
        nextExtensions = await loadDirectExtensions(extensionPaths, {
          ...extensionOptions,
          inlineExtensions: this.#options.extensionFactories ?? [],
        });
      } else {
        nextExtensions = trustBootstrap;
        trustBootstrap = undefined;
        nextExtensions.setHostContext({ projectTrusted: this.#settingsManager.isProjectTrusted() });
        const activePaths = new Set(nextExtensions.extensions().map((entry) => canonicalizePath(entry.sourcePath)));
        const failedPaths = new Set(nextExtensions.diagnostics()
          .filter((entry) => entry.sourcePath !== "")
          .map((entry) => canonicalizePath(entry.sourcePath)));
        const remaining = extensionPaths.filter((path) => {
          const canonical = canonicalizePath(path);
          return !activePaths.has(canonical) && !failedPaths.has(canonical);
        });
        await appendDirectExtensions(nextExtensions, remaining, extensionOptions);
        nextExtensions.reorderCommittedExtensions(extensionPaths);
      }
      options.signal?.throwIfAborted();
      const candidateAdditionalSkillPaths: Array<{ path: string; metadata: PathMetadata }> = [];
      const candidateAdditionalPromptPaths: Array<{ path: string; metadata: PathMetadata }> = [];
      const candidateAdditionalThemePaths: Array<{ path: string; metadata: PathMetadata }> = [];
      const candidateAdditionalPaths = [
        ...candidateAdditionalSkillPaths,
        ...candidateAdditionalPromptPaths,
        ...candidateAdditionalThemePaths,
      ];

      const commandSkills = enabled(commandLine.skills);
      const projectSkills = enabled(projectResolved.skills);
      const configuredSkills = enabled(resolved.skills);
      const commandPrompts = enabled(commandLine.prompts);
      const projectPrompts = enabled(projectResolved.prompts);
      const configuredPrompts = enabled(resolved.prompts);
      const commandThemes = enabled(commandLine.themes);
      const projectThemes = enabled(projectResolved.themes);
      const configuredThemes = enabled(resolved.themes);
      const candidateLastSkillPaths = this.#mergePaths(
        this.#options.noSkills === true ? commandSkills : [...commandSkills, ...projectSkills, ...configuredSkills],
        [...(this.#options.additionalSkillPaths ?? []), ...candidateAdditionalSkillPaths.map((entry) => entry.path)],
      );
      const candidateLastPromptPaths = this.#mergePaths(
        this.#options.noPromptTemplates === true ? commandPrompts : [...commandPrompts, ...projectPrompts, ...configuredPrompts],
        [...(this.#options.additionalPromptTemplatePaths ?? []), ...candidateAdditionalPromptPaths.map((entry) => entry.path)],
      );
      const candidateLastThemePaths = this.#mergePaths(
        this.#options.noThemes === true ? commandThemes : [...commandThemes, ...projectThemes, ...configuredThemes],
        [...(this.#options.additionalThemePaths ?? []), ...candidateAdditionalThemePaths.map((entry) => entry.path)],
      );
      const candidateSkills = this.#loadSkills(candidateLastSkillPaths, metadataByPath, candidateAdditionalPaths);
      for (const input of this.#options.additionalSkillPaths ?? []) {
        const path = this.#resolveResourcePath(input);
        if (!existsSync(path)) {
          candidateSkills.diagnostics = candidateSkills.diagnostics.filter((entry) => entry.path !== path);
          candidateSkills.diagnostics.push({ type: "error", message: "Skill path does not exist", path });
        }
      }
      const candidatePrompts = this.#loadPrompts(candidateLastPromptPaths, metadataByPath, candidateAdditionalPaths);
      for (const input of this.#options.additionalPromptTemplatePaths ?? []) {
        const path = this.#resolveResourcePath(input);
        if (!existsSync(path)) {
          candidatePrompts.diagnostics = candidatePrompts.diagnostics.filter((entry) => entry.path !== path);
          candidatePrompts.diagnostics.push({ type: "error", message: "Prompt template path does not exist", path });
        }
      }
      const candidateThemes = this.#loadThemes(candidateLastThemePaths, metadataByPath, candidateAdditionalPaths);
      for (const input of this.#options.additionalThemePaths ?? []) {
        const path = this.#resolveResourcePath(input);
        if (!existsSync(path)) {
          candidateThemes.diagnostics = candidateThemes.diagnostics.filter((entry) => entry.path !== path);
          candidateThemes.diagnostics.push({ type: "error", message: "Theme path does not exist", path });
        }
      }

      for (const input of this.#options.additionalExtensionPaths ?? []) {
        if (!isLocalPath(input)) continue;
        const path = this.#resolveResourcePath(input);
        if (!existsSync(path)) {
          nextExtensions.addDiagnostic({
            extensionId: "direct-loader",
            sourcePath: path,
            message: `Extension path does not exist: ${path}`,
          });
        }
      }

      const context = {
        agentsFiles: this.#options.noContextFiles === true
          ? []
          : loadProjectContextFiles({ cwd: this.#cwd, agentDir: this.#agentDir }),
      };
      const candidateAgentsFiles = (this.#options.agentsFilesOverride?.(context) ?? context).agentsFiles;
      const baseSystemPrompt = this.#resolvePromptInput(
        this.#options.systemPrompt ?? this.#discoverSystemPromptFile(),
      );
      const candidateSystemPrompt = this.#options.systemPromptOverride === undefined
        ? baseSystemPrompt
        : this.#options.systemPromptOverride(baseSystemPrompt);
      const discoveredAppend = this.#discoverAppendSystemPromptFile();
      const appendSources = this.#options.appendSystemPrompt ?? (discoveredAppend === undefined ? [] : [discoveredAppend]);
      const baseAppend = appendSources
        .map((source) => this.#resolvePromptInput(source))
        .filter((source): source is string => source !== undefined);
      const candidateAppendSystemPrompt = this.#options.appendSystemPromptOverride?.(baseAppend) ?? baseAppend;
      const baseExtensions = extensionResult(nextExtensions);
      candidateRuntime = baseExtensions.runtime;
      const selectedExtensions = this.#options.extensionsOverride?.(baseExtensions) ?? baseExtensions;
      const selectedHost = getExtensionRuntimeHost(selectedExtensions.runtime)
        ?? ensureExtensionRuntimeHost(selectedExtensions.runtime, this.#cwd);
      if (selectedHost !== nextExtensions) {
        baseExtensions.runtime.invalidate("Extension generation was replaced before activation");
        discardedExtensions = nextExtensions;
        nextExtensions = selectedHost;
      } else if (selectedExtensions.runtime !== baseExtensions.runtime) {
        baseExtensions.runtime.invalidate("Extension runtime projection was replaced before activation");
      }
      candidateRuntime = selectedExtensions.runtime;
      options.signal?.throwIfAborted();
      rollbackPreparation = options.prepareExtensions?.(selectedExtensions) ?? undefined;
      options.signal?.throwIfAborted();
      const previousRuntime = this.#extensions.runtime;
      const previousHost = this.#extensionHost;
      this.#metadataByPath = metadataByPath;
      this.#additionalSkillPaths = candidateAdditionalSkillPaths;
      this.#additionalPromptPaths = candidateAdditionalPromptPaths;
      this.#additionalThemePaths = candidateAdditionalThemePaths;
      this.#lastSkillPaths = candidateLastSkillPaths;
      this.#lastPromptPaths = candidateLastPromptPaths;
      this.#lastThemePaths = candidateLastThemePaths;
      this.#skills = candidateSkills.skills;
      this.#skillDiagnostics = candidateSkills.diagnostics;
      this.#prompts = candidatePrompts.prompts;
      this.#promptDiagnostics = candidatePrompts.diagnostics;
      this.#themes = candidateThemes.themes;
      this.#themeDiagnostics = candidateThemes.diagnostics;
      this.#agentsFiles = candidateAgentsFiles;
      this.#systemPrompt = candidateSystemPrompt;
      this.#appendSystemPrompt = candidateAppendSystemPrompt;
      this.#extensions = selectedExtensions;
      this.#extensionHost = nextExtensions;
      this.#projectPackages = projectPackages;
      this.#projectPackageCatalog = projectPackageCatalog;
      nextExtensions = undefined;
      candidateRuntime = undefined;
      rollbackPreparation = undefined;
      if (previousRuntime !== selectedExtensions.runtime) {
        previousRuntime.invalidate("Extension runtime was replaced by reload");
      }
      if (discardedExtensions !== undefined) {
        await discardedExtensions.close().catch((error: unknown) => {
          this.#extensionHost.addDiagnostic({
            extensionId: "resource-loader",
            sourcePath: "",
            message: `Discarded extension generation cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
        discardedExtensions = undefined;
      }
      if (previousHost !== this.#extensionHost) {
        try {
          await previousHost.close();
        } catch (error) {
          this.#extensionHost.addDiagnostic({
            extensionId: "resource-loader",
            sourcePath: "",
            message: `Previous extension generation cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    } catch (error) {
      let rollbackError: unknown;
      try {
        rollbackPreparation?.();
      } catch (cause) {
        rollbackError = cause;
      }
      if (candidateRuntime !== publishedRuntime) {
        candidateRuntime?.invalidate("Extension generation failed before activation");
      }
      if (nextExtensions !== publishedHost) await nextExtensions?.close().catch(() => undefined);
      if (discardedExtensions !== publishedHost && discardedExtensions !== nextExtensions) {
        await discardedExtensions?.close().catch(() => undefined);
      }
      if (rollbackError !== undefined) {
        throw new AggregateError([error, rollbackError], "Resource preparation and rollback failed");
      }
      throw error;
    }
  }

  async #loadExtensionHost(signal?: AbortSignal): Promise<RuntimeExtensionHost> {
    signal?.throwIfAborted();
    const resolved = await this.#packageManager.resolve();
    const commandLine = await this.#packageManager.resolveExtensionSources(
      this.#options.additionalExtensionPaths ?? [],
      { temporary: true },
    );
    const metadata = new Map<string, PathMetadata>();
    const enabled = (entries: ResolvedResource[]): string[] => entries.filter((entry) => {
      metadata.set(entry.path, entry.metadata);
      return entry.enabled;
    }).map((entry) => entry.path);
    const commandPaths = enabled(commandLine.extensions);
    const configured = enabled(resolved.extensions);
    const paths = this.#options.noExtensions === true ? commandPaths : this.#mergePaths(commandPaths, configured);
    return await loadDirectExtensions(
      paths,
      {
        workspace: this.#cwd,
        dataRoot: join(this.#agentDir, "state", "extension-data"),
        eventBus: this.#eventBus,
        projectTrusted: this.#settingsManager.isProjectTrusted(),
        inlineExtensions: this.#options.extensionFactories ?? [],
        directPathMetadata: new Map(paths.map((path) => {
          const source = metadata.get(path);
          return [path, {
            scope: source?.scope ?? "temporary",
            trusted: source?.scope === "project" ? this.#settingsManager.isProjectTrusted() : true,
            ...(source?.baseDir === undefined ? {} : { resourceRoot: source.baseDir }),
          }] as const;
        })),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  #resolveResourcePath(path: string): string {
    return resolvePath(path, this.#cwd, { trim: true });
  }

  #mergePaths(primary: readonly string[], additional: readonly string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const input of [...primary, ...additional]) {
      const path = this.#resolveResourcePath(input);
      const canonical = canonicalizePath(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(path);
    }
    return result;
  }

  #metadataForPath(
    path: string,
    metadataByPath = this.#metadataByPath,
    additionalPaths: ReadonlyArray<{ path: string; metadata: PathMetadata }> = [
      ...this.#additionalSkillPaths,
      ...this.#additionalPromptPaths,
      ...this.#additionalThemePaths,
    ],
  ): PathMetadata | undefined {
    const resolved = resolve(path);
    const exact = metadataByPath.get(path) ?? metadataByPath.get(resolved);
    if (exact !== undefined) return exact;
    for (const [root, metadata] of metadataByPath) {
      const normalizedRoot = resolve(root);
      if (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${sep}`)) {
        return metadata;
      }
    }
    for (const entry of additionalPaths) {
      const normalizedRoot = resolve(entry.path);
      if (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${sep}`)) {
        return entry.metadata;
      }
    }
    return undefined;
  }

  #sourceInfoFor(
    path: string,
    metadataByPath = this.#metadataByPath,
    additionalPaths?: ReadonlyArray<{ path: string; metadata: PathMetadata }>,
  ): ReturnType<typeof createSourceInfo> | undefined {
    const metadata = this.#metadataForPath(path, metadataByPath, additionalPaths);
    return metadata === undefined ? undefined : createSourceInfo(path, metadata);
  }

  #loadSkills(
    paths: string[],
    metadataByPath = this.#metadataByPath,
    additionalPaths?: ReadonlyArray<{ path: string; metadata: PathMetadata }>,
  ): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    const loaded = loadSkills({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      skillPaths: paths,
      includeDefaults: false,
    });
    const mapped = {
      skills: loaded.skills.map((skill) => ({
        ...skill,
        sourceInfo: this.#sourceInfoFor(skill.filePath, metadataByPath, additionalPaths) ?? skill.sourceInfo,
      })),
      diagnostics: loaded.diagnostics,
    };
    return this.#options.skillsOverride?.(mapped) ?? mapped;
  }

  #updateSkills(paths: string[]): void {
    const selected = this.#loadSkills(paths);
    this.#skills = selected.skills;
    this.#skillDiagnostics = selected.diagnostics;
  }

  #loadPrompts(
    paths: string[],
    metadataByPath = this.#metadataByPath,
    additionalPaths?: ReadonlyArray<{ path: string; metadata: PathMetadata }>,
  ): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    const loaded = loadPromptTemplates({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      promptPaths: paths,
      includeDefaults: false,
    });
    const byName = new Map<string, PromptTemplate>();
    const diagnostics: ResourceDiagnostic[] = [];
    for (const loadedPrompt of loaded) {
      const metadata = this.#metadataForPath(loadedPrompt.filePath, metadataByPath, additionalPaths);
      const declared = metadata?.declaredResources?.filter((entry) => entry.kind === "prompt" || entry.kind === "command") ?? [];
      const disabled = new Set(metadata?.disabledDeclaredResources ?? []);
      const declarations = declared.filter((entry) => !disabled.has(`${entry.kind}:${entry.name}`));
      const prompts = declared.length === 0 ? [loadedPrompt] : declarations.map((declaration): PromptTemplate => {
        const { argumentHint: _argumentHint, ...base } = loadedPrompt;
        return {
          ...base,
          name: declaration.name,
          description: declaration.description ?? loadedPrompt.description,
          ...(declaration.kind === "command" && declaration.argumentHint !== undefined
            ? { argumentHint: declaration.argumentHint }
            : {}),
        };
      });
      for (const prompt of prompts) {
        const previous = byName.get(prompt.name);
        if (previous !== undefined) {
          diagnostics.push({
            type: "collision",
            message: `prompt ${JSON.stringify(prompt.name)} has multiple definitions`,
            path: prompt.filePath,
            collision: {
              resourceType: "prompt",
              name: prompt.name,
              winnerPath: previous.filePath,
              loserPath: prompt.filePath,
            },
          });
          continue;
        }
        byName.set(prompt.name, {
          ...prompt,
          sourceInfo: metadata === undefined ? prompt.sourceInfo : createSourceInfo(prompt.filePath, metadata),
        });
      }
    }
    const base = { prompts: [...byName.values()], diagnostics };
    return this.#options.promptsOverride?.(base) ?? base;
  }

  #updatePrompts(paths: string[]): void {
    const selected = this.#loadPrompts(paths);
    this.#prompts = selected.prompts;
    this.#promptDiagnostics = selected.diagnostics;
  }

  #loadThemes(
    paths: string[],
    metadataByPath = this.#metadataByPath,
    additionalPaths?: ReadonlyArray<{ path: string; metadata: PathMetadata }>,
  ): { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] } {
    const byName = new Map<string, ExtensionTheme>();
    const diagnostics: ResourceDiagnostic[] = [];
    const loadPath = (path: string): ExtensionTheme[] => {
      const information = statSync(path);
      const files = information.isDirectory()
        ? readdirSync(path, { withFileTypes: true })
            .filter((entry) => {
              if (extname(entry.name).toLowerCase() !== ".json") return false;
              if (entry.isFile()) return true;
              if (!entry.isSymbolicLink()) return false;
              try { return statSync(join(path, entry.name)).isFile(); } catch { return false; }
            })
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => join(path, entry.name))
        : information.isFile() && extname(path).toLowerCase() === ".json" ? [path] : [];
      return files.flatMap((filePath) => {
        const source = readFileSync(filePath, "utf8");
        const definition = parseThemeDefinition(JSON.parse(source) as unknown);
        const base: ExtensionTheme = {
          name: definition.name,
          extensionId: "theme",
          sourcePath: filePath,
          sha256: sha256(source),
          definition,
        };
        const metadata = this.#metadataForPath(filePath, metadataByPath, additionalPaths);
        const declared = metadata?.declaredResources?.filter((entry) => entry.kind === "theme") ?? [];
        if (declared.length === 0) return [base];
        const disabled = new Set(metadata?.disabledDeclaredResources ?? []);
        return declared.filter((entry) => !disabled.has(`theme:${entry.name}`)).map((declaration) => {
          if (declaration.name !== definition.name) {
            throw new Error(`Extension theme declaration ${declaration.name} does not match definition ${definition.name}`);
          }
          return {
            ...base,
            name: declaration.name,
            ...(declaration.description === undefined ? {} : { description: declaration.description }),
          };
        });
      });
    };
    for (const path of paths) {
      if (!existsSync(path)) {
        diagnostics.push({ type: "warning", message: "theme path does not exist", path });
        continue;
      }
      try {
        for (const theme of loadPath(path)) {
          const previous = byName.get(theme.name);
          if (previous !== undefined) {
            diagnostics.push({
              type: "collision",
              message: `theme ${JSON.stringify(theme.name)} has multiple definitions`,
              path: theme.sourcePath,
              collision: {
                resourceType: "theme",
                name: theme.name,
                winnerPath: previous.sourcePath,
                loserPath: theme.sourcePath,
              },
            });
            continue;
          }
          byName.set(theme.name, theme);
        }
      } catch (error) {
        diagnostics.push({
          type: "warning",
          message: error instanceof Error ? error.message : String(error),
          path,
        });
      }
    }
    const base = { themes: [...byName.values()], diagnostics };
    return this.#options.themesOverride?.(base) ?? base;
  }

  #updateThemes(paths: string[]): void {
    const selected = this.#loadThemes(paths);
    this.#themes = selected.themes;
    this.#themeDiagnostics = selected.diagnostics;
  }

  #resolvePromptInput(source: string | undefined): string | undefined {
    if (source === undefined || source === "") return undefined;
    if (!existsSync(source)) return source;
    try {
      return readFileSync(source, "utf8");
    } catch (error) {
      console.error(`Warning: could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
      return source;
    }
  }

  #discoverSystemPromptFile(): string | undefined {
    const project = join(this.#cwd, CONFIG_DIR_NAME, "SYSTEM.md");
    if (this.#settingsManager.isProjectTrusted() && existsSync(project)) return project;
    const user = join(this.#agentDir, "SYSTEM.md");
    return existsSync(user) ? user : undefined;
  }

  #discoverAppendSystemPromptFile(): string | undefined {
    const project = join(this.#cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
    if (this.#settingsManager.isProjectTrusted() && existsSync(project)) return project;
    const user = join(this.#agentDir, "APPEND_SYSTEM.md");
    return existsSync(user) ? user : undefined;
  }
}
