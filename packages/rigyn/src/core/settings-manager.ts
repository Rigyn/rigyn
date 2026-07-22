import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "../config/paths.js";
import { withFileLockSync } from "../storage/file-lock.js";
import { normalizePath, resolvePath } from "../utils/paths.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type TransportSetting = "auto" | "sse" | "websocket" | "websocket-cached";
export type QueueSetting = "all" | "one-at-a-time";
export type DefaultProjectTrust = "ask" | "always" | "never";

export interface CompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface BranchSummarySettings {
  reserveTokens?: number;
  skipPrompt?: boolean;
}

export interface ProviderRetrySettings {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

export interface RetrySettings {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
  showImages?: boolean;
  imageWidthCells?: number;
  clearOnShrink?: boolean;
  showTerminalProgress?: boolean;
}

export interface ImageSettings {
  autoResize?: boolean;
  blockImages?: boolean;
}

export interface ThinkingBudgetsSettings {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface MarkdownSettings {
  codeBlockIndent?: string;
}

export interface WarningSettings {
  anthropicExtraUsage?: boolean;
}

export type PackageSource = string | {
  source: string;
  manifest?: "legacy";
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};

export interface Settings {
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  transport?: TransportSetting;
  steeringMode?: QueueSetting;
  followUpMode?: QueueSetting;
  theme?: string;
  compaction?: CompactionSettings;
  branchSummary?: BranchSummarySettings;
  retry?: RetrySettings;
  hideThinkingBlock?: boolean;
  showCacheMissNotices?: boolean;
  externalEditor?: string;
  shellPath?: string;
  quietStartup?: boolean;
  defaultProjectTrust?: DefaultProjectTrust;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  collapseChangelog?: boolean;
  packages?: PackageSource[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  terminal?: TerminalSettings;
  images?: ImageSettings;
  enabledModels?: string[];
  doubleEscapeAction?: "fork" | "tree" | "none";
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  thinkingBudgets?: ThinkingBudgetsSettings;
  editorPaddingX?: number;
  outputPad?: 0 | 1;
  autocompleteMaxVisible?: number;
  showHardwareCursor?: boolean;
  markdown?: MarkdownSettings;
  warnings?: WarningSettings;
  sessionDir?: string;
  httpProxy?: string;
  httpIdleTimeoutMs?: number | string;
  websocketConnectTimeoutMs?: number | string;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
  projectTrusted?: boolean;
}

export interface SettingsStorage {
  withLock(scope: SettingsScope, operation: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
  scope: SettingsScope;
  error: Error;
}

function mergeSettings(base: Settings, overlay: Settings): Settings {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const prior = result[key];
    result[key] = (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      prior !== null && typeof prior === "object" && !Array.isArray(prior)
    ) ? { ...(prior as Record<string, unknown>), ...(value as Record<string, unknown>) } : value;
  }
  return result as Settings;
}

function migrateSettings(value: unknown): Settings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must contain a JSON object");
  }
  const settings = structuredClone(value) as Record<string, unknown>;
  if (settings.steeringMode === undefined && settings.queueMode !== undefined) {
    settings.steeringMode = settings.queueMode;
    delete settings.queueMode;
  }
  if (settings.transport === undefined && typeof settings.websockets === "boolean") {
    settings.transport = settings.websockets ? "websocket" : "sse";
    delete settings.websockets;
  }
  if (settings.skills !== null && typeof settings.skills === "object" && !Array.isArray(settings.skills)) {
    const legacy = settings.skills as Record<string, unknown>;
    if (settings.enableSkillCommands === undefined && typeof legacy.enableSkillCommands === "boolean") {
      settings.enableSkillCommands = legacy.enableSkillCommands;
    }
    if (Array.isArray(legacy.customDirectories) && legacy.customDirectories.length > 0) {
      settings.skills = legacy.customDirectories;
    } else {
      delete settings.skills;
    }
  }
  const retry = settings.retry;
  if (retry !== null && typeof retry === "object" && !Array.isArray(retry)) {
    const retryRecord = retry as Record<string, unknown>;
    if (typeof retryRecord.maxDelayMs === "number") {
      const current = retryRecord.provider;
      const provider = current !== null && typeof current === "object" && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {};
      if (provider.maxRetryDelayMs === undefined || provider.maxRetryDelayMs === null) {
        provider.maxRetryDelayMs = retryRecord.maxDelayMs;
      }
      retryRecord.provider = provider;
      delete retryRecord.maxDelayMs;
    }
  }
  return settings as Settings;
}

function parseSettings(content: string | undefined): Settings {
  return content === undefined || content === "" ? {} : migrateSettings(JSON.parse(content));
}

export class FileSettingsStorage implements SettingsStorage {
  readonly #globalPath: string;
  readonly #projectPath: string;

