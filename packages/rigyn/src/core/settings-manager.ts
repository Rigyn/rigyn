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

interface ResolvedRetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  provider: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
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
  xhigh?: number;
  max?: number;
}

export interface MarkdownSettings {
  codeBlockIndent?: string;
}

export interface WarningSettings {
  anthropicExtraUsage?: boolean;
}

export interface ToolSettings {
  enabled?: string[];
  excluded?: string[];
}

export type KeybindingSettings = Record<string, string | string[]>;

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
  tools?: ToolSettings;
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
  keybindings?: KeybindingSettings;
}

type PersistedSetting<T> = T extends readonly unknown[]
  ? T | null
  : T extends object
    ? { [K in keyof T]?: PersistedSetting<T[K]> | null } | null
    : T | null;

/** JSON input accepted by persisted settings APIs. Null inherits the lower-precedence or runtime default. */
export type PersistedSettings = { [K in keyof Settings]?: PersistedSetting<Settings[K]> | null };

const SETTINGS_KEY_MAP = {
  lastChangelogVersion: true,
  defaultProvider: true,
  defaultModel: true,
  defaultThinkingLevel: true,
  transport: true,
  steeringMode: true,
  followUpMode: true,
  theme: true,
  compaction: true,
  branchSummary: true,
  retry: true,
  hideThinkingBlock: true,
  showCacheMissNotices: true,
  externalEditor: true,
  shellPath: true,
  quietStartup: true,
  defaultProjectTrust: true,
  shellCommandPrefix: true,
  npmCommand: true,
  collapseChangelog: true,
  packages: true,
  extensions: true,
  skills: true,
  prompts: true,
  themes: true,
  enableSkillCommands: true,
  tools: true,
  terminal: true,
  images: true,
  enabledModels: true,
  doubleEscapeAction: true,
  treeFilterMode: true,
  thinkingBudgets: true,
  editorPaddingX: true,
  outputPad: true,
  autocompleteMaxVisible: true,
  showHardwareCursor: true,
  markdown: true,
  warnings: true,
  sessionDir: true,
  httpProxy: true,
  httpIdleTimeoutMs: true,
  websocketConnectTimeoutMs: true,
  keybindings: true,
} satisfies Record<keyof Settings, true>;

/** @internal Exact persisted-key inventory used to keep the installed template complete. */
export const SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_KEY_MAP)) as readonly (keyof Settings)[];

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

export interface SettingsReloadOptions {
  validate?(settings: Readonly<Settings>): void | Promise<void>;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeSettingRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const prior = result[key];
    result[key] = isSettingsRecord(value)
      ? mergeSettingRecords(isSettingsRecord(prior) ? prior : {}, value)
      : value;
  }
  return result;
}

function applySettingPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete result[key];
      continue;
    }
    const prior = result[key];
    result[key] = isSettingsRecord(value)
      ? applySettingPatch(isSettingsRecord(prior) ? prior : {}, value)
      : structuredClone(value);
  }
  return result;
}

function mergeSettingPatches(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    const prior = result[key];
    result[key] = isSettingsRecord(value) && isSettingsRecord(prior)
      ? mergeSettingPatches(prior, value)
      : structuredClone(value);
  }
  return result;
}

