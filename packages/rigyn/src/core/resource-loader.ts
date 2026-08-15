import {
	existsSync,
	opendirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PromptCompositionSource } from "./types.js";
import type { EventBus } from "./event-bus.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { promptCompositionSource } from "./prompt-composition.js";
import { loadPromptTemplates, type PromptTemplate } from "./prompt-templates.js";
import {
	DEFAULT_TRUSTED_RESOURCE_FILE_BYTES,
	readTrustedFileSnapshotSync,
	readTrustedTextFileSync,
	trustedResourceFileLimit,
	TrustedResourceFileChangedError,
	TrustedResourceFileLimitError,
} from "./resource-file.js";
import { SettingsManager } from "./settings-manager.js";
import { loadSkills, type Skill } from "./skills.js";
import {
	DefaultPackageManager,
	type PackageActivationCandidate,
	type PathMetadata,
	type ResolvedPaths,
} from "./package-manager.js";
import {
	appendDirectExtensions,
	loadDirectExtensions,
	RuntimeExtensionHost,
	type RuntimeDirectPathMetadata,
	type RuntimeInlineExtension,
} from "../extensions/runtime.js";
import {
	getExtensionRuntimeHost,
	projectLoadedExtensionHost,
} from "../extensions/compat.js";
import type { ExtensionRuntime, LoadExtensionsResult } from "../extensions/direct.js";
import { loadThemes } from "../extensions/loose-resources.js";
import type { ExtensionTheme } from "../extensions/types.js";
import {
	ProjectPackageManager,
	projectPackageDeclaredResourceMetadata,
	projectPackageDirectMetadata,
	projectPackageResourceSources,
	type InstalledProjectPackage,
	type ProjectPackageCatalogEntry,
} from "../extensions/project-packages.js";
import { resolvePath } from "../utils/paths.js";
import { findNestedGitWorktree } from "../context/git-worktree.js";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.js";

export interface ResourceExtensionPaths {
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderRefreshOptions {
	preparedSettings?: SettingsManager;
	prepareExtensions?: (extensionsResult: ResourceExtensionsResult) => void | (() => void);
	resolveProjectTrust?: (input: { extensionsResult: ResourceExtensionsResult }) => Promise<boolean>;
	signal?: AbortSignal;
}

export type ResourceExtensionsResult = LoadExtensionsResult;

interface AgentFilesView { agentsFiles: Array<{ path: string; content: string }> }

interface ResourceLoaderSkillCatalog {
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
}

interface ResourceLoaderPromptCatalog {
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
}

interface ResourceLoaderThemeCatalog {
  getThemes(): { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] };
}

interface ResourceLoaderPromptSources {
  getSystemPrompt(): string | undefined;
  getSystemPromptSource?(): { path: string } | undefined;
  getAppendSystemPrompt(): string[];
  getAppendSystemPromptSources?(): Array<{ path: string }>;
}

interface ResourceLoaderProjectState {
  getAgentsFiles(): AgentFilesView;
  getPromptCompositionSources?(): PromptCompositionSource[];
  getProjectPackageState?(): { packages: InstalledProjectPackage[]; catalog: ProjectPackageCatalogEntry[] };
}

export interface ResourceLoader
  extends ResourceLoaderSkillCatalog,
    ResourceLoaderPromptCatalog,
    ResourceLoaderThemeCatalog,
    ResourceLoaderPromptSources,
    ResourceLoaderProjectState {
  readonly supportsTransactionalRefresh?: true;
  readonly settingsManager?: SettingsManager;
  getExtensions(): ResourceExtensionsResult;
  extendResources(paths: ResourceExtensionPaths): void;
  extendResourcesFromExtensions?(runtime: ExtensionRuntime, reason: "startup" | "refresh", signal?: AbortSignal): Promise<void>;
  refresh(options?: ResourceLoaderRefreshOptions): Promise<void>;
}

export interface DefaultResourceLoaderOptions {
	agentDir: string;
	additionalExtensionPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalSkillPaths?: string[];
	additionalThemePaths?: string[];
	agentsFilesOverride?: (base: AgentFilesView) => AgentFilesView;
	appendSystemPrompt?: string[];
	appendSystemPromptOverride?: (base: string[]) => string[];
	cwd: string;
	eventBus?: EventBus;
	extensionFactories?: RuntimeInlineExtension[];
	extensionsOverride?: (base: ResourceExtensionsResult) => ResourceExtensionsResult;
	preparedExtensions?: RuntimeExtensionHost;
	noContextFiles?: boolean;
	noExtensions?: boolean;
	noPromptTemplates?: boolean;
	noSkills?: boolean;
	noThemes?: boolean;
	offline?: boolean;
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	settingsManager?: SettingsManager;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	systemPrompt?: string;
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	trustedResourceMaxBytes?: number;
	themesOverride?: (base: { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] }) => { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] };
}

const CONTEXT_NAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
] as const;
const CONTEXT_DISCOVERY_MAX_ENTRIES = 10_000;