  constructor(cwd: string, agentDirectory: string) {
    this.#globalPath = join(resolvePath(agentDirectory), "settings.json");
    this.#projectPath = join(resolvePath(cwd), CONFIG_DIR_NAME, "settings.json");
  }

  withLock(scope: SettingsScope, operation: (current: string | undefined) => string | undefined): void {
    const path = scope === "global" ? this.#globalPath : this.#projectPath;
    const directory = dirname(path);
    const directoryStats = () => {
      let stats;
      try {
        stats = lstatSync(directory);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Settings directory must be a directory and cannot be a symbolic link: ${directory}`);
      }
      return stats;
    };
    const readCurrent = (): string | undefined => {
      directoryStats();
      let stats;
      try {
        stats = lstatSync(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Settings path must be a regular file and cannot be a symbolic link: ${path}`);
      }
      return readFileSync(path, "utf8");
    };
    const writeCurrent = (contents: string): void => {
      readCurrent();
      writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    };
    if (readCurrent() === undefined) {
      const initial = operation(undefined);
      if (initial === undefined) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const parent = directoryStats();
      if (parent === undefined) throw new Error(`Settings directory was not created: ${directory}`);
      withFileLockSync(path, () => {
        const lockedParent = directoryStats();
        if (lockedParent === undefined || lockedParent.dev !== parent.dev || lockedParent.ino !== parent.ino) {
          throw new Error("Settings directory changed while acquiring its file lock");
        }
        const current = readCurrent();
        const next = current === undefined ? initial : operation(current);
        if (next !== undefined) writeCurrent(next);
      });
      return;
    }
    const parent = directoryStats();
    if (parent === undefined) throw new Error(`Settings directory disappeared: ${directory}`);
    withFileLockSync(path, () => {
      const lockedParent = directoryStats();
      if (lockedParent === undefined || lockedParent.dev !== parent.dev || lockedParent.ino !== parent.ino) {
        throw new Error("Settings directory changed while acquiring its file lock");
      }
      const current = readCurrent();
      const next = operation(current);
      if (next !== undefined) writeCurrent(next);
    });
  }
}

export class InMemorySettingsStorage implements SettingsStorage {
  #values: Partial<Record<SettingsScope, string>> = {};

  withLock(scope: SettingsScope, operation: (current: string | undefined) => string | undefined): void {
    const next = operation(this.#values[scope]);
    if (next !== undefined) this.#values[scope] = next;
  }
}

interface ScopeState {
  value: Settings;
  loadError: Error | undefined;
  changed: Set<keyof Settings>;
  nested: Map<keyof Settings, Set<string>>;
}

function emptyScope(): ScopeState {
  return { value: {}, loadError: undefined, changed: new Set(), nested: new Map() };
}

export class SettingsManager {
  readonly #storage: SettingsStorage;
  readonly #global: ScopeState;
  readonly #project: ScopeState;
  #effective: Settings;
  #projectTrusted: boolean;
  #writeQueue: Promise<void> = Promise.resolve();
  #errors: SettingsError[] = [];

  private constructor(storage: SettingsStorage, projectTrusted: boolean) {
    this.#storage = storage;
    this.#projectTrusted = projectTrusted;
    this.#global = this.#loadScope("global");
    this.#project = projectTrusted ? this.#loadScope("project") : emptyScope();
    this.#effective = mergeSettings(this.#global.value, this.#project.value);
  }

  static create(
    cwd: string,
    agentDirectory = getAgentDir(),
    options: SettingsManagerCreateOptions = {},
  ): SettingsManager {
    return new SettingsManager(new FileSettingsStorage(cwd, agentDirectory), options.projectTrusted ?? true);
  }

  static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
    return new SettingsManager(storage, options.projectTrusted ?? true);
  }