function mergeSettings(base: Settings, overlay: Settings): Settings {
  return mergeSettingRecords(
    base as Record<string, unknown>,
    overlay as Record<string, unknown>,
  ) as Settings;
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

function omitNullSettings(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return structuredClone(value);
  if (!isSettingsRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const resolved = omitNullSettings(item);
    if (resolved !== undefined) result[key] = resolved;
  }
  return result;
}

function resolveSettings(raw: Record<string, unknown>): Settings {
  return omitNullSettings(migrateSettings(raw)) as Settings;
}

interface ParsedSettings {
  raw: Record<string, unknown>;
  value: Settings;
}

function parseSettings(content: string | undefined): ParsedSettings {
  const parsed: unknown = content === undefined || content === "" ? {} : JSON.parse(content);
  if (!isSettingsRecord(parsed)) throw new Error("Settings must contain a JSON object");
  const raw = structuredClone(parsed);
  return { raw, value: resolveSettings(raw) };
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
  raw: Record<string, unknown>;
  value: Settings;
  loadError: Error | undefined;
}

function emptyScope(): ScopeState {
  return { raw: {}, value: {}, loadError: undefined };
}

export class SettingsManager {
  readonly #storage: SettingsStorage;
  readonly #global: ScopeState;
  readonly #project: ScopeState;
  #effective: Settings;
  #projectTrusted: boolean;
  #writeQueue: Promise<void> = Promise.resolve();
  #errors: SettingsError[] = [];
  #revision = 0;
  #failedWritePatches: Record<SettingsScope, Record<string, unknown>> = { global: {}, project: {} };

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

  static inMemory(settings: PersistedSettings = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
    const storage = new InMemorySettingsStorage();
    storage.withLock("global", () => JSON.stringify(settings, null, 2));
    const manager = SettingsManager.fromStorage(storage, options);
    manager.#global.raw = structuredClone(settings) as Record<string, unknown>;
    manager.#global.value = resolveSettings(manager.#global.raw);
    manager.#recompute();
    return manager;
  }

  #loadScope(scope: SettingsScope): ScopeState {
    let content: string | undefined;
    try {
      this.#storage.withLock(scope, (current) => {
        content = current;
        return undefined;
      });
      return { ...parseSettings(content), loadError: undefined };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#errors.push({ scope, error });
      return { raw: {}, value: {}, loadError: error };
    }
  }

  #recompute(): void {
    this.#effective = mergeSettings(this.#global.value, this.#project.value);
  }

  #save(scope: SettingsScope, patch: Record<string, unknown>): void {
    const state = scope === "global" ? this.#global : this.#project;
    if (state.loadError !== undefined) return;
    const snapshot = structuredClone(patch);
    this.#writeQueue = this.#writeQueue.then(() => {
      if (scope === "project" && !this.#projectTrusted) throw new Error("Project is not trusted");
      const pending = mergeSettingPatches(this.#failedWritePatches[scope], snapshot);
      try {
        this.#storage.withLock(scope, (content) => {
          const disk = parseSettings(content).raw;
          return JSON.stringify(applySettingPatch(disk, pending), null, 2);
        });
        this.#failedWritePatches[scope] = {};
      } catch (error) {
        this.#failedWritePatches[scope] = pending;
        throw error;
      }
    }).catch((cause) => {
      this.#errors.push({ scope, error: cause instanceof Error ? cause : new Error(String(cause)) });
    });
  }

  #setGlobal<K extends keyof Settings>(field: K, value: Settings[K], nested?: string): void {
    const fieldName = String(field);
    this.#global.raw[fieldName] = structuredClone(value);
    this.#global.value = resolveSettings(this.#global.raw);
    this.#revision += 1;
    this.#recompute();
    this.#save("global", nested === undefined
      ? { [fieldName]: structuredClone(value) }
      : { [fieldName]: { [nested]: structuredClone((value as Record<string, unknown>)[nested]) } });
  }

  #setProject<K extends keyof Settings>(field: K, value: Settings[K]): void {
    if (!this.#projectTrusted) throw new Error("Project is not trusted; refusing to write project settings");
    this.#project.raw[String(field)] = structuredClone(value);
    this.#project.value = resolveSettings(this.#project.raw);
    this.#revision += 1;
    this.#recompute();
    this.#save("project", { [String(field)]: structuredClone(value) });
  }

  #updateScope(scope: SettingsScope, patch: PersistedSettings): void {
    if (scope === "project" && !this.#projectTrusted) {
      throw new Error("Project is not trusted; refusing to write project settings");
    }
    const state = scope === "global" ? this.#global : this.#project;
    const rawPatch = mergeSettingRecords({}, patch as Record<string, unknown>);
    state.raw = mergeSettingRecords(state.raw, rawPatch);
    state.value = resolveSettings(state.raw);
    this.#revision += 1;
    this.#recompute();
    this.#save(scope, rawPatch);
  }

  getGlobalSettings(): Settings { return structuredClone(this.#global.value); }
  getProjectSettings(): Settings { return structuredClone(this.#project.value); }
  getSettings(): Settings { return structuredClone(this.#effective); }
  updateGlobalSettings(patch: PersistedSettings): void { this.#updateScope("global", structuredClone(patch)); }
  updateProjectSettings(patch: PersistedSettings): void { this.#updateScope("project", structuredClone(patch)); }
  isProjectTrusted(): boolean { return this.#projectTrusted; }

  setProjectTrusted(trusted: boolean): void {
    if (trusted === this.#projectTrusted) return;
    this.#projectTrusted = trusted;
    this.#revision += 1;
    const replacement = trusted ? this.#loadScope("project") : emptyScope();
    this.#project.raw = replacement.raw;
    this.#project.value = replacement.value;
    this.#project.loadError = replacement.loadError;
    this.#failedWritePatches.project = {};
    this.#recompute();
  }

  async reload(options: SettingsReloadOptions = {}): Promise<void> {
    await this.reloadForTransaction(options);
  }
  /** @internal Reloads settings and returns the committed revision for coordinated rollback. */
  async reloadForTransaction(options: SettingsReloadOptions = {}): Promise<number> {
    await this.flush();
    const revision = this.#revision;
    const global = this.#loadScope("global");
    const project = this.#projectTrusted ? this.#loadScope("project") : emptyScope();
    const nextEffective = mergeSettings(
      global.loadError === undefined ? global.value : this.#global.value,
      !this.#projectTrusted || project.loadError === undefined ? project.value : this.#project.value,
    );
    await options.validate?.(structuredClone(nextEffective));
    if (revision !== this.#revision) {
      throw new Error("Settings changed while reload validation was in progress");
    }
    if (global.loadError === undefined) {
      Object.assign(this.#global, global);
    } else {
      this.#global.loadError = global.loadError;
    }
    this.#failedWritePatches.global = {};
    if (!this.#projectTrusted || project.loadError === undefined) {
      Object.assign(this.#project, project);
    } else {
      this.#project.loadError = project.loadError;
    }
    this.#failedWritePatches.project = {};
    this.#effective = nextEffective;
    this.#revision += 1;
    return this.#revision;
  }

  applyOverrides(overrides: Partial<Settings>): void {
    const resolved = omitNullSettings(structuredClone(overrides)) as Settings;
    this.#effective = mergeSettings(this.#effective, resolved);
    this.#revision += 1;
  }
  async flush(): Promise<void> {
    while (true) {
      const pending = this.#writeQueue;
      await pending;
      if (pending === this.#writeQueue) return;
    }
  }
  /** @internal Captures settled in-memory state for a larger reload transaction. */
  createRollback(): (expectedRevision?: number) => boolean {
    const revision = this.#revision;
    const global = {
      raw: structuredClone(this.#global.raw),
      value: structuredClone(this.#global.value),
      loadError: this.#global.loadError,
    };
    const project = {
      raw: structuredClone(this.#project.raw),
      value: structuredClone(this.#project.value),
      loadError: this.#project.loadError,
    };
    const effective = structuredClone(this.#effective);
    const projectTrusted = this.#projectTrusted;
    const errors = [...this.#errors];
    const failedWritePatches = structuredClone(this.#failedWritePatches);
    let active = true;
    return (expectedRevision = revision) => {
      if (!active) return true;
      active = false;
      if (this.#revision !== expectedRevision) return false;
      Object.assign(this.#global, global);
      Object.assign(this.#project, project);
      this.#effective = effective;
      this.#projectTrusted = projectTrusted;
      this.#errors = errors;
      this.#failedWritePatches = failedWritePatches;
      this.#revision += 1;
      return true;
    };
  }
  drainErrors(): SettingsError[] { const errors = this.#errors; this.#errors = []; return errors; }

  getLastChangelogVersion(): string | undefined { return this.#global.value.lastChangelogVersion; }
  setLastChangelogVersion(value: string): void { this.#setGlobal("lastChangelogVersion", value); }
  getSessionDir(): string | undefined { return this.#effective.sessionDir ? normalizePath(this.#effective.sessionDir) : undefined; }
  getDefaultProvider(): string | undefined { return this.#effective.defaultProvider; }
  getDefaultModel(): string | undefined { return this.#effective.defaultModel; }
  setDefaultProvider(value: string): void { this.#setGlobal("defaultProvider", value); }
  setDefaultModel(value: string): void { this.#setGlobal("defaultModel", value); }
  setDefaultModelAndProvider(provider: string, model: string): void {
    this.#global.raw.defaultProvider = provider;
    this.#global.raw.defaultModel = model;
    this.#global.value = resolveSettings(this.#global.raw);
    this.#revision += 1;
    this.#recompute();
    this.#save("global", { defaultProvider: provider, defaultModel: model });
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
  getRetryEnabled(): boolean { return resolvedRetrySettings(this.#effective.retry).enabled; }
  setRetryEnabled(value: boolean): void {
    this.#setGlobal("retry", { ...(this.#global.value.retry ?? {}), enabled: value }, "enabled");
  }
  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
    const { enabled, maxRetries, baseDelayMs } = resolvedRetrySettings(this.#effective.retry);
    return { enabled, maxRetries, baseDelayMs };
  }
  getHttpIdleTimeoutMs(): number { return timeoutSetting(this.#effective.httpIdleTimeoutMs, 300_000, "httpIdleTimeoutMs"); }
  setHttpIdleTimeoutMs(value: number): void { this.#setGlobal("httpIdleTimeoutMs", validTimeout(value, 0, "httpIdleTimeoutMs")); }
  getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
    return resolvedRetrySettings(this.#effective.retry).provider;
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
  getToolSettings(): ToolSettings {
    const value = this.#effective.tools;
    if (value === undefined) return {};
    if (!isSettingsRecord(value)) throw new Error("tools must be an object or null");
    const toolNames = (name: "enabled" | "excluded"): string[] | undefined => {
      const entries = value[name];
      if (entries === undefined) return undefined;
      if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
        throw new Error(`tools.${name} must be an array of non-empty tool names or null`);
      }
      return [...new Set(entries as string[])];
    };
    const enabled = toolNames("enabled");
    const excluded = toolNames("excluded");
    return {
      ...(enabled === undefined ? {} : { enabled }),
      ...(excluded === undefined ? {} : { excluded }),
    };
  }
  getKeybindings(): KeybindingSettings {
    return structuredClone(this.#effective.keybindings ?? {});
  }
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

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function optionalNonNegativeInteger(
  value: unknown,
  fallback: number | undefined,
  name: string,
  maximum: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid ${name} setting: ${String(value)}`);
  }
  return value as number;
}

function resolvedRetrySettings(value: unknown): ResolvedRetrySettings {
  if (value !== undefined && !isSettingsRecord(value)) throw new Error("retry must be an object or null");
  const retry = value ?? {};
  const enabled = retry.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error(`Invalid retry.enabled setting: ${String(enabled)}`);
  const maxRetries = optionalNonNegativeInteger(
    retry.maxRetries,
    3,
    "retry.maxRetries",
    Number.MAX_SAFE_INTEGER - 1,
  )!;
  const baseDelayMs = optionalNonNegativeInteger(
    retry.baseDelayMs,
    2_000,
    "retry.baseDelayMs",
    MAX_TIMER_DELAY_MS,
  )!;
  const providerValue = retry.provider;
  if (providerValue !== undefined && !isSettingsRecord(providerValue)) {
    throw new Error("retry.provider must be an object or null");
  }
  const provider = providerValue ?? {};
  const timeoutMs = optionalNonNegativeInteger(
    provider.timeoutMs,
    undefined,
    "retry.provider.timeoutMs",
    MAX_TIMER_DELAY_MS,
  );
  const providerMaxRetries = optionalNonNegativeInteger(
    provider.maxRetries,
    undefined,
    "retry.provider.maxRetries",
    Number.MAX_SAFE_INTEGER - 1,
  );
  const maxRetryDelayMs = optionalNonNegativeInteger(
    provider.maxRetryDelayMs,
    60_000,
    "retry.provider.maxRetryDelayMs",
    MAX_TIMER_DELAY_MS,
  )!;
  return {
    enabled,
    maxRetries,
    baseDelayMs,
    provider: {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(providerMaxRetries === undefined ? {} : { maxRetries: providerMaxRetries }),
      maxRetryDelayMs,
    },
  };
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