function contextCandidates(directory: string): string[][] {
	const names: string[] = [];
	try {
		const handle = opendirSync(directory);
		try {
			let entries = 0;
			for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
				entries += 1;
				if (entries > CONTEXT_DISCOVERY_MAX_ENTRIES) {
					console.error(`Instruction discovery exceeds ${CONTEXT_DISCOVERY_MAX_ENTRIES} directory entries: ${directory}`);
					return CONTEXT_NAMES.map(() => []);
				}
				if (CONTEXT_NAMES.some((candidate) => candidate.toLowerCase() === entry.name.toLowerCase())) {
					names.push(entry.name);
				}
			}
		} finally {
			handle.closeSync();
		}
	} catch { return CONTEXT_NAMES.map(() => []); }
	return CONTEXT_NAMES.map((preferred) => names
		.filter((name) => name.toLowerCase() === preferred.toLowerCase())
		.sort((left, right) => left === preferred ? -1 : right === preferred ? 1 : left.localeCompare(right))
		.map((name) => join(directory, name)));
}

function contextFromDirectory(
	directory: string,
	maximum: number,
	warned: Set<string>,
): { path: string; content: string } | undefined {
	for (const group of contextCandidates(directory)) {
		for (const path of group) {
			let canonical: string;
			try { canonical = realpathSync(path); } catch { continue; }
			try {
				const snapshot = readTrustedFileSnapshotSync(canonical, maximum, "Instruction file");
				return { path, content: snapshot.data.toString("utf8") };
			} catch (error) {
				if (error instanceof TrustedResourceFileLimitError) {
					const identity = error.information === undefined
						? canonical
						: `${error.information.dev}:${error.information.ino}`;
					if (!warned.has(identity)) {
						warned.add(identity);
						console.error(`Instruction file exceeds ${maximum} bytes: ${path}`);
					}
				} else if (error instanceof TrustedResourceFileChangedError) {
					console.error(error.message);
				}
			}
		}
	}
	return undefined;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	maxFileBytes?: number;
}): Array<{ path: string; content: string }> {
	const maximum = trustedResourceFileLimit(options.maxFileBytes);
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir);
	const directories: string[] = [];
	for (let cursor = cwd; ; cursor = dirname(cursor)) {
		directories.unshift(cursor);
		if (dirname(cursor) === cursor) break;
	}
	const warned = new Set<string>();
	const result: Array<{ path: string; content: string }> = [];
	const worktree = findNestedGitWorktree(cwd);
	const localWorktreeInstruction = worktree === undefined
		? undefined
		: contextFromDirectory(worktree.worktreeRoot, maximum, warned);
	const shadowedMainInstruction = worktree === undefined || localWorktreeInstruction === undefined
		? undefined
		: resolve(worktree.mainRoot, basename(localWorktreeInstruction.path));
	for (const directory of [agentDir, ...directories.filter((entry) => entry !== agentDir)]) {
		const selected = contextFromDirectory(directory, maximum, warned);
		if (selected !== undefined && selected.content !== "" && resolve(selected.path) !== shadowedMainInstruction) result.push(selected);
	}
	return result;
}

type ResourcePath = { path: string; metadata: PathMetadata };

interface ResourceViews {
	skills: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	prompts: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	themes: { themes: ExtensionTheme[]; diagnostics: ResourceDiagnostic[] };
}

interface PromptViews {
	systemPrompt?: string;
	systemPromptSource?: { path: string };
	appendSystemPrompt: string[];
	appendSystemPromptSources: Array<{ path: string }>;
	promptCompositionSources: PromptCompositionSource[];
}

interface Generation extends ResourceViews, PromptViews {
	extensions: ResourceExtensionsResult;
	agentsFiles: AgentFilesView;
	projectPackages: { packages: InstalledProjectPackage[]; catalog: ProjectPackageCatalogEntry[] };
}

function emptyExtensionResult(cwd: string, agentDir: string): ResourceExtensionsResult {
	return projectLoadedExtensionHost(new RuntimeExtensionHost(cwd, {
		dataRoot: join(agentDir, "state", "extension-data"),
		projectTrusted: false,
	}));
}

function emptyGeneration(cwd: string, agentDir: string): Generation {
	return {
		extensions: emptyExtensionResult(cwd, agentDir),
		skills: { skills: [], diagnostics: [] },
		prompts: { prompts: [], diagnostics: [] },
		themes: { themes: [], diagnostics: [] },
		agentsFiles: { agentsFiles: [] },
		appendSystemPrompt: [],
		appendSystemPromptSources: [],
		promptCompositionSources: [],
		projectPackages: { packages: [], catalog: [] },
	};
}

function inside(root: string, path: string): boolean {
	const local = relative(resolve(root), resolve(path));
	return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function sourceInfo(path: string, metadata: PathMetadata) {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		...(metadata.baseDir === undefined ? {} : { baseDir: metadata.baseDir }),
	};
}