  static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
    const storage = new InMemorySettingsStorage();
    storage.withLock("global", () => JSON.stringify(settings, null, 2));
    return SettingsManager.fromStorage(storage, options);
  }

  #loadScope(scope: SettingsScope): ScopeState {
    let content: string | undefined;
    try {
      this.#storage.withLock(scope, (current) => {
        content = current;
        return undefined;
      });
      return { value: parseSettings(content), loadError: undefined, changed: new Set(), nested: new Map() };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#errors.push({ scope, error });
      return { value: {}, loadError: error, changed: new Set(), nested: new Map() };
    }
  }

  #recompute(): void {
    this.#effective = mergeSettings(this.#global.value, this.#project.value);
  }

  #mark(state: ScopeState, field: keyof Settings, nested?: string): void {
    state.changed.add(field);
    if (nested !== undefined) {
      const keys = state.nested.get(field) ?? new Set<string>();
      keys.add(nested);
      state.nested.set(field, keys);
    }
  }

  #save(scope: SettingsScope): void {
    const state = scope === "global" ? this.#global : this.#project;
    if (state.loadError !== undefined) return;
    const snapshot = structuredClone(state.value);
    const changed = new Set(state.changed);
    const nested = new Map([...state.nested].map(([key, keys]) => [key, new Set(keys)]));
    this.#writeQueue = this.#writeQueue.then(() => {
      if (scope === "project" && !this.#projectTrusted) throw new Error("Project is not trusted");
      this.#storage.withLock(scope, (content) => {
        const disk = parseSettings(content);
        const output = { ...disk } as Record<string, unknown>;
        for (const field of changed) {
          const fieldName = String(field);
          const value = snapshot[field];
          const nestedKeys = nested.get(field);
          if (nestedKeys !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
            const diskValue = disk[field];
            const merged = diskValue !== null && typeof diskValue === "object" && !Array.isArray(diskValue)
              ? { ...(diskValue as Record<string, unknown>) }
              : {};
            for (const key of nestedKeys) merged[key] = (value as Record<string, unknown>)[key];
            output[fieldName] = merged;
          } else {
            output[fieldName] = value;
          }
        }
        return JSON.stringify(output, null, 2);
      });
      state.changed.clear();
      state.nested.clear();
    }).catch((cause) => {
      this.#errors.push({ scope, error: cause instanceof Error ? cause : new Error(String(cause)) });
    });
  }

  #setGlobal<K extends keyof Settings>(field: K, value: Settings[K], nested?: string): void {
    this.#global.value[field] = value;
    this.#mark(this.#global, field, nested);
    this.#recompute();
    this.#save("global");
  }

  #setProject<K extends keyof Settings>(field: K, value: Settings[K]): void {
    if (!this.#projectTrusted) throw new Error("Project is not trusted; refusing to write project settings");
    this.#project.value[field] = value;
    this.#mark(this.#project, field);
    this.#recompute();
    this.#save("project");
  }

  #updateScope(scope: SettingsScope, patch: Partial<Settings>): void {
    if (scope === "project" && !this.#projectTrusted) {
      throw new Error("Project is not trusted; refusing to write project settings");
    }
    const state = scope === "global" ? this.#global : this.#project;
    state.value = mergeSettings(state.value, patch);
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const field = name as keyof Settings;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const nested of Object.keys(value)) this.#mark(state, field, nested);
      } else {
        this.#mark(state, field);
      }
    }
    this.#recompute();
    this.#save(scope);
  }

  getGlobalSettings(): Settings { return structuredClone(this.#global.value); }
  getProjectSettings(): Settings { return structuredClone(this.#project.value); }
  getSettings(): Settings { return structuredClone(this.#effective); }
  updateGlobalSettings(patch: Partial<Settings>): void { this.#updateScope("global", structuredClone(patch)); }
  updateProjectSettings(patch: Partial<Settings>): void { this.#updateScope("project", structuredClone(patch)); }
  isProjectTrusted(): boolean { return this.#projectTrusted; }

  setProjectTrusted(trusted: boolean): void {
    if (trusted === this.#projectTrusted) return;
    this.#projectTrusted = trusted;
    const replacement = trusted ? this.#loadScope("project") : emptyScope();
    this.#project.value = replacement.value;
    this.#project.loadError = replacement.loadError;
    this.#project.changed.clear();
    this.#project.nested.clear();
    this.#recompute();
  }

  async reload(): Promise<void> {
    await this.flush();
    const global = this.#loadScope("global");
    const project = this.#projectTrusted ? this.#loadScope("project") : emptyScope();
    if (global.loadError === undefined) {
      Object.assign(this.#global, global);
    } else {
      this.#global.loadError = global.loadError;
      this.#global.changed.clear();
      this.#global.nested.clear();
    }
    if (!this.#projectTrusted || project.loadError === undefined) {
      Object.assign(this.#project, project);
    } else {
      this.#project.loadError = project.loadError;
      this.#project.changed.clear();
      this.#project.nested.clear();
    }
    this.#recompute();
  }

  applyOverrides(overrides: Partial<Settings>): void { this.#effective = mergeSettings(this.#effective, overrides); }
  async flush(): Promise<void> { await this.#writeQueue; }
  drainErrors(): SettingsError[] { const errors = this.#errors; this.#errors = []; return errors; }

  getLastChangelogVersion(): string | undefined { return this.#global.value.lastChangelogVersion; }
  setLastChangelogVersion(value: string): void { this.#setGlobal("lastChangelogVersion", value); }
  getSessionDir(): string | undefined { return this.#effective.sessionDir ? normalizePath(this.#effective.sessionDir) : undefined; }
  getDefaultProvider(): string | undefined { return this.#effective.defaultProvider; }
  getDefaultModel(): string | undefined { return this.#effective.defaultModel; }
  setDefaultProvider(value: string): void { this.#setGlobal("defaultProvider", value); }
  setDefaultModel(value: string): void { this.#setGlobal("defaultModel", value); }
  setDefaultModelAndProvider(provider: string, model: string): void {
    this.#global.value.defaultProvider = provider;
    this.#global.value.defaultModel = model;
    this.#mark(this.#global, "defaultProvider");
    this.#mark(this.#global, "defaultModel");
    this.#recompute();
    this.#save("global");
  }
  getSteeringMode(): QueueSetting { return this.#effective.steeringMode ?? "one-at-a-time"; }
  setSteeringMode(value: QueueSetting): void { this.#setGlobal("steeringMode", value); }
  getFollowUpMode(): QueueSetting { return this.#effective.followUpMode ?? "one-at-a-time"; }
  setFollowUpMode(value: QueueSetting): void { this.#setGlobal("followUpMode", value); }
  getThemeSetting(): string | undefined { return typeof this.#effective.theme === "string" ? this.#effective.theme : undefined; }
  getTheme(): string | undefined { const value = this.getThemeSetting(); return value?.includes("/") ? undefined : value; }
  setTheme(value: string): void { this.#setGlobal("theme", value); }
  getDefaultThinkingLevel(): ThinkingLevel | undefined { return this.#effective.defaultThinkingLevel; }
  setDefaultThinkingLevel(value: ThinkingLevel): void { this.#setGlobal("defaultThinkingLevel", value); }
  getTransport(): TransportSetting { return this.#effective.transport ?? "auto"; }
  setTransport(value: TransportSetting): void { this.#setGlobal("transport", value); }
  getCompactionEnabled(): boolean { return this.#effective.compaction?.enabled ?? true; }
  setCompactionEnabled(value: boolean): void {
    this.#setGlobal("compaction", { ...(this.#global.value.compaction ?? {}), enabled: value }, "enabled");
  }
  getCompactionReserveTokens(): number { return this.#effective.compaction?.reserveTokens ?? 16_384; }
  getCompactionKeepRecentTokens(): number { return this.#effective.compaction?.keepRecentTokens ?? 20_000; }
  getCompactionSettings(): Required<CompactionSettings> {
    return { enabled: this.getCompactionEnabled(), reserveTokens: this.getCompactionReserveTokens(), keepRecentTokens: this.getCompactionKeepRecentTokens() };
  }
  getBranchSummarySettings(): Required<BranchSummarySettings> {
    return { reserveTokens: this.#effective.branchSummary?.reserveTokens ?? 16_384, skipPrompt: this.#effective.branchSummary?.skipPrompt ?? false };
  }
  getBranchSummarySkipPrompt(): boolean { return this.getBranchSummarySettings().skipPrompt; }
  getRetryEnabled(): boolean { return this.#effective.retry?.enabled ?? true; }
  setRetryEnabled(value: boolean): void {
    this.#setGlobal("retry", { ...(this.#global.value.retry ?? {}), enabled: value }, "enabled");
  }
  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
    return { enabled: this.getRetryEnabled(), maxRetries: this.#effective.retry?.maxRetries ?? 3, baseDelayMs: this.#effective.retry?.baseDelayMs ?? 2_000 };
  }
  getHttpIdleTimeoutMs(): number { return timeoutSetting(this.#effective.httpIdleTimeoutMs, 300_000, "httpIdleTimeoutMs"); }
  setHttpIdleTimeoutMs(value: number): void { this.#setGlobal("httpIdleTimeoutMs", validTimeout(value, 0, "httpIdleTimeoutMs")); }
  getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
    const value = this.#effective.retry?.provider;
    return { ...(value?.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }), ...(value?.maxRetries === undefined ? {} : { maxRetries: value.maxRetries }), maxRetryDelayMs: value?.maxRetryDelayMs ?? 60_000 };
  }
  getWebSocketConnectTimeoutMs(): number | undefined {
    return this.#effective.websocketConnectTimeoutMs === undefined
      ? undefined
      : timeoutSetting(this.#effective.websocketConnectTimeoutMs, undefined, "websocketConnectTimeoutMs");
  }
  getHideThinkingBlock(): boolean { return this.#effective.hideThinkingBlock ?? false; }
  setHideThinkingBlock(value: boolean): void { this.#setGlobal("hideThinkingBlock", value); }
  getShowCacheMissNotices(): boolean { return this.#effective.showCacheMissNotices ?? false; }
  setShowCacheMissNotices(value: boolean): void { this.#setGlobal("showCacheMissNotices", value); }
  getExternalEditorCommand(): string {
    const configured = this.#effective.externalEditor?.trim();
    return configured || process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
  }
  getShellPath(): string | undefined { return this.#effective.shellPath ? normalizePath(this.#effective.shellPath) : undefined; }
  setShellPath(value: string | undefined): void { this.#setGlobal("shellPath", value); }
  getQuietStartup(): boolean { return this.#effective.quietStartup ?? false; }
  setQuietStartup(value: boolean): void { this.#setGlobal("quietStartup", value); }
  getDefaultProjectTrust(): DefaultProjectTrust {
    const value = this.#global.value.defaultProjectTrust;
    return value === "always" || value === "never" ? value : "ask";
  }
  setDefaultProjectTrust(value: DefaultProjectTrust): void { this.#setGlobal("defaultProjectTrust", value); }
  getShellCommandPrefix(): string | undefined { return this.#effective.shellCommandPrefix; }
  setShellCommandPrefix(value: string | undefined): void { this.#setGlobal("shellCommandPrefix", value); }
  getNpmCommand(): string[] | undefined { return this.#effective.npmCommand === undefined ? undefined : [...this.#effective.npmCommand]; }
  setNpmCommand(value: string[] | undefined): void { this.#setGlobal("npmCommand", value === undefined ? undefined : [...value]); }
  getCollapseChangelog(): boolean { return this.#effective.collapseChangelog ?? false; }
  setCollapseChangelog(value: boolean): void { this.#setGlobal("collapseChangelog", value); }
  getPackages(): PackageSource[] { return structuredClone(this.#effective.packages ?? []); }
  setPackages(value: PackageSource[]): void { this.#setGlobal("packages", structuredClone(value)); }
  setProjectPackages(value: PackageSource[]): void { this.#setProject("packages", structuredClone(value)); }
  getExtensionPaths(): string[] { return [...(this.#effective.extensions ?? [])]; }
  setExtensionPaths(value: string[]): void { this.#setGlobal("extensions", [...value]); }
  setProjectExtensionPaths(value: string[]): void { this.#setProject("extensions", [...value]); }
  getSkillPaths(): string[] { return [...(this.#effective.skills ?? [])]; }
  setSkillPaths(value: string[]): void { this.#setGlobal("skills", [...value]); }
  setProjectSkillPaths(value: string[]): void { this.#setProject("skills", [...value]); }
  getPromptTemplatePaths(): string[] { return [...(this.#effective.prompts ?? [])]; }
  setPromptTemplatePaths(value: string[]): void { this.#setGlobal("prompts", [...value]); }
  setProjectPromptTemplatePaths(value: string[]): void { this.#setProject("prompts", [...value]); }
  getThemePaths(): string[] { return [...(this.#effective.themes ?? [])]; }
  setThemePaths(value: string[]): void { this.#setGlobal("themes", [...value]); }
  setProjectThemePaths(value: string[]): void { this.#setProject("themes", [...value]); }
  getEnableSkillCommands(): boolean { return this.#effective.enableSkillCommands ?? true; }
  setEnableSkillCommands(value: boolean): void { this.#setGlobal("enableSkillCommands", value); }
  getThinkingBudgets(): ThinkingBudgetsSettings | undefined { return structuredClone(this.#effective.thinkingBudgets); }
  getShowImages(): boolean { return this.#effective.terminal?.showImages ?? true; }
  setShowImages(value: boolean): void { this.#setGlobal("terminal", { ...(this.#global.value.terminal ?? {}), showImages: value }, "showImages"); }
  getImageWidthCells(): number {
    const value = this.#effective.terminal?.imageWidthCells;
    return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 60;
  }
  setImageWidthCells(value: number): void { this.#setGlobal("terminal", { ...(this.#global.value.terminal ?? {}), imageWidthCells: boundedInteger(value, 60, 1, Number.MAX_SAFE_INTEGER) }, "imageWidthCells"); }
  getClearOnShrink(): boolean { return this.#effective.terminal?.clearOnShrink ?? process.env.RIGYN_CLEAR_ON_SHRINK === "1"; }
  setClearOnShrink(value: boolean): void { this.#setGlobal("terminal", { ...(this.#global.value.terminal ?? {}), clearOnShrink: value }, "clearOnShrink"); }
  getShowTerminalProgress(): boolean { return this.#effective.terminal?.showTerminalProgress ?? false; }
  setShowTerminalProgress(value: boolean): void { this.#setGlobal("terminal", { ...(this.#global.value.terminal ?? {}), showTerminalProgress: value }, "showTerminalProgress"); }
  getImageAutoResize(): boolean { return this.#effective.images?.autoResize ?? true; }
  setImageAutoResize(value: boolean): void { this.#setGlobal("images", { ...(this.#global.value.images ?? {}), autoResize: value }, "autoResize"); }
  getBlockImages(): boolean { return this.#effective.images?.blockImages ?? false; }
  setBlockImages(value: boolean): void { this.#setGlobal("images", { ...(this.#global.value.images ?? {}), blockImages: value }, "blockImages"); }
  getEnabledModels(): string[] | undefined { return this.#effective.enabledModels === undefined ? undefined : [...this.#effective.enabledModels]; }
  setEnabledModels(value: string[] | undefined): void { this.#setGlobal("enabledModels", value === undefined ? undefined : [...value]); }
  getDoubleEscapeAction(): "fork" | "tree" | "none" { return this.#effective.doubleEscapeAction ?? "tree"; }
  setDoubleEscapeAction(value: "fork" | "tree" | "none"): void { this.#setGlobal("doubleEscapeAction", value); }
  getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
    const value = this.#effective.treeFilterMode;
    return value === "no-tools" || value === "user-only" || value === "labeled-only" || value === "all" ? value : "default";
  }
  setTreeFilterMode(value: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void { this.#setGlobal("treeFilterMode", value); }
  getShowHardwareCursor(): boolean { return this.#effective.showHardwareCursor ?? process.env.RIGYN_HARDWARE_CURSOR === "1"; }
  setShowHardwareCursor(value: boolean): void { this.#setGlobal("showHardwareCursor", value); }
  getEditorPaddingX(): number { return boundedInteger(this.#effective.editorPaddingX, 0, 0, 3); }
  setEditorPaddingX(value: number): void { this.#setGlobal("editorPaddingX", boundedInteger(value, 0, 0, 3)); }
  getOutputPad(): 0 | 1 { return this.#effective.outputPad === 0 ? 0 : 1; }
  setOutputPad(value: 0 | 1): void { this.#setGlobal("outputPad", value); }
  getAutocompleteMaxVisible(): number { return boundedInteger(this.#effective.autocompleteMaxVisible, 5, 3, 20); }
  setAutocompleteMaxVisible(value: number): void { this.#setGlobal("autocompleteMaxVisible", boundedInteger(value, 5, 3, 20)); }
  getCodeBlockIndent(): string { return this.#effective.markdown?.codeBlockIndent ?? "  "; }
  getWarnings(): WarningSettings { return { ...(this.#effective.warnings ?? {}) }; }
  setWarnings(value: WarningSettings): void { this.#setGlobal("warnings", { ...value }); }
  getHttpProxy(): string | undefined { return this.#effective.httpProxy; }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function validTimeout(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name} setting: ${String(value)}`);
  return Math.floor(value);
}

function timeoutSetting(value: unknown, fallback: number, name: string): number;
function timeoutSetting(value: unknown, fallback: undefined, name: string): number | undefined;
function timeoutSetting(value: unknown, fallback: number | undefined, name: string): number | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.toLowerCase() === "disabled") return 0;
    if (normalized === "") return fallback;
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`Invalid ${name} setting: ${String(value)}`);
    }
    return Math.floor(numeric);
  }
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name} setting: ${String(value)}`);
  }
  return Math.floor(value);
}