function owner(path: string, paths: readonly ResourcePath[]): ResourcePath | undefined {
	let canonical: string;
	try { canonical = realpathSync(path); } catch { canonical = resolve(path); }
	return paths.find((entry) => {
		const requested = resolvePath(entry.path);
		let candidate: string;
		try { candidate = realpathSync(requested); } catch { candidate = requested; }
		return candidate === canonical || inside(candidate, canonical);
	});
}

function normalizePaths(paths: readonly ResourcePath[]): ResourcePath[] {
	return paths.map((entry) => ({ ...entry, path: resolvePath(entry.path) }));
}

function additionalPaths(
	values: readonly string[] | undefined,
): ResourcePath[] {
	return (values ?? []).map((path) => {
		const selected = resolvePath(path);
		let baseDir = dirname(selected);
		try { if (statSync(selected).isDirectory()) baseDir = selected; } catch { /* Missing is diagnosed later. */ }
		return {
			path: selected,
			metadata: { source: path, scope: "temporary", origin: "top-level", baseDir },
		};
	});
}

function selectedPaths(resources: ResolvedPaths, type: keyof ResolvedPaths): ResourcePath[] {
	return resources[type]
		.filter((entry) => entry.enabled)
		.map((entry) => ({ path: entry.path, metadata: entry.metadata }));
}

function missingDiagnostics(
	paths: readonly ResourcePath[],
	message: string,
): ResourceDiagnostic[] {
	return paths.flatMap((entry) => existsSync(entry.path) ? [] : [{ type: "error" as const, message, path: entry.path }]);
}

function applySkillSources(skills: Skill[], paths: readonly ResourcePath[]): Skill[] {
	return skills.map((skill) => {
		const selected = owner(skill.filePath, paths);
		return selected === undefined ? skill : { ...skill, sourceInfo: sourceInfo(skill.filePath, selected.metadata) };
	});
}

function loadPromptView(paths: readonly ResourcePath[], cwd: string, agentDir: string, maximum: number): ResourceViews["prompts"] {
	const prompts: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const names = new Map<string, PromptTemplate>();
	for (const requested of paths) {
		if (!existsSync(requested.path)) continue;
		const localDiagnostics: ResourceDiagnostic[] = [];
		const loaded = loadPromptTemplates({
			cwd,
			agentDir,
			promptPaths: [requested.path],
			includeDefaults: false,
			maxFileBytes: maximum,
			diagnostics: localDiagnostics,
		});
		diagnostics.push(...localDiagnostics);
		for (const prompt of loaded) {
			const declared = requested.metadata.declaredResources;
			const disabled = new Set(requested.metadata.disabledDeclaredResources ?? []);
			const selected: PromptTemplate[] = declared === undefined
				? [{ ...prompt, sourceInfo: sourceInfo(prompt.filePath, requested.metadata) }]
				: declared
					.filter((entry) => (entry.kind === "prompt" || entry.kind === "command")
						&& !disabled.has(`${entry.kind}:${entry.name}`))
					.map((entry) => ({
						name: entry.name,
						content: prompt.content,
						filePath: prompt.filePath,
						sourceInfo: sourceInfo(prompt.filePath, requested.metadata),
						...(entry.description === undefined ? {} : { description: entry.description }),
						...(entry.argumentHint === undefined ? {} : { argumentHint: entry.argumentHint }),
					}));
			for (const candidate of selected) {
				const prior = names.get(candidate.name);
				if (prior !== undefined) {
					diagnostics.push({
						type: "collision",
						message: `Prompt ${candidate.name} collides with ${prior.filePath}`,
						path: candidate.filePath,
						collision: {
							name: candidate.name,
							winnerPath: prior.filePath,
							loserPath: candidate.filePath,
							resourceType: "prompt",
						},
					});
					continue;
				}
				names.set(candidate.name, candidate);
				prompts.push(candidate);
			}
		}
	}
	return { prompts, diagnostics };
}

async function loadThemeView(paths: readonly ResourcePath[], maximum: number): Promise<ResourceViews["themes"]> {
	const themes: ExtensionTheme[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const names = new Map<string, ExtensionTheme>();
	for (const requested of paths) {
		if (!existsSync(requested.path)) continue;
		try {
			for (const theme of await loadThemes([requested.path], { maxFileBytes: maximum })) {
				const declared = requested.metadata.declaredResources;
				const disabled = new Set(requested.metadata.disabledDeclaredResources ?? []);
				const selected: ExtensionTheme[] = declared === undefined
					? [{ ...theme, ...(requested.metadata.extensionId === undefined ? {} : { extensionId: requested.metadata.extensionId }) }]
					: declared
						.filter((entry) => entry.kind === "theme" && !disabled.has(`theme:${entry.name}`))
						.map((entry) => ({
							...theme,
							name: entry.name,
							extensionId: requested.metadata.extensionId ?? theme.extensionId,
							...(entry.description === undefined ? {} : { description: entry.description }),
						}));
				for (const candidate of selected) {
					const prior = names.get(candidate.name);
					if (prior !== undefined) {
						diagnostics.push({
							type: "collision",
							message: `Theme ${candidate.name} collides with ${prior.sourcePath}`,
							path: candidate.sourcePath,
							collision: { name: candidate.name, winnerPath: prior.sourcePath, loserPath: candidate.sourcePath, resourceType: "theme" },
						});
						continue;
					}
					names.set(candidate.name, candidate);
					themes.push(candidate);
				}
			}
		} catch (error) {
			diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : "Theme is invalid", path: requested.path });
		}
	}
	return { themes, diagnostics };
}

async function loadResourceViews(
	paths: { skills: ResourcePath[]; prompts: ResourcePath[]; themes: ResourcePath[] },
	options: { cwd: string; agentDir: string; maximum: number },
): Promise<ResourceViews> {
	const normalized = {
		skills: normalizePaths(paths.skills),
		prompts: normalizePaths(paths.prompts),
		themes: normalizePaths(paths.themes),
	};
	const loadedSkills = loadSkills({
		cwd: options.cwd,
		agentDir: options.agentDir,
		skillPaths: normalized.skills.filter((entry) => existsSync(entry.path)).map((entry) => entry.path),
		includeDefaults: false,
		maxFileBytes: options.maximum,
		strictSkillRoots: new Map(normalized.skills.flatMap((entry) => entry.metadata.skillValidation === undefined
			? []
			: [[resolve(entry.path), entry.metadata.skillValidation.root] as const])),
	});
	const loadedPrompts = loadPromptView(normalized.prompts, options.cwd, options.agentDir, options.maximum);
	const loadedThemes = await loadThemeView(normalized.themes, options.maximum);
	return {
		skills: {
			skills: applySkillSources(loadedSkills.skills, normalized.skills),
			diagnostics: [
				...loadedSkills.diagnostics,
				...missingDiagnostics(normalized.skills, "Configured skill path was not found"),
			],
		},
		prompts: {
			...loadedPrompts,
			diagnostics: [
				...loadedPrompts.diagnostics,
				...missingDiagnostics(normalized.prompts, "Configured prompt template was not found"),
			],
		},
		themes: {
			...loadedThemes,
			diagnostics: [
				...loadedThemes.diagnostics,
				...missingDiagnostics(normalized.themes, "Configured theme path was not found"),
			],
		},
	};
}

function readPromptFile(path: string, maximum: number): string {
	return readTrustedTextFileSync(path, maximum, "Prompt file");
}

function promptViews(options: DefaultResourceLoaderOptions, settings: SettingsManager, maximum: number): PromptViews {
	const trusted = settings.isProjectTrusted();
	let systemPrompt: string | undefined;
	let systemPromptSource: { path: string } | undefined;
	const systemSources: PromptCompositionSource[] = [];
	const appendSources: PromptCompositionSource[] = [];
	if (options.systemPrompt !== undefined) {
		if (existsSync(options.systemPrompt)) {
			try {
				systemPrompt = readPromptFile(options.systemPrompt, maximum);
				systemPromptSource = { path: options.systemPrompt };
				systemSources.push(promptCompositionSource("system_prompt", options.systemPrompt, systemPrompt));
			} catch (error) {
				console.error(error instanceof Error ? error.message : "Prompt file could not be read");
				systemPrompt = options.systemPrompt;
				systemSources.push(promptCompositionSource("system_prompt", "inline:system-prompt", systemPrompt));
			}
		} else {
			systemPrompt = options.systemPrompt;
		systemSources.push(promptCompositionSource("system_prompt", "inline:system-prompt", systemPrompt));
		}
	} else {
		const candidates = [
			...(trusted ? [join(options.cwd, ".rigyn", "SYSTEM.md")] : []),
			join(options.agentDir, "SYSTEM.md"),
		];
		for (const path of candidates) {
			if (!existsSync(path)) continue;
			try {
				systemPrompt = readPromptFile(path, maximum);
				systemPromptSource = { path };
				systemSources.push(promptCompositionSource("system_prompt", path, systemPrompt));
				break;
			} catch (error) { console.error(error instanceof Error ? error.message : "Prompt file could not be read"); }
		}
	}
	const appendSystemPrompt: string[] = [];
	const appendSystemPromptSources: Array<{ path: string }> = [];
	for (const path of [join(options.agentDir, "APPEND_SYSTEM.md"), ...(trusted ? [join(options.cwd, ".rigyn", "APPEND_SYSTEM.md")] : [])]) {
		if (!existsSync(path)) continue;
		try {
			const content = readPromptFile(path, maximum);
			appendSystemPrompt.push(content);
			appendSystemPromptSources.push({ path });
			appendSources.push(promptCompositionSource("append_system_prompt", path, content));
		} catch (error) { console.error(error instanceof Error ? error.message : "Prompt file could not be read"); }
	}
	for (const [index, content] of (options.appendSystemPrompt ?? []).entries()) {
		appendSystemPrompt.push(content);
		appendSources.push(promptCompositionSource("append_system_prompt", `inline:append-system-prompt:${index + 1}`, content));
	}
	const baseSystem = systemPrompt;
	if (options.systemPromptOverride !== undefined) {
		systemPrompt = options.systemPromptOverride(systemPrompt);
		if (systemPrompt !== baseSystem && systemPrompt !== undefined) {
			systemSources.push(promptCompositionSource("system_prompt", "override:system-prompt", systemPrompt));
		}
	}
	const baseAppendLength = appendSystemPrompt.length;
	const selectedAppend = options.appendSystemPromptOverride?.([...appendSystemPrompt]) ?? appendSystemPrompt;
	for (let index = baseAppendLength; index < selectedAppend.length; index += 1) {
		appendSources.push(promptCompositionSource("append_system_prompt", `override:append-system-prompt:${index + 1}`, selectedAppend[index]!));
	}
	return {
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(systemPromptSource === undefined ? {} : { systemPromptSource }),
		appendSystemPrompt: selectedAppend,
		appendSystemPromptSources,
		promptCompositionSources: [...systemSources, ...appendSources],
	};
}

function extensionMetadata(paths: readonly ResourcePath[], trusted: boolean): Map<string, RuntimeDirectPathMetadata> {
	const result = new Map<string, RuntimeDirectPathMetadata>();
	for (const item of paths) {
		result.set(item.path, {
			scope: item.metadata.scope,
			trusted: item.metadata.scope !== "project" || trusted,
			...(item.metadata.baseDir === undefined ? {} : { resourceRoot: item.metadata.baseDir }),
			...(item.metadata.extensionId === undefined ? {} : { extensionId: item.metadata.extensionId }),
		});
	}
	return result;
}

function projectedExtensions(
	host: RuntimeExtensionHost,
	paths: readonly ResourcePath[],
): ResourceExtensionsResult {
	const projection = projectLoadedExtensionHost(host, new Map(paths.map((entry) => [realpathSync(entry.path), {
		path: entry.path,
		sourceInfo: sourceInfo(entry.path, entry.metadata),
	}])));
	const errors = host.diagnostics().flatMap((diagnostic) => {
		const path = paths.find((entry) => resolve(entry.path) === resolve(diagnostic.sourcePath))?.path;
		return path === undefined ? [] : [{ path, error: diagnostic.message }];
	});
	return { ...projection, errors };
}

function mergeNamedResources<T extends { name: string }>(
	current: readonly T[],
	discovered: readonly T[],
	type: "skill" | "prompt" | "theme",
	path: (item: T) => string,
): { items: T[]; diagnostics: ResourceDiagnostic[] } {
	const items = [...current];
	const names = new Map(items.map((item) => [item.name, item]));
	const diagnostics: ResourceDiagnostic[] = [];
	for (const item of discovered) {
		const winner = names.get(item.name);
		if (winner !== undefined) {
			diagnostics.push({
				type: "collision",
				message: `${type} ${item.name} conflicts with an existing resource`,
				path: path(item),
				collision: {
					name: item.name,
					winnerPath: path(winner),
					loserPath: path(item),
					resourceType: type,
				},
			});
			continue;
		}
		names.set(item.name, item);
		items.push(item);
	}
	return { items, diagnostics };
}

export class DefaultResourceLoader implements ResourceLoader {
	readonly supportsTransactionalRefresh = true as const;
	readonly #options: DefaultResourceLoaderOptions;
	readonly #maximum: number;
	#settings: SettingsManager;
	#generation: Generation;
	#preparedHost: RuntimeExtensionHost | undefined;

	constructor(options: DefaultResourceLoaderOptions) {
		this.#options = { ...options, cwd: resolve(options.cwd), agentDir: resolve(options.agentDir) };
		this.#maximum = trustedResourceFileLimit(options.trustedResourceMaxBytes ?? DEFAULT_TRUSTED_RESOURCE_FILE_BYTES);
		this.#settings = options.settingsManager ?? SettingsManager.create(this.#options.cwd, this.#options.agentDir);
		this.#generation = emptyGeneration(this.#options.cwd, this.#options.agentDir);
		this.#preparedHost = options.preparedExtensions;
	}

	get settingsManager(): SettingsManager { return this.#settings; }

	getExtensions(): ResourceExtensionsResult { return this.#generation.extensions; }
	getSkills(): Generation["skills"] { return this.#generation.skills; }
	getPrompts(): Generation["prompts"] { return this.#generation.prompts; }
	getThemes(): Generation["themes"] { return this.#generation.themes; }
	getAgentsFiles(): AgentFilesView { return this.#generation.agentsFiles; }
	getSystemPrompt(): string | undefined { return this.#generation.systemPrompt; }
	getSystemPromptSource(): { path: string } | undefined { return this.#generation.systemPromptSource; }
	getAppendSystemPrompt(): string[] { return [...this.#generation.appendSystemPrompt]; }
	getAppendSystemPromptSources(): Array<{ path: string }> { return this.#generation.appendSystemPromptSources.map((entry) => ({ ...entry })); }
	getPromptCompositionSources(): PromptCompositionSource[] { return this.#generation.promptCompositionSources.map((entry) => ({ ...entry })); }
	getProjectPackageState(): Generation["projectPackages"] { return this.#generation.projectPackages; }

	async #loadExtensions(
		paths: ResourcePath[],
		options: ResourceLoaderRefreshOptions,
		trusted: boolean,
		projectMetadata?: ReadonlyMap<string, RuntimeDirectPathMetadata>,
	): Promise<ResourceExtensionsResult> {
		const enabled = this.#options.noExtensions === true ? [] : paths.filter((entry) => existsSync(entry.path));
		const metadata = extensionMetadata(enabled, trusted);
		for (const [path, selected] of projectMetadata ?? []) {
			metadata.set(path, { ...metadata.get(path), ...selected });
		}
		let host = this.#preparedHost;
		this.#preparedHost = undefined;
		const preparedPaths = new Set(host?.extensions().map((entry) => entry.sourcePath) ?? []);
		const userPaths = enabled.filter((entry) => entry.metadata.scope !== "project" && !preparedPaths.has(resolve(entry.path)));
		const projectPaths = enabled.filter((entry) => entry.metadata.scope === "project" && !preparedPaths.has(resolve(entry.path)));
		if (host === undefined) {
			host = await loadDirectExtensions(
				options.resolveProjectTrust === undefined ? enabled.map((entry) => entry.path) : userPaths.map((entry) => entry.path),
				{
					workspace: this.#options.cwd,
					dataRoot: join(this.#options.agentDir, "state", "extension-data"),
					projectTrusted: trusted,
					inlineExtensions: this.#options.extensionFactories ?? [],
					directPathMetadata: metadata,
					...(this.#options.eventBus === undefined ? {} : { eventBus: this.#options.eventBus }),
					...(options.signal === undefined ? {} : { signal: options.signal }),
				},
			);
		} else if (userPaths.length > 0) {
			await appendDirectExtensions(host, userPaths.map((entry) => entry.path), {
				workspace: this.#options.cwd,
				projectTrusted: trusted,
				directPathMetadata: metadata,
				...(this.#options.eventBus === undefined ? {} : { eventBus: this.#options.eventBus }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		}
		let result = projectedExtensions(host, enabled);
		if (options.resolveProjectTrust !== undefined) {
			const accepted = await options.resolveProjectTrust({ extensionsResult: result });
			if (accepted && projectPaths.length > 0) {
				await appendDirectExtensions(host, projectPaths.map((entry) => entry.path), {
					workspace: this.#options.cwd,
					projectTrusted: true,
					directPathMetadata: metadata,
					...(this.#options.eventBus === undefined ? {} : { eventBus: this.#options.eventBus }),
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
				host.reorderCommittedExtensions(enabled.map((entry) => entry.path));
				result = projectedExtensions(host, enabled);
			}
		}
		return result;
	}

	async loadProjectTrustExtensions(): Promise<ResourceExtensionsResult> {
		this.#settings.setProjectTrusted(false);
		const packages = new DefaultPackageManager({
			cwd: this.#options.cwd,
			agentDir: this.#options.agentDir,
			settingsManager: this.#settings,
			...(this.#options.offline === undefined ? {} : { offline: this.#options.offline }),
		});
		const resolved = await packages.resolve(async () => "skip");
		const paths = [
			...selectedPaths(resolved, "extensions").filter((entry) => entry.metadata.scope !== "project"),
			...additionalPaths(this.#options.additionalExtensionPaths),
		];
		return await this.#loadExtensions(paths, {}, false);
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const requested = {
			skills: normalizePaths(paths.skillPaths ?? []),
			prompts: normalizePaths(paths.promptPaths ?? []),
			themes: normalizePaths(paths.themePaths ?? []),
		};
		const skills = loadSkills({
			cwd: this.#options.cwd,
			agentDir: this.#options.agentDir,
			skillPaths: requested.skills.map((entry) => entry.path),
			includeDefaults: false,
			maxFileBytes: this.#maximum,
		});
		this.#generation.skills = {
			skills: [...this.#generation.skills.skills, ...applySkillSources(skills.skills, requested.skills)],
			diagnostics: [...this.#generation.skills.diagnostics, ...skills.diagnostics],
		};
		const prompts = loadPromptView(requested.prompts, this.#options.cwd, this.#options.agentDir, this.#maximum);
		this.#generation.prompts = {
			prompts: [...this.#generation.prompts.prompts, ...prompts.prompts],
			diagnostics: [...this.#generation.prompts.diagnostics, ...prompts.diagnostics],
		};
		void loadThemeView(requested.themes, this.#maximum).then((themes) => {
			this.#generation.themes = {
				themes: [...this.#generation.themes.themes, ...themes.themes],
				diagnostics: [...this.#generation.themes.diagnostics, ...themes.diagnostics],
			};
		});
	}

	async extendResourcesFromExtensions(runtime: ExtensionRuntime, reason: "startup" | "refresh", signal?: AbortSignal): Promise<void> {
		const host = getExtensionRuntimeHost(runtime);
		if (host === undefined || host !== getExtensionRuntimeHost(this.#generation.extensions.runtime)) {
			throw new Error("Extension resources belong to a stale runtime generation");
		}
		const discovered = await host.discoverResources(reason, signal);
		const convert = (entry: (typeof discovered.skillPaths)[number]): ResourcePath | undefined => {
			const path = isAbsolute(entry.path) ? resolve(entry.path) : resolve(entry.resourceRoot, entry.path);
			if (!inside(entry.resourceRoot, path)) {
				host.addDiagnostic({ extensionId: entry.extensionId, sourcePath: entry.sourcePath, message: `Runtime resource path was ignored because it escapes workspace: ${entry.path}` });
				return undefined;
			}
			return {
				path,
				metadata: {
					source: entry.sourcePath,
					scope: entry.scope === "project" ? "project" : entry.scope === "invocation" ? "temporary" : "user",
					origin: "package",
					baseDir: entry.resourceRoot,
				},
			};
		};
		const selected = {
			skills: discovered.skillPaths.map(convert).filter((entry): entry is ResourcePath => entry !== undefined),
			prompts: discovered.promptPaths.map(convert).filter((entry): entry is ResourcePath => entry !== undefined),
			themes: discovered.themePaths.map(convert).filter((entry): entry is ResourcePath => entry !== undefined),
		};
		const views = await loadResourceViews(selected, { cwd: this.#options.cwd, agentDir: this.#options.agentDir, maximum: this.#maximum });
		const skills = mergeNamedResources(
			this.#generation.skills.skills,
			views.skills.skills,
			"skill",
			(skill) => skill.filePath,
		);
		const prompts = mergeNamedResources(
			this.#generation.prompts.prompts,
			views.prompts.prompts,
			"prompt",
			(prompt) => prompt.filePath,
		);
		const themes = mergeNamedResources(
			this.#generation.themes.themes,
			views.themes.themes,
			"theme",
			(theme) => theme.sourcePath,
		);
		this.#generation.skills = {
			skills: skills.items,
			diagnostics: [...this.#generation.skills.diagnostics, ...views.skills.diagnostics, ...skills.diagnostics],
		};
		this.#generation.prompts = {
			prompts: prompts.items,
			diagnostics: [...this.#generation.prompts.diagnostics, ...views.prompts.diagnostics, ...prompts.diagnostics],
		};
		this.#generation.themes = {
			themes: themes.items,
			diagnostics: [...this.#generation.themes.diagnostics, ...views.themes.diagnostics, ...themes.diagnostics],
		};
	}

	async refresh(options: ResourceLoaderRefreshOptions = {}): Promise<void> {
		options.signal?.throwIfAborted();
		const settings = options.preparedSettings ?? this.#settings;
		if (options.preparedSettings === undefined) {
			await settings.refresh();
			settings.getToolSettings();
			settings.getRetrySettings();
			settings.getProviderRetrySettings();
		}
		const packageManager = new DefaultPackageManager({
			cwd: this.#options.cwd,
			agentDir: this.#options.agentDir,
			settingsManager: settings,
			...(this.#options.offline === undefined ? {} : { offline: this.#options.offline }),
			activateCandidate: async (candidate: PackageActivationCandidate) => {
				const paths = candidate.resources.extensions.filter((entry) => entry.enabled);
				const host = await loadDirectExtensions(paths.map((entry) => entry.path), {
					workspace: candidate.workspace,
					dataRoot: candidate.dataRoot,
					projectTrusted: candidate.projectTrusted,
					directPathMetadata: extensionMetadata(paths.map((entry) => ({ path: entry.path, metadata: entry.metadata })), candidate.projectTrusted),
					activationFailure: "throw",
					...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
				});
				await host.close();
			},
		});
		let projectPackages = { packages: [] as InstalledProjectPackage[], catalog: [] as ProjectPackageCatalogEntry[] };
		let projectDirectMetadata: Map<string, RuntimeDirectPathMetadata> | undefined;
		let resolved = await packageManager.resolve();
		if (settings.isProjectTrusted()) {
			const configuredNpm = settings.getNpmCommand();
			const reconciled = await new ProjectPackageManager({
				workspace: this.#options.cwd,
				projectTrusted: true,
				...(configuredNpm === undefined || configuredNpm.length === 0 ? {} : {
					commands: { npm: { command: configuredNpm[0]!, prefix: configuredNpm.slice(1) } },
				}),
				...(this.#options.offline === undefined ? {} : { offline: this.#options.offline }),
			}).reconcile(options.signal);
			projectPackages = { packages: reconciled.packages, catalog: reconciled.catalog };
			const sources = projectPackageResourceSources(reconciled.packages, reconciled.catalog);
			if (sources.length > 0) {
				const declared = projectPackageDeclaredResourceMetadata(
					await packageManager.resolveExtensionSources(sources, { local: true }),
					reconciled.packages,
					reconciled.catalog,
				);
				projectDirectMetadata = projectPackageDirectMetadata(declared, reconciled.packages, reconciled.catalog);
				resolved = {
					extensions: [...declared.extensions, ...resolved.extensions],
					skills: [...declared.skills, ...resolved.skills],
					prompts: [...declared.prompts, ...resolved.prompts],
					themes: [...declared.themes, ...resolved.themes],
				};
			}
		}
		const extensionPaths = [
			...selectedPaths(resolved, "extensions"),
			...additionalPaths(this.#options.additionalExtensionPaths),
		];
		let candidateHost: RuntimeExtensionHost | undefined;
		let selectedResult: ResourceExtensionsResult | undefined;
		let rollback: (() => void) | undefined;
		try {
			const loaded = await this.#loadExtensions(
				extensionPaths,
				options,
				settings.isProjectTrusted(),
				projectDirectMetadata,
			);
			candidateHost = getExtensionRuntimeHost(loaded.runtime);
			const extensionErrors = additionalPaths(this.#options.additionalExtensionPaths)
				.filter((entry) => !existsSync(entry.path))
				.map((entry) => ({ path: entry.path, error: "Configured extension path was not found" }));
			const withErrors = { ...loaded, errors: [...loaded.errors, ...extensionErrors] };
			selectedResult = this.#options.extensionsOverride?.(withErrors) ?? withErrors;
			rollback = options.prepareExtensions?.(selectedResult) || undefined;
			options.signal?.throwIfAborted();

			const resourcePaths = {
				skills: this.#options.noSkills === true
					? additionalPaths(this.#options.additionalSkillPaths)
					: [...selectedPaths(resolved, "skills"), ...additionalPaths(this.#options.additionalSkillPaths)],
				prompts: this.#options.noPromptTemplates === true
					? additionalPaths(this.#options.additionalPromptTemplatePaths)
					: [...selectedPaths(resolved, "prompts"), ...additionalPaths(this.#options.additionalPromptTemplatePaths)],
				themes: this.#options.noThemes === true
					? additionalPaths(this.#options.additionalThemePaths)
					: [...selectedPaths(resolved, "themes"), ...additionalPaths(this.#options.additionalThemePaths)],
			};
			const views = await loadResourceViews(resourcePaths, { cwd: this.#options.cwd, agentDir: this.#options.agentDir, maximum: this.#maximum });
			const packageDiagnostics: ResourceDiagnostic[] = packageManager.getDiagnostics().map((diagnostic) => ({
				type: diagnostic.severity,
				code: diagnostic.code,
				message: diagnostic.message,
				path: diagnostic.path,
				source: diagnostic.source,
			}));
			const skillView = {
				skills: views.skills.skills,
				diagnostics: [...views.skills.diagnostics, ...packageDiagnostics],
			};
			const prompts = this.#options.promptsOverride?.(views.prompts) ?? views.prompts;
			const skills = this.#options.skillsOverride?.(skillView) ?? skillView;
			const themes = this.#options.themesOverride?.(views.themes) ?? views.themes;
			const baseAgents: AgentFilesView = this.#options.noContextFiles === true
				? { agentsFiles: [] }
				: { agentsFiles: loadProjectContextFiles({ cwd: this.#options.cwd, agentDir: this.#options.agentDir, maxFileBytes: this.#maximum }) };
			const agentsFiles = this.#options.agentsFilesOverride?.(baseAgents) ?? baseAgents;
			const promptsValue = promptViews(this.#options, settings, this.#maximum);
			const next: Generation = {
				...views,
				extensions: selectedResult,
				skills,
				prompts,
				themes,
				agentsFiles,
				...promptsValue,
				projectPackages,
			};
			options.signal?.throwIfAborted();
			const previous = this.#generation;
			this.#generation = next;
			this.#settings = settings;
			const previousHost = getExtensionRuntimeHost(previous.extensions.runtime);
			const selectedHost = getExtensionRuntimeHost(selectedResult.runtime);
			const closePrevious = previousHost !== undefined && previousHost !== selectedHost ? previousHost.close() : Promise.resolve();
			const closeCandidate = candidateHost !== undefined && candidateHost !== selectedHost ? candidateHost.close() : Promise.resolve();
			await Promise.all([closePrevious, closeCandidate]);
		} catch (error) {
			rollback?.();
			const selectedHost = selectedResult === undefined ? undefined : getExtensionRuntimeHost(selectedResult.runtime);
			if (candidateHost !== undefined && candidateHost !== getExtensionRuntimeHost(this.#generation.extensions.runtime)) await candidateHost.close().catch(() => undefined);
			if (selectedHost !== undefined && selectedHost !== candidateHost && selectedHost !== getExtensionRuntimeHost(this.#generation.extensions.runtime)) await selectedHost.close().catch(() => undefined);
			throw error;
		}
	}
}
