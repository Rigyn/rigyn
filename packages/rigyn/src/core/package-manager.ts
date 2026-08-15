import { createHash, randomBytes } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	readdirSync,
	realpathSync,
	statSync,
	type Dirent,
} from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { Minimatch } from "minimatch";
import { maxSatisfying, satisfies, valid, validRange } from "semver";

import { inspectPortablePlugin, type PortablePluginDiagnostic } from "./portable-plugin.js";
import { legacyManifestResources, parseLegacyExtensionManifest } from "../extensions/legacy-manifest.js";
import type { PackageSource, PackageSourceOptions, SettingsManager } from "./settings-manager.js";
import { RIGYN_VERSION } from "../version.js";
import { isLocalPath, portableLocalPackageSource, resolvePath } from "../utils/paths.js";
import { trackActiveProcessGroup } from "../process/active-groups.js";
import { terminateProcessTree } from "../process/process-tree.js";
import { defaultNpmCommand } from "../process/npm-command.js";
import { readTrustedFileSync, readTrustedTextFileSync } from "./resource-file.js";

export type PackageScope = "user" | "project" | "temporary";
export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface DeclaredResourceMetadata {
	argumentHint?: string;
	description?: string;
	kind: "prompt" | "command" | "theme";
	name: string;
}

export interface PathMetadata {
	baseDir?: string;
	declaredResources?: readonly DeclaredResourceMetadata[];
	disabledDeclaredResources?: readonly string[];
	extensionId?: string;
	origin: "package" | "top-level";
	scope: PackageScope;
	source: string;
	skillValidation?: { format: "portable-plugin-1.0.0"; root: string };
}

export interface PackageDiagnostic extends PortablePluginDiagnostic { source: string }
export interface ResolvedResource { enabled: boolean; metadata: PathMetadata; path: string }
export interface ResolvedPaths {
	extensions: ResolvedResource[];
	prompts: ResolvedResource[];
	skills: ResolvedResource[];
	themes: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";
export interface ProgressEvent {
	action: "install" | "remove" | "update" | "clone" | "pull";
	message?: string;
	source: string;
	type: "start" | "progress" | "complete" | "error";
}
export type ProgressCallback = (event: ProgressEvent) => void;
export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: "user" | "project";
}
export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}
export interface PackageActivationCandidate {
	source: string;
	scope: PackageScope;
	workspace: string;
	projectTrusted: boolean;
	resources: ResolvedPaths;
	dataRoot: string;
	signal?: AbortSignal;
}
export type PackageActivationCallback = (candidate: PackageActivationCandidate) => Promise<void>;
export interface PackageInstallOptions { local?: boolean; allowScripts?: boolean; signal?: AbortSignal }
export interface PackageUpdateOptions { allowScripts?: boolean; signal?: AbortSignal }

export interface PackageManager {
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	checkForAvailableUpdates(): Promise<PackageUpdate[]>;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
	getDiagnostics?(): PackageDiagnostic[];
	install(source: string, options?: PackageInstallOptions): Promise<void>;
	installAndPersist(source: string, options?: PackageInstallOptions): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	resolveExtensionSources(sources: readonly PackageSource[], options?: { local?: boolean; temporary?: boolean }): Promise<ResolvedPaths>;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	update(source?: string, options?: PackageUpdateOptions): Promise<void>;
}

export interface PackageManagerOptions {
	activateCandidate?: PackageActivationCallback;
	agentDir: string;
	cwd: string;
	gitCommand?: readonly [string, ...string[]];
	homeDirectory?: string;
	legacyGlobalProbeTimeoutMs?: number;
	offline?: boolean;
	settingsManager: SettingsManager;
}

const EMPTY = (): ResolvedPaths => ({ extensions: [], prompts: [], skills: [], themes: [] });
const MANIFEST_LIMIT = 1024 * 1024;
// Inventory storage is bounded independently by entry count and retained path bytes.
const PACKAGE_INVENTORY_MAX_ENTRIES = 10_000;
const PACKAGE_INVENTORY_MAX_DEPTH = 64;
const PACKAGE_INVENTORY_MAX_PATH_BYTES = 4 * 1024 * 1024;
// Convention discovery uses the same bounded structural envelope as direct skill loading.
const SKILL_CONVENTION_MAX_ENTRIES = 10_000;
const SKILL_CONVENTION_MAX_DEPTH = 64;
const SKILL_CONVENTION_MAX_PATH_BYTES = 4 * 1024 * 1024;
const DIRECT_SUFFIXES = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);
const ENTRY_NAMES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs", "index.mts", "index.cts"];
const TYPES = ["extensions", "skills", "prompts", "themes"] as const;

type ParsedSource =
	| { kind: "local"; value: string }
	| { kind: "npm"; spec: string; name: string }
	| { kind: "git"; repository: string; ref?: string };

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function inside(root: string, target: string): boolean {
	const local = relative(resolve(root), resolve(target));
	return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function npmName(spec: string): string {
	if (spec.startsWith("file:")) return "";
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		const version = slash < 0 ? -1 : spec.indexOf("@", slash);
		return version < 0 ? spec : spec.slice(0, version);
	}
	const version = spec.indexOf("@");
	return version < 0 ? spec : spec.slice(0, version);
}

function npmSelector(source: Extract<ParsedSource, { kind: "npm" }>): string | undefined {
	if (source.name === "" || source.spec === source.name) return undefined;
	return source.spec.slice(source.name.length + 1);
}

function parseSource(source: string): ParsedSource {
	const value = source.trim();
	if (value.startsWith("npm:")) {
		const spec = value.slice(4);
		if (spec === "" || spec.startsWith("-") || /[\r\n\0]/u.test(spec)) throw new Error(`Invalid npm package source: ${source}`);
		return { kind: "npm", spec, name: npmName(spec) };
	}
	if (value.startsWith("git:")) {
		const selected = value.slice(4);
		const hash = selected.lastIndexOf("#");
		const at = selected.lastIndexOf("@");
		const marker = hash >= 0 ? hash : at > selected.lastIndexOf("/") ? at : -1;
		const canSplitAt = marker > 0;
		return canSplitAt
			? { kind: "git", repository: selected.slice(0, marker), ref: selected.slice(marker + 1) }
			: { kind: "git", repository: selected };
	}
	if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !isLocalPath(value)) {
		throw new Error(`Unsupported package source: ${source}`);
	}
	return { kind: "local", value };
}

function packageEntry(value: PackageSource): PackageSourceOptions {
	return typeof value === "string" ? { source: value } : { ...value };
}

function finalDeclarations(entries: readonly PackageSource[], base: string): PackageSource[] {
	const last = new Map<string, number>();
	entries.forEach((entry, index) => last.set(sourceIdentity(packageEntry(entry).source, base), index));
	return entries.filter((entry, index) => last.get(sourceIdentity(packageEntry(entry).source, base)) === index);
}

function sourceIdentity(source: string, base: string): string {
	const parsed = parseSource(source);
	if (parsed.kind === "local") return `local:${resolvePath(parsed.value, base)}`;
	if (parsed.kind === "npm") return `npm:${parsed.name || parsed.spec}`;
	let repository = parsed.repository;
	if (/^https?:\/\//u.test(repository)) {
		repository = repository.replace(/^https?:\/\//u, "");
	} else if (/^git@[^:]+:/u.test(repository)) {
		repository = repository.replace(/^git@([^:]+):/u, "$1/");
	} else if (/^ssh:\/\/git@/u.test(repository)) {
		repository = repository.replace(/^ssh:\/\/git@/u, "");
	}
	return `git:${repository.replace(/\.git$/u, "")}`;
}

function readJson(path: string, label: string): Record<string, unknown> {
	const value: unknown = JSON.parse(readTrustedTextFileSync(path, MANIFEST_LIMIT, label));
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain an object`);
	return value as Record<string, unknown>;
}

function npmSourceReceiptPath(scopeBase: string, source: string): string {
	return join(scopeBase, "npm", ".rigyn-sources", `${sha(sourceIdentity(source, scopeBase))}.json`);
}

function npmReceiptName(scopeBase: string, receiptPath: string): string | undefined {
	try {
		const receipt = readJson(receiptPath, "Installed npm source receipt");
		const name = receipt["name"];
		if (typeof name !== "string" || name === "" || name.startsWith("-")) return undefined;
		const root = join(scopeBase, "npm", "node_modules");
		const packagePath = join(root, name);
		if (!inside(root, packagePath)) return undefined;
		return name;
	} catch { return undefined; }
}

function npmSourceReceiptName(scopeBase: string, source: string): string | undefined {
	return npmReceiptName(scopeBase, npmSourceReceiptPath(scopeBase, source));
}

function installedNpmPath(scopeBase: string, name: string): string | undefined {
	try {
		const root = join(scopeBase, "npm", "node_modules");
		const path = join(root, name);
		if (!inside(root, path)) return undefined;
		return readJson(join(path, "package.json"), "Installed package manifest")["name"] === name ? path : undefined;
	} catch { return undefined; }
}

function installedNpmReceiptPath(scopeBase: string, source: string): string | undefined {
	const name = npmSourceReceiptName(scopeBase, source);
	return name === undefined ? undefined : installedNpmPath(scopeBase, name);
}

function recordedNpmNames(scopeBase: string, excludedSource?: string): Set<string> {
	const names = new Set<string>();
	const root = join(scopeBase, "npm", ".rigyn-sources");
	const excluded = excludedSource === undefined ? undefined : npmSourceReceiptPath(scopeBase, excludedSource);
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const path = join(root, entry.name);
			if (!entry.isFile() || !entry.name.endsWith(".json") || path === excluded) continue;
			const name = npmReceiptName(scopeBase, path);
			if (name !== undefined) names.add(name);
		}
	} catch { /* No source receipts have been recorded. */ }
	return names;
}

function managedNpmNames(scopeBase: string): Set<string> {
	const names = new Set<string>();
	const root = join(scopeBase, "npm", "node_modules");
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (!entry.name.startsWith("@")) names.add(entry.name);
			else {
				for (const child of readdirSync(join(root, entry.name), { withFileTypes: true })) {
					if (child.isDirectory()) names.add(`${entry.name}/${child.name}`);
				}
			}
		}
	} catch { /* No managed npm root. */ }
	return names;
}

function directDependencyName(manifest: Record<string, unknown>): string | undefined {
	const names = new Set<string>();
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		const dependencies = manifest[field];
		if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		for (const name of Object.keys(dependencies)) names.add(name);
	}
	return names.size === 1 ? names.values().next().value : undefined;
}

function stagedNpmPackageName(stage: string): string | undefined {
	let name: string | undefined;
	try { name = directDependencyName(readJson(join(stage, "package.json"), "Installed package root manifest")); }
	catch { /* npm can record the direct dependency only in its lock. */ }
	try {
		if (name === undefined) {
			const lock = readJson(join(stage, "package-lock.json"), "Installed package lock");
			const packages = lock["packages"];
			if (packages === null || typeof packages !== "object" || Array.isArray(packages)) return undefined;
			const root = (packages as Record<string, unknown>)[""];
			if (root === null || typeof root !== "object" || Array.isArray(root)) return undefined;
			name = directDependencyName(root as Record<string, unknown>);
			if (name === undefined) return undefined;
			const locked = (packages as Record<string, unknown>)[`node_modules/${name}`];
			if (locked === null || typeof locked !== "object" || Array.isArray(locked)) return undefined;
		}
		const nodeModules = join(stage, "node_modules");
		const path = join(nodeModules, name);
		if (!inside(nodeModules, path)) return undefined;
		const manifest = readJson(join(path, "package.json"), "Installed package manifest");
		return manifest["name"] === name ? name : undefined;
	} catch { return undefined; }
}

async function writeAtomicFile(path: string, contents: string | Uint8Array): Promise<void> {
	const root = dirname(path);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const temporary = join(root, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let handle;
	try {
		handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		await handle.writeFile(contents);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function writeNpmSourceReceipt(scopeBase: string, source: string, name: string): Promise<void> {
	await writeAtomicFile(npmSourceReceiptPath(scopeBase, source), `${JSON.stringify({ name })}\n`);
}

function regularInside(root: string, path: string): string | undefined {
	try {
		const selected = realpathSync(path);
		if (!inside(realpathSync(root), selected) || !statSync(selected).isFile()) return undefined;
		return selected;
	} catch { return undefined; }
}

interface Inventory { files: string[]; relative: Map<string, string> }

function inventory(root: string): Inventory {
	const files: string[] = [];
	const relativePaths = new Map<string, string>();
	const budget = { entries: 0, pathBytes: 0 };
	const entries = (directory: string): Dirent[] => {
		const handle = opendirSync(directory);
		const selected: Dirent[] = [];
		try {
			for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
				budget.entries += 1;
				if (budget.entries > PACKAGE_INVENTORY_MAX_ENTRIES) {
					throw new Error(`Package inventory exceeds ${PACKAGE_INVENTORY_MAX_ENTRIES} entries: ${root}`);
				}
				const retained = relative(root, join(directory, entry.name)).split(sep).join("/");
				budget.pathBytes += Buffer.byteLength(retained);
				if (budget.pathBytes > PACKAGE_INVENTORY_MAX_PATH_BYTES) {
					throw new Error(`Package inventory exceeds ${PACKAGE_INVENTORY_MAX_PATH_BYTES} retained path bytes: ${root}`);
				}
				selected.push(entry);
			}
		} finally {
			handle.closeSync();
		}
		return selected.sort((left, right) => left.name.localeCompare(right.name));
	};
	const visit = (directory: string, depth = 0): void => {
		if (depth > PACKAGE_INVENTORY_MAX_DEPTH) {
			throw new Error(`Package inventory exceeds maximum directory depth ${PACKAGE_INVENTORY_MAX_DEPTH}: ${root}`);
		}
		const ignored = new Set<string>();
		for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
			const path = join(directory, filename);
			try {
				const info = lstatSync(path);
				if (!info.isFile() || info.isSymbolicLink() || info.size > MANIFEST_LIMIT) continue;
				for (const line of readTrustedTextFileSync(path, MANIFEST_LIMIT, "Package ignore file", {
					expectedInformation: info,
					rejectSymbolicLink: true,
				}).split(/\r?\n/u)) {
					const rule = line.trim().replace(/\/$/u, "");
					if (rule !== "" && !rule.startsWith("#") && !rule.startsWith("!") && !/[?*[]/u.test(rule)) ignored.add(rule);
				}
			} catch (error) { if (!missing(error)) throw error; }
		}
		for (const entry of entries(directory)) {
			if (entry.name === ".git" || ignored.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) visit(path, depth + 1);
			else if (entry.isFile()) {
				const selected = regularInside(root, path);
				if (selected === undefined) continue;
				files.push(selected);
				relativePaths.set(selected, relative(root, selected).split(sep).join("/"));
			}
		}
	};
	visit(root);
	return { files, relative: relativePaths };
}

function matches(pattern: string, value: string): boolean {
	return new Minimatch(pattern.replaceAll("\\", "/"), {
		dot: true,
		nocase: process.platform === "win32",
		windowsPathsNoEscape: true,
	}).match(value);
}

function directConvention(root: string): string[] {
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
	const output: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(root, entry.name);
		if (entry.isFile() && DIRECT_SUFFIXES.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
			const selected = regularInside(root, path);
			if (selected !== undefined) output.push(selected);
		} else if (entry.isDirectory()) {
			for (const name of ENTRY_NAMES) {
				const selected = regularInside(root, join(path, name));
				if (selected !== undefined) { output.push(selected); break; }
			}
		}
	}
	return output;
}

function skillsConvention(root: string): string[] {
	const output: string[] = [];
	const budget = { entries: 0, pathBytes: 0 };
	const visit = (directory: string, depth = 0): void => {
		if (depth > SKILL_CONVENTION_MAX_DEPTH) {
			throw new Error(`Skill discovery exceeds maximum depth ${SKILL_CONVENTION_MAX_DEPTH}: ${root}`);
		}
		budget.pathBytes += Buffer.byteLength(directory);
		if (budget.pathBytes > SKILL_CONVENTION_MAX_PATH_BYTES) {
			throw new Error(`Skill discovery exceeds ${SKILL_CONVENTION_MAX_PATH_BYTES} retained path bytes: ${root}`);
		}
		let manifestIgnored = false;
		for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
			try {
				const rules = readTrustedTextFileSync(
					join(directory, filename),
					MANIFEST_LIMIT,
					"Skill ignore file",
					{ rejectSymbolicLink: true },
				).split(/\r?\n/u).map((line) => line.trim());
				if (rules.includes("SKILL.md")) manifestIgnored = true;
				if (rules.includes("!SKILL.md")) manifestIgnored = false;
			} catch { /* Optional ignore file. */ }
		}
		const manifest = manifestIgnored ? undefined : regularInside(root, join(directory, "SKILL.md"));
		if (manifest !== undefined) { output.push(manifest); return; }
		let entries: Dirent[];
		try {
			const handle = opendirSync(directory);
			entries = [];
			try {
				for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
					budget.entries += 1;
					if (budget.entries > SKILL_CONVENTION_MAX_ENTRIES) {
						throw new Error(`Skill discovery exceeds ${SKILL_CONVENTION_MAX_ENTRIES} entries: ${root}`);
					}
					entries.push(entry);
				}
			} finally { handle.closeSync(); }
		} catch (error) {
			if (missing(error)) return;
			throw error;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || !entry.isDirectory()) continue;
			visit(join(directory, entry.name), depth + 1);
		}
	};
	visit(root);
	return output;
}

function flatFiles(root: string, suffix: string): string[] {
	try {
		const ignored = new Set<string>();
		for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
			try {
				const info = lstatSync(join(root, filename));
				if (!info.isFile() || info.isSymbolicLink() || info.size > MANIFEST_LIMIT) continue;
				for (const line of readTrustedTextFileSync(
					join(root, filename),
					MANIFEST_LIMIT,
					"Resource ignore file",
					{ expectedInformation: info, rejectSymbolicLink: true },
				).split(/\r?\n/u)) {
					const rule = line.trim().replace(/\/$/u, "");
					if (rule !== "" && !rule.startsWith("#") && !rule.includes("/")) ignored.add(rule);
				}
			} catch { /* Optional ignore file. */ }
		}
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && !ignored.has(entry.name) && entry.name.toLowerCase().endsWith(suffix))
			.map((entry) => regularInside(root, join(root, entry.name)))
			.filter((entry): entry is string => entry !== undefined)
			.sort();
	} catch { return []; }
}

function convention(root: string, type: ResourceType): string[] {
	if (type === "extensions") return directConvention(root);
	if (type === "skills") return skillsConvention(root);
	return flatFiles(root, type === "prompts" ? ".md" : ".json");
}

function declarationSelection(
	root: string,
	type: ResourceType,
	patterns: readonly string[] | undefined,
	inventoryValue: Inventory,
): string[] {
	if (patterns === undefined) return convention(join(root, type), type);
	const eligible = inventoryValue.files.filter((path) => {
		const name = inventoryValue.relative.get(path)!;
		if (type === "extensions") return DIRECT_SUFFIXES.has(name.slice(name.lastIndexOf(".")));
		if (type === "skills") return basename(path) === "SKILL.md";
		return name.toLowerCase().endsWith(type === "prompts" ? ".md" : ".json");
	});
	const selected = new Set<string>();
	for (const raw of patterns) {
		if (typeof raw !== "string" || raw.includes("\0")) continue;
		const marker = raw[0];
		const pattern = marker === "!" || marker === "+" || marker === "-" ? raw.slice(1) : raw;
		const candidates = eligible.filter((path) => {
			const name = inventoryValue.relative.get(path)!;
			if (matches(pattern, name)) return true;
			const segments = name.split("/");
			if (segments.slice(0, -1).some((_segment, index) => matches(pattern, segments.slice(0, index + 1).join("/")))) return true;
			const requested = resolve(root, pattern);
			return inside(root, requested) && (path === requested || inside(requested, path));
		});
		if (marker === "!" || marker === "-") for (const path of candidates) selected.delete(path);
		else for (const path of candidates) selected.add(path);
	}
	return [...selected].sort();
}

function filtered(
	resources: readonly string[],
	root: string,
	rules: readonly string[] | undefined,
	autoload: boolean,
): Array<{ path: string; enabled: boolean }> {
	if (rules === undefined) return autoload ? resources.map((path) => ({ path, enabled: true })) : [];
	const result = resources.map((path) => ({ path, enabled: autoload }));
	const ordinary = rules.filter((rule) => !rule.startsWith("+") && !rule.startsWith("-"));
	if (ordinary.length > 0) {
		for (const item of result) {
			const name = relative(root, item.path).split(sep).join("/");
			for (const rule of ordinary) {
				if (rule.startsWith("!")) { if (matches(rule.slice(1), name)) item.enabled = false; }
				else if (matches(rule, name)) item.enabled = true;
			}
		}
	}
	for (const item of result) {
		const name = relative(root, item.path).split(sep).join("/");
		if (rules.some((rule) => rule.startsWith("+") && rule.slice(1) === name)) item.enabled = true;
		if (rules.some((rule) => rule.startsWith("-") && rule.slice(1) === name)) item.enabled = false;
	}
	if (autoload) return result;
	return result.filter((item) => {
		const name = relative(root, item.path).split(sep).join("/");
		return rules.some((rule) => {
			const marker = rule[0];
			const pattern = marker === "!" || marker === "+" || marker === "-" ? rule.slice(1) : rule;
			return marker === "+" || marker === "-" ? pattern === name : matches(pattern, name);
		});
	});
}

interface PackageView { resources: ResolvedPaths; diagnostics: PackageDiagnostic[]; rejected?: boolean }

function packageResources(rootInput: string, entry: PackageSourceOptions, scope: PackageScope): PackageView {
	const root = realpathSync(rootInput);
	if (!statSync(root).isDirectory()) {
		const path = root;
		return {
			resources: {
				...EMPTY(),
				extensions: DIRECT_SUFFIXES.has(path.slice(path.lastIndexOf("."))) ? [{
					path,
					enabled: true,
					metadata: { baseDir: dirname(path), origin: "top-level", scope, source: entry.source },
				}] : [],
			},
			diagnostics: [],
		};
	}
	const portable = inspectPortablePlugin(root);
	const diagnostics = (portable?.diagnostics ?? []).map((diagnostic) => ({ ...diagnostic, source: entry.source }));
	if (portable?.rejected === true) return { resources: EMPTY(), diagnostics, rejected: true };
	const snapshot = inventory(root);
	let declarations: Partial<Record<ResourceType, string[]>> = {};
	let authoritative = false;
	let legacyManifest: ReturnType<typeof parseLegacyExtensionManifest> | undefined;
	const legacyPath = join(root, "extension.json");
	if (existsSync(legacyPath)) {
		try {
			const legacy = parseLegacyExtensionManifest(readJson(legacyPath, "Legacy extension manifest"));
			legacyManifest = legacy;
			let integrityValid = true;
			for (const [name, digest] of legacy.integrity) {
				const path = regularInside(root, join(root, name));
				if (path === undefined || createHash("sha256")
					.update(readTrustedFileSync(path, 16 * 1024 * 1024, "Legacy extension integrity file"))
					.digest("hex") !== digest) {
					integrityValid = false;
					break;
				}
			}
			if (!integrityValid) return { resources: EMPTY(), diagnostics };
			declarations = legacyManifestResources(legacy);
			authoritative = true;
		} catch {
			return { resources: EMPTY(), diagnostics };
		}
	}
	const packageJson = join(root, "package.json");
	if (!authoritative && existsSync(packageJson)) {
		let manifest: Record<string, unknown> | undefined;
		try { manifest = readJson(packageJson, "Package manifest"); }
		catch { declarations.extensions = snapshot.files.filter((path) => DIRECT_SUFFIXES.has(path.slice(path.lastIndexOf(".")))).map((path) => snapshot.relative.get(path)!); }
		const rigyn = manifest?.["rigyn"];
		if (rigyn !== undefined) {
			if (rigyn === null || typeof rigyn !== "object" || Array.isArray(rigyn)) throw new Error(`Package rigyn declaration must be an object: ${packageJson}`);
			authoritative = true;
			for (const type of TYPES) {
				const value = (rigyn as Record<string, unknown>)[type];
				if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
					throw new Error(`Package ${type} declaration must be an array of strings: ${packageJson}`);
				}
				if (value !== undefined) declarations[type] = value as string[];
			}
		}
	}
	if (portable !== undefined) {
		authoritative = true;
		declarations.skills = portable.skills.map((path) => relative(root, path).split(sep).join("/"));
		if (portable.namespaceRoot !== undefined) {
			for (const type of ["extensions", "prompts", "themes"] as const) {
				declarations[type] ??= [relative(root, join(portable.namespaceRoot, type)).split(sep).join("/")];
			}
		}
	}
	if (authoritative) for (const type of TYPES) declarations[type] ??= [];
	if (!authoritative) {
		for (const type of TYPES) {
			if (entry[type] === undefined) continue;
			const suffix = type === "prompts" ? ".md" : type === "themes" ? ".json" : undefined;
			declarations[type] = snapshot.files
				.filter((path) => {
					const name = snapshot.relative.get(path)!;
					if (!name.startsWith(`${type}/`)) return false;
					if (type === "extensions") return DIRECT_SUFFIXES.has(name.slice(name.lastIndexOf(".")));
					if (type === "skills") return basename(path) === "SKILL.md";
					return name.toLowerCase().endsWith(suffix!);
				})
				.map((path) => snapshot.relative.get(path)!);
		}
	}
	const resources = EMPTY();
	for (const type of TYPES) {
		const declared = declarationSelection(root, type, declarations[type], snapshot);
		const selected = filtered(declared, root, entry[type], entry.autoload !== false);
		resources[type] = selected.map(({ path, enabled }) => ({
			path,
			enabled: enabled && (legacyManifest === undefined || (
				legacyManifest.enabled
				&& (legacyManifest.hostVersionRange === undefined || satisfies(RIGYN_VERSION, legacyManifest.hostVersionRange))
			)),
			metadata: {
				baseDir: root,
				origin: "package",
				scope,
				source: entry.source,
				...(legacyManifest === undefined ? {} : { extensionId: legacyManifest.id }),
				...(() => {
					if (legacyManifest === undefined || (type !== "prompts" && type !== "themes")) return {};
					const owns = (declaredPath: string): boolean => {
						const target = resolve(root, declaredPath);
						return path === target || inside(target, path);
					};
					const declaredResources: DeclaredResourceMetadata[] = type === "prompts"
						? [
							...legacyManifest.prompts.filter((item) => owns(item.path)).map((item) => ({
								kind: "prompt" as const,
								name: item.id,
								...(item.description === undefined ? {} : { description: item.description }),
							})),
							...legacyManifest.commands.filter((item) => owns(item.path)).map((item) => ({
								kind: "command" as const,
								name: item.name,
								...(item.description === undefined ? {} : { description: item.description }),
								...(item.argumentHint === undefined ? {} : { argumentHint: item.argumentHint }),
							})),
						]
						: legacyManifest.themes.filter((item) => owns(item.path)).map((item) => ({
							kind: "theme" as const,
							name: item.name,
							...(item.description === undefined ? {} : { description: item.description }),
						}));
					return declaredResources.length === 0 ? {} : { declaredResources };
				})(),
				...(portable !== undefined && type === "skills" ? { skillValidation: { format: "portable-plugin-1.0.0" as const, root } } : {}),
			},
		}));
	}
	return { resources, diagnostics };
}

function merge(target: ResolvedPaths, source: ResolvedPaths): void {
	for (const type of TYPES) target[type].push(...source[type]);
}

function deduplicate(value: ResolvedPaths): ResolvedPaths {
	const result = EMPTY();
	for (const type of TYPES) {
		const seen = new Set<string>();
		for (const item of value[type]) {
			const identity = process.platform === "win32" ? item.path.toLowerCase() : item.path;
			if (seen.has(identity)) continue;
			seen.add(identity);
			result[type].push(item);
		}
	}
	return result;
}

function extensionRootPackages(root: string, scope: PackageScope): ResolvedPaths {
	const result = EMPTY();
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return result; }
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue;
		const packageRoot = join(root, entry.name);
		if (!existsSync(join(packageRoot, "package.json")) && !existsSync(join(packageRoot, "plugin.json"))) continue;
		merge(result, packageResources(packageRoot, { source: packageRoot }, scope).resources);
	}
	return result;
}

function topLevel(root: string, type: ResourceType, scope: PackageScope, rules?: readonly string[]): ResolvedResource[] {
	const directTopLevel = (): string[] => {
		let entries;
		try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
		const output: string[] = [];
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			let target: string;
			try { target = realpathSync(join(root, entry.name)); } catch { continue; }
			let info;
			try { info = statSync(target); } catch { continue; }
			if (info.isFile() && DIRECT_SUFFIXES.has(target.slice(target.lastIndexOf(".")))) output.push(target);
			else if (info.isDirectory()) {
				for (const name of ENTRY_NAMES) {
					try {
						const path = realpathSync(join(target, name));
						if (statSync(path).isFile()) { output.push(path); break; }
					} catch { /* Try the next entry name. */ }
				}
			}
		}
		return output;
	};
	const paths = type === "extensions" ? directTopLevel() : convention(root, type);
	return filtered(paths, dirname(root), rules, true).map(({ path, enabled }) => ({
		path,
		enabled,
		metadata: { baseDir: root, origin: "top-level", scope, source: root },
	}));
}

function sharedSkills(
	root: string,
	baseDir: string,
	scope: "user" | "project",
	rules: readonly string[],
): ResolvedResource[] {
	return skillsConvention(root).map((path) => {
		const key = relative(baseDir, dirname(path)).split(sep).join("/");
		const disabled = rules.some((rule) => rule.startsWith("-") && rule.slice(1) === key);
		return {
			path,
			enabled: !disabled,
			metadata: { baseDir, origin: "top-level", scope, source: root },
		};
	});
}

function commandName(command: readonly string[]): "npm" | "pnpm" | "bun" {
	const leaf = basename(command.at(-1) ?? command[0] ?? "npm").toLowerCase();
	return leaf.includes("pnpm") ? "pnpm" : leaf.includes("bun") ? "bun" : "npm";
}

async function run(
	command: readonly [string, ...string[]],
	args: readonly string[],
	options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	options.signal?.throwIfAborted();
	return await new Promise<string>((resolveRun, rejectRun) => {
		const child = spawn(command[0], [...command.slice(1), ...args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: false,
			windowsHide: true,
		});
		const releaseProcessGroup = trackActiveProcessGroup(child.pid);
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", abort);
			if (timer !== undefined) clearTimeout(timer);
			releaseProcessGroup();
			callback();
		};
		const terminate = (): void => {
			if (child.pid === undefined) child.kill("SIGKILL");
			else terminateProcessTree(child.pid, "SIGKILL");
		};
		const abort = (): void => { terminate(); finish(() => rejectRun(options.signal?.reason)); };
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
			terminate();
			finish(() => rejectRun(new Error(`Package command timed out after ${options.timeoutMs}ms`)));
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 1024 * 1024) stdout = Buffer.concat([stdout, chunk.subarray(0, 1024 * 1024 - stdout.length)]); });
		child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr = Buffer.concat([stderr, chunk.subarray(0, 64 * 1024 - stderr.length)]); });
		child.once("error", (error) => finish(() => rejectRun(error)));
		child.once("close", (code) => finish(() => code === 0
			? resolveRun(stdout.toString("utf8"))
			: rejectRun(new Error(stderr.toString("utf8").trim() || `Package command exited with ${code}`))));
	});
}

export function getExtensionTempFolder(agentDirectory: string): string {
	const root = join(resolve(agentDirectory), "tmp", "extensions");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	try { accessSync(root, constants.W_OK | constants.X_OK); } catch { throw new Error(`Temporary extension directory is not writable: ${root}`); }
	return root;
}

export class DefaultPackageManager implements PackageManager {
	readonly #cwd: string;
	readonly #agentDir: string;
	readonly #settings: SettingsManager;
	readonly #git: readonly [string, ...string[]];
	readonly #home: string;
	readonly #homeIsAbsolute: boolean;
	readonly #activate: PackageActivationCallback | undefined;
	readonly #offline: boolean;
	readonly #probeTimeout: number;
	#progress: ProgressCallback | undefined;
	#diagnostics: PackageDiagnostic[] = [];

	constructor(options: PackageManagerOptions) {
		this.#cwd = resolve(options.cwd);
		this.#agentDir = resolve(options.agentDir);
		this.#settings = options.settingsManager;
		this.#git = options.gitCommand ?? ["git"];
		const selectedHome = options.homeDirectory ?? process.env.HOME ?? homedir();
		this.#homeIsAbsolute = isAbsolute(selectedHome);
		this.#home = resolve(selectedHome);
		this.#activate = options.activateCandidate;
		this.#offline = options.offline ?? process.env.RIGYN_OFFLINE === "1";
		this.#probeTimeout = options.legacyGlobalProbeTimeoutMs ?? 2_000;
	}

	setProgressCallback(callback: ProgressCallback | undefined): void { this.#progress = callback; }
	getDiagnostics(): PackageDiagnostic[] { return this.#diagnostics.map((entry) => ({ ...entry })); }

	#emit(event: ProgressEvent): void {
		try { this.#progress?.(Object.freeze({ ...event })); } catch { /* Observers do not own package outcomes. */ }
	}

	#scopeBase(scope: "user" | "project"): string {
		return scope === "user" ? this.#agentDir : join(this.#cwd, ".rigyn");
	}

	#assertProject(): void {
		if (!this.#settings.isProjectTrusted()) throw new Error("Project packages are unavailable because this project is not trusted");
	}

	#entries(scope: "user" | "project"): PackageSource[] {
		const settings = scope === "user" ? this.#settings.getGlobalSettings() : this.#settings.getProjectSettings();
		return (settings.packages as PackageSource[] | undefined) ?? [];
	}

	#writeEntries(scope: "user" | "project", entries: PackageSource[]): void {
		if (scope === "project") this.#settings.setProjectPackages(entries);
		else this.#settings.setPackages(entries);
	}

	#storedSource(source: string, scope: "user" | "project"): string {
		const parsed = parseSource(source);
		if (parsed.kind !== "local") return source;
		const absolute = resolvePath(parsed.value, this.#cwd);
		const portable = relative(this.#scopeBase(scope), absolute);
		if (portable === "" || isAbsolute(portable) || /^[A-Za-z]:/u.test(portable)) return absolute;
		return portableLocalPackageSource(portable);
	}

	#configuredSource(source: string, scope: "user" | "project"): string | undefined {
		const entries = this.#entries(scope).map(packageEntry);
		const exact = entries.find((entry) => entry.source === source);
		if (exact !== undefined) return exact.source;
		const parsed = parseSource(source);
		if (parsed.kind === "npm") return undefined;
		const candidate = parsed.kind === "local" ? this.#storedSource(source, scope) : source;
		const scopeBase = this.#scopeBase(scope);
		const identity = sourceIdentity(candidate, scopeBase);
		return entries.find((entry) => sourceIdentity(entry.source, scopeBase) === identity)?.source;
	}

	addSourceToSettings(source: string, options: { local?: boolean } = {}): boolean {
		const scope = options.local === true ? "project" : "user";
		if (scope === "project") this.#assertProject();
		const stored = this.#storedSource(source, scope);
		const entries = this.#entries(scope);
		const identity = sourceIdentity(stored, this.#scopeBase(scope));
		const match = entries.findIndex((entry) => sourceIdentity(packageEntry(entry).source, this.#scopeBase(scope)) === identity);
		if (match >= 0) {
			const prior = packageEntry(entries[match]!);
			if (prior.source === stored) return false;
			const replacement: PackageSource = typeof entries[match] === "string"
				? stored
				: { ...prior, source: stored };
			const updated = [...entries];
			updated[match] = replacement;
			this.#writeEntries(scope, updated);
			return true;
		}
		this.#writeEntries(scope, [...entries, stored]);
		return true;
	}

	removeSourceFromSettings(source: string, options: { local?: boolean } = {}): boolean {
		const scope = options.local === true ? "project" : "user";
		if (scope === "project") this.#assertProject();
		const configured = this.#configuredSource(source, scope);
		const identity = sourceIdentity(configured ?? source, configured === undefined ? this.#cwd : this.#scopeBase(scope));
		const entries = this.#entries(scope);
		const selected = entries.filter((entry) => sourceIdentity(packageEntry(entry).source, this.#scopeBase(scope)) !== identity);
		if (selected.length === entries.length) return false;
		this.#writeEntries(scope, selected);
		return true;
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = parseSource(source);
		const scopeBase = this.#scopeBase(scope);
		if (parsed.kind === "local") {
			const path = resolvePath(parsed.value, scopeBase);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.kind === "git") {
			const path = join(scopeBase, "git", "repositories", sha(sourceIdentity(source, scopeBase).slice(4)));
			return existsSync(path) ? path : undefined;
		}
		if (parsed.name !== "") {
			const path = join(scopeBase, "npm", "node_modules", parsed.name);
			if (existsSync(path)) return path;
		} else {
			if (existsSync(npmSourceReceiptPath(scopeBase, source))) return installedNpmReceiptPath(scopeBase, source);
			const identity = sourceIdentity(source, scopeBase);
			const entries = this.#entries(scope).map(packageEntry);
			const unresolved = entries.filter((entry) => {
				const candidate = parseSource(entry.source);
				return candidate.kind === "npm" && candidate.name === "" && (
					!existsSync(npmSourceReceiptPath(scopeBase, entry.source)) || npmSourceReceiptName(scopeBase, entry.source) === undefined
				);
			});
			if (unresolved.length !== 1 || sourceIdentity(unresolved[0]!.source, scopeBase) !== identity) return undefined;
			const owned = recordedNpmNames(scopeBase);
			for (const entry of entries) {
				const candidate = parseSource(entry.source);
				if (candidate.kind === "npm" && candidate.name !== "") owned.add(candidate.name);
			}
			const candidates = [...managedNpmNames(scopeBase)].filter((name) => !owned.has(name));
			if (candidates.length === 1) return installedNpmPath(scopeBase, candidates[0]!);
		}
		if (scope === "user" && parsed.name !== "" && !this.#offline && process.env.RIGYN_OFFLINE !== "1") {
			const command = this.#npmCommand();
			const probe = spawnSync(command[0], [...command.slice(1), "root", "-g"], {
				encoding: "utf8", shell: false, timeout: this.#probeTimeout, windowsHide: true,
			});
			if (probe.status === 0 && typeof probe.stdout === "string") {
				const legacy = join(probe.stdout.trim(), parsed.name);
				if (existsSync(legacy)) return legacy;
			}
		}
		return undefined;
	}

	#npmCommand(): readonly [string, ...string[]] {
		const configured = this.#settings.getNpmCommand();
		return configured !== undefined && configured.length > 0
			? configured as [string, ...string[]]
			: defaultNpmCommand();
	}

	async #activation(source: string, scope: PackageScope, root: string, signal?: AbortSignal): Promise<ResolvedPaths> {
		const view = packageResources(root, { source }, scope);
		this.#diagnostics.push(...view.diagnostics);
		if (view.rejected === true) throw new Error("Portable plugin manifest is invalid");
		await this.#activate?.({
			source,
			scope,
			workspace: this.#cwd,
			projectTrusted: this.#settings.isProjectTrusted(),
			resources: view.resources,
			dataRoot: getExtensionTempFolder(this.#agentDir),
			...(signal === undefined ? {} : { signal }),
		});
		return view.resources;
	}

	async #withStagedNpm<T>(
		source: string,
		parsed: Extract<ParsedSource, { kind: "npm" }>,
		scopeBase: string,
		options: PackageInstallOptions,
		use: (staged: { manifest: Record<string, unknown>; name: string; path: string }) => Promise<T>,
	): Promise<T> {
		await mkdir(scopeBase, { recursive: true });
		const stage = await mkdtemp(join(scopeBase, ".rigyn-package-stage-"));
		try {
			const stageName = `rigyn-package-stage-${sha(sourceIdentity(source, scopeBase)).slice(0, 12)}`;
			await writeFile(join(stage, "package.json"), `${JSON.stringify({ name: stageName, private: true })}\n`, { encoding: "utf8", mode: 0o600 });
			const command = this.#npmCommand();
			const manager = commandName(command);
			const rootFlag = manager === "bun" ? "--cwd" : "--prefix";
			const scriptFlags = options.allowScripts === true
				? manager === "bun" ? []
					: manager === "pnpm" ? ["--ignore-scripts=false", "--config.bin-links=true"]
						: ["--ignore-scripts=false", "--bin-links=true"]
				: manager === "bun" ? ["--ignore-scripts"]
					: manager === "pnpm" ? ["--ignore-scripts=true", "--config.bin-links=false", "--config.auto-install-peers=false", "--config.strict-peer-dependencies=false", "--config.strict-dep-builds=false"]
						: ["--ignore-scripts=true", "--bin-links=false"];
			const peerFlags = manager === "bun" ? ["--omit=peer"] : manager === "pnpm" ? [] : ["--legacy-peer-deps"];
			await run(command, ["install", parsed.spec, rootFlag, stage, ...peerFlags, ...scriptFlags], {
				...(options.signal === undefined ? {} : { signal: options.signal }),
				env: {
					...process.env,
					npm_config_ignore_scripts: options.allowScripts === true ? "false" : "true",
					npm_config_bin_links: options.allowScripts === true ? "true" : "false",
				},
			});
			const nodeModules = join(stage, "node_modules");
			const candidates: string[] = [];
			for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith("@")) {
					for (const child of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
						if (child.isDirectory()) candidates.push(join(nodeModules, entry.name, child.name));
					}
				} else candidates.push(join(nodeModules, entry.name));
			}
			const installedName = parsed.name || stagedNpmPackageName(stage);
			let packagePath = installedName === undefined ? undefined : candidates.find((path) => relative(nodeModules, path).split(sep).join("/") === installedName);
			if (packagePath === undefined && parsed.name !== "" && candidates.length === 1) packagePath = candidates[0];
			if (packagePath === undefined) throw new Error(`Installed npm package could not be identified: ${source}`);
			const manifest = readJson(join(packagePath, "package.json"), "Installed package manifest");
			const name = manifest["name"];
			if (typeof name !== "string" || name === "" || name.startsWith("-")) throw new Error("Installed package name is invalid");
			return await use({ manifest, name, path: packagePath });
		} finally {
			await rm(stage, { recursive: true, force: true });
		}
	}

	async #recoverNpmReceipts(
		scope: "user" | "project",
		current?: { name: string; source: string },
		options: PackageInstallOptions = {},
	): Promise<() => Promise<void>> {
		const scopeBase = this.#scopeBase(scope);
		const bareSources = this.#entries(scope).map(packageEntry).map((entry) => entry.source)
			.filter((source) => {
				const parsed = parseSource(source);
				return parsed.kind === "npm" && parsed.name === "";
			});
		const unresolvedSources = bareSources.filter((source) => !existsSync(npmSourceReceiptPath(scopeBase, source)) || npmSourceReceiptName(scopeBase, source) === undefined);
		if (unresolvedSources.length === 0) return async () => undefined;
		if (this.#offline || process.env.RIGYN_OFFLINE === "1") throw new Error("Cannot recover installed npm package identity while offline");
		const currentIdentity = current === undefined ? undefined : sourceIdentity(current.source, scopeBase);
		const derived = new Map<string, string>();
		for (const source of unresolvedSources) {
			const identity = sourceIdentity(source, scopeBase);
			if (identity === currentIdentity) derived.set(source, current!.name);
			else {
				const parsed = parseSource(source);
				if (parsed.kind !== "npm") continue;
				const name = await this.#withStagedNpm(source, parsed, scopeBase, { ...options, allowScripts: false }, async (staged) => staged.name);
				derived.set(source, name);
			}
		}
		const names = new Set(derived.values());
		if (names.size !== derived.size) throw new Error("Installed npm package ownership is ambiguous because configured bare sources resolve to the same name");
		const configuredNames = new Set(this.#entries(scope).map(packageEntry).flatMap((entry) => {
			const parsed = parseSource(entry.source);
			return parsed.kind === "npm" && parsed.name !== "" ? [parsed.name] : [];
		}));
		const ownedNames = recordedNpmNames(scopeBase);
		for (const name of configuredNames) ownedNames.add(name);
		for (const name of names) {
			if (ownedNames.has(name)) throw new Error(`Installed npm package ${name} is already owned by another package source`);
			const destination = join(scopeBase, "npm", "node_modules", name);
			if (existsSync(destination) && installedNpmPath(scopeBase, name) === undefined) {
				throw new Error("Cannot recover installed npm package identity from the configured bare sources");
			}
		}
		const unclaimed = [...managedNpmNames(scopeBase)].filter((name) => !ownedNames.has(name));
		if (unclaimed.some((name) => !names.has(name))) throw new Error("Cannot recover installed npm package identity from the configured bare sources");
		const snapshots = new Map<string, Buffer | undefined>();
		for (const source of unresolvedSources) {
			const path = npmSourceReceiptPath(scopeBase, source);
			try { snapshots.set(path, await readFile(path)); }
			catch (error) {
				if (!missing(error)) throw error;
				snapshots.set(path, undefined);
			}
		}
		const restore = async (): Promise<void> => {
			for (const [path, contents] of snapshots) {
				if (contents === undefined) await rm(path, { force: true });
				else await writeAtomicFile(path, contents);
			}
		};
		try {
			for (const [source, name] of derived) await writeNpmSourceReceipt(scopeBase, source, name);
		} catch (error) {
			await restore();
			throw error;
		}
		return restore;
	}

	async #installNpm(source: string, parsed: Extract<ParsedSource, { kind: "npm" }>, scope: "user" | "project", options: PackageInstallOptions): Promise<void> {
		const scopeBase = this.#scopeBase(scope);
		await this.#withStagedNpm(source, parsed, scopeBase, options, async ({ manifest, name, path: packagePath }) => {
			const restoreReceipts = await this.#recoverNpmReceipts(scope, { name, source }, options);
			try {
				const receiptName = parsed.name === "" ? npmSourceReceiptName(scopeBase, source) : undefined;
				if (receiptName !== undefined && receiptName !== name) {
					throw new Error(`Installed npm package identity changed from ${receiptName} to ${name}`);
				}
				const identity = sourceIdentity(source, scopeBase);
				const configuredOwner = this.#entries(scope).some((entry) => {
					const otherSource = packageEntry(entry).source;
					if (sourceIdentity(otherSource, scopeBase) === identity) return false;
					const other = parseSource(otherSource);
					return other.kind === "npm" && other.name === name;
				});
				if (recordedNpmNames(scopeBase, source).has(name) || configuredOwner) {
					throw new Error(`Installed npm package ${name} is already owned by another package source`);
				}
				const peers = manifest["peerDependencies"];
				if (peers !== null && typeof peers === "object" && !Array.isArray(peers)) {
					const range = (peers as Record<string, unknown>)["rigyn"];
					if (typeof range === "string" && (validRange(range) === null || !satisfies(RIGYN_VERSION, range))) {
						throw new Error(`Package ${name} requires rigyn ${range}`);
					}
				}
				await this.#activation(source, scope, packagePath, options.signal);
				options.signal?.throwIfAborted();
				const managedRoot = join(scopeBase, "npm", "node_modules");
				const destination = join(managedRoot, name);
				if (!inside(managedRoot, destination)) throw new Error("Installed package name is invalid");
				await mkdir(dirname(destination), { recursive: true });
				await rm(destination, { recursive: true, force: true });
				await cp(packagePath, destination, { recursive: true, dereference: false, errorOnExist: false });
				if (parsed.name === "") await writeNpmSourceReceipt(scopeBase, source, name);
			} catch (error) {
				await restoreReceipts();
				throw error;
			}
		});
	}

	async #installGit(source: string, parsed: Extract<ParsedSource, { kind: "git" }>, scope: "user" | "project", options: PackageInstallOptions): Promise<void> {
		const scopeBase = this.#scopeBase(scope);
		await mkdir(scopeBase, { recursive: true });
		const stageRoot = await mkdtemp(join(scopeBase, ".rigyn-package-stage-"));
		const stage = join(stageRoot, "package");
		try {
			this.#emit({ type: "start", action: "clone", source });
			const advertisedOutput = await run(
				this.#git,
				["ls-remote", parsed.repository, parsed.ref ?? "HEAD"],
				options.signal === undefined ? {} : { signal: options.signal },
			).catch(() => "");
			const advertised = advertisedOutput.trim().split(/\s/u)[0];
			await run(this.#git, ["clone", "--no-checkout", "--", parsed.repository, stage], options.signal === undefined ? {} : { signal: options.signal });
			if (parsed.ref !== undefined) {
				await run(this.#git, ["-C", stage, "fetch", "--depth=1", "--no-tags", "--filter=blob:none", "--recurse-submodules=no", "--", "origin", `refs/heads/${parsed.ref}`], options.signal === undefined ? {} : { signal: options.signal });
				await run(this.#git, ["-C", stage, "checkout", "--no-recurse-submodules", "--detach", "FETCH_HEAD"], options.signal === undefined ? {} : { signal: options.signal });
			}
			if (advertised !== undefined && /^[a-f0-9]{40}$/u.test(advertised)) {
				const checkedOut = (await run(this.#git, ["-C", stage, "rev-parse", "--verify", "HEAD^{commit}"], options.signal === undefined ? {} : { signal: options.signal })).trim();
				if (checkedOut !== advertised) throw new Error("Git ref changed while it was being installed");
			}
			const command = this.#npmCommand();
			if (existsSync(join(stage, "package.json"))) {
				const manager = commandName(command);
				await run(command, ["install", ...(options.allowScripts === true ? [] : manager === "bun" ? ["--ignore-scripts"] : ["--ignore-scripts=true", "--bin-links=false"])], {
					cwd: stage,
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
			}
			await this.#activation(source, scope, stage, options.signal);
			const destination = join(scopeBase, "git", "repositories", sha(sourceIdentity(source, scopeBase).slice(4)));
			await mkdir(dirname(destination), { recursive: true });
			await rm(destination, { recursive: true, force: true });
			await rename(stage, destination);
			this.#emit({ type: "complete", action: "clone", source });
		} finally {
			await rm(stageRoot, { recursive: true, force: true });
		}
	}

	async install(source: string, options: PackageInstallOptions = {}): Promise<void> {
		const scope = options.local === true ? "project" : "user";
		if (scope === "project") this.#assertProject();
		this.#emit({ type: "start", action: "install", source, message: `Installing ${source}...` });
		try {
			const parsed = parseSource(source);
			if (parsed.kind === "local") {
				const path = resolvePath(parsed.value, this.#cwd);
				if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
				await this.#activation(source, scope, path, options.signal);
			} else if (parsed.kind === "npm") await this.#installNpm(source, parsed, scope, options);
			else await this.#installGit(source, parsed, scope, options);
			this.#emit({ type: "complete", action: "install", source });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Package operation failed";
			this.#emit({ type: "error", action: "install", source, message });
			throw error;
		}
	}

	async installAndPersist(source: string, options: PackageInstallOptions = {}): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, { local: options.local === true });
	}

	async remove(source: string, options: { local?: boolean } = {}): Promise<void> {
		const scope = options.local === true ? "project" : "user";
		if (scope === "project") this.#assertProject();
		this.#emit({ type: "start", action: "remove", source });
		try {
			const parsed = parseSource(source);
			if (parsed.kind === "npm") {
				const scopeBase = this.#scopeBase(scope);
				const receiptName = parsed.name === "" ? npmSourceReceiptName(scopeBase, source) : undefined;
				const installed = receiptName === undefined && parsed.name === "" ? this.getInstalledPath(source, scope) : undefined;
				const manifestName = installed === undefined ? undefined : readJson(join(installed, "package.json"), "Installed package manifest")["name"];
				const name = parsed.name || receiptName || (typeof manifestName === "string" ? manifestName : "");
				if (name === "") throw new Error(`Installed npm package could not be identified: ${source}`);
				const command = this.#npmCommand();
				const manager = commandName(command);
				const root = join(scopeBase, "npm");
				await mkdir(root, { recursive: true });
				await run(command, ["uninstall", name, manager === "bun" ? "--cwd" : "--prefix", root, ...(manager === "npm" ? ["--legacy-peer-deps"] : [])]);
				if (parsed.name === "") await rm(npmSourceReceiptPath(scopeBase, source), { force: true });
			} else if (parsed.kind === "git") {
				const repositories = join(this.#scopeBase(scope), "git", "repositories");
				await rm(join(repositories, sha(sourceIdentity(source, this.#scopeBase(scope)).slice(4))), { recursive: true, force: true });
				try {
					if (readdirSync(repositories).length === 0) await rm(repositories, { recursive: true, force: true });
				} catch { /* Already absent. */ }
			}
			this.#emit({ type: "complete", action: "remove", source });
		} catch (error) {
			this.#emit({ type: "error", action: "remove", source, message: error instanceof Error ? error.message : "Package removal failed" });
			throw error;
		}
	}

	async removeAndPersist(source: string, options: { local?: boolean } = {}): Promise<boolean> {
		const scope = options.local === true ? "project" : "user";
		if (scope === "project") this.#assertProject();
		const configured = this.#configuredSource(source, scope);
		if (configured === undefined) throw new Error(`Package source is not configured: ${source}`);
		const parsed = parseSource(configured);
		const restoreReceipts = parsed.kind === "npm" && parsed.name === ""
			? await this.#recoverNpmReceipts(scope)
			: async () => undefined;
		try {
			await this.remove(configured, options);
			return this.removeSourceFromSettings(configured, options);
		} catch (error) {
			await restoreReceipts();
			throw error;
		}
	}

	async #resolveEntries(entries: readonly PackageSource[], scope: PackageScope, onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const result = EMPTY();
		for (const raw of entries) {
			const entry = packageEntry(raw);
			const parsedEntry = parseSource(entry.source);
			let path = scope === "temporary" && parseSource(entry.source).kind === "local"
				? resolvePath(entry.source, this.#cwd)
				: this.getInstalledPath(entry.source, scope === "project" ? "project" : "user");
			if (path === undefined && scope === "project" && entry.autoload === false) {
				path = this.getInstalledPath(entry.source, "user");
			}
			if (path !== undefined && parsedEntry.kind === "npm") {
				const requested = npmSelector(parsedEntry);
				if (requested !== undefined && validRange(requested) !== null) {
					try {
						const installed = readJson(join(path, "package.json"), "Installed package manifest")["version"];
						if (typeof installed !== "string" || !satisfies(installed, requested)) path = undefined;
					} catch { path = undefined; }
				}
			}
			if (path === undefined) {
				if ((this.#offline || process.env.RIGYN_OFFLINE === "1") && parsedEntry.kind !== "local") continue;
				const action = onMissing === undefined ? "install" : await onMissing(entry.source);
				if (action === "error") throw new Error(`Configured package is not installed: ${entry.source}`);
				if (action === "skip") continue;
				await this.install(entry.source, { local: scope === "project" });
				path = this.getInstalledPath(entry.source, scope === "project" ? "project" : "user");
			}
			if (path === undefined) continue;
			const view = packageResources(path, entry, scope);
			this.#diagnostics.push(...view.diagnostics);
			merge(result, view.resources);
		}
		return result;
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		this.#diagnostics = [];
		const result = EMPTY();
		const projectEntries = this.#settings.isProjectTrusted()
			? finalDeclarations(this.#entries("project"), this.#scopeBase("project"))
			: [];
		const userEntries = finalDeclarations(this.#entries("user"), this.#scopeBase("user"));
		const projectIdentities = new Set(projectEntries
			.map(packageEntry)
			.filter((entry) => entry.autoload !== false)
			.map((entry) => sourceIdentity(entry.source, this.#scopeBase("project"))));
		merge(result, await this.#resolveEntries(projectEntries, "project", onMissing));
		merge(result, await this.#resolveEntries(userEntries.filter((raw) => !projectIdentities.has(sourceIdentity(packageEntry(raw).source, this.#scopeBase("user")))), "user", onMissing));

		if (this.#settings.isProjectTrusted()) {
			const projectSettings = this.#settings.getProjectSettings();
			for (const type of TYPES) result[type].push(...topLevel(
				join(this.#cwd, ".rigyn", type), type, "project", projectSettings[type] as string[] | undefined,
			));
			merge(result, extensionRootPackages(join(this.#cwd, ".rigyn", "extensions"), "project"));
		}
		const globalSettings = this.#settings.getGlobalSettings();
		for (const type of TYPES) result[type].push(...topLevel(
			join(this.#agentDir, type), type, "user", globalSettings[type] as string[] | undefined,
		));
		merge(result, extensionRootPackages(join(this.#agentDir, "extensions"), "user"));
		if (this.#settings.isProjectTrusted()) {
			const ancestors: string[] = [];
			for (let cursor = this.#cwd; ; cursor = dirname(cursor)) {
				ancestors.unshift(cursor);
				if (existsSync(join(cursor, ".git")) || dirname(cursor) === cursor) break;
			}
			const projectRules = (this.#settings.getProjectSettings().skills as string[] | undefined) ?? [];
			for (const ancestor of ancestors) {
				if (ancestor === this.#home) continue;
				result.skills.push(...sharedSkills(join(ancestor, ".agents", "skills"), join(ancestor, ".agents"), "project", projectRules));
			}
			for (const directory of [".claude", ".codex"]) {
				if (this.#cwd === this.#home) continue;
				result.skills.push(...sharedSkills(join(this.#cwd, directory, "skills"), join(this.#cwd, directory), "project", projectRules));
			}
		}
		if (this.#homeIsAbsolute) {
			const userRules = (this.#settings.getGlobalSettings().skills as string[] | undefined) ?? [];
			for (const directory of [".agents", ".claude", ".codex"]) {
				result.skills.push(...sharedSkills(join(this.#home, directory, "skills"), join(this.#home, directory), "user", userRules));
			}
		}
		return deduplicate(result);
	}

	async resolveExtensionSources(sources: readonly PackageSource[], options: { local?: boolean; temporary?: boolean } = {}): Promise<ResolvedPaths> {
		const scope: PackageScope = options.temporary === true ? "temporary" : options.local === true ? "project" : "user";
		if (scope === "project") this.#assertProject();
		const result = EMPTY();
		const include = (view: PackageView): void => {
			this.#diagnostics.push(...view.diagnostics);
			merge(result, view.resources);
		};
		for (const raw of sources) {
			const entry = packageEntry(raw);
			const parsed = parseSource(entry.source);
			if (parsed.kind === "local") {
				const path = resolvePath(parsed.value, this.#cwd);
				if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
				const info = statSync(path);
				if (info.isDirectory() && !existsSync(join(path, "package.json")) && !existsSync(join(path, "plugin.json"))) {
					const extensions = directConvention(path).map((extension) => ({
						path: extension,
						enabled: true,
						metadata: { baseDir: path, origin: "package" as const, scope, source: entry.source },
					}));
					if (extensions.length > 0) { result.extensions.push(...extensions); continue; }
				}
				include(packageResources(path, entry, scope));
				continue;
			}
			if (scope === "temporary" && parsed.kind === "npm") {
				const root = join(getExtensionTempFolder(this.#agentDir), "npm", sha(entry.source).slice(0, 8));
				const packagePath = join(root, "node_modules", parsed.name);
				if (!existsSync(packagePath)) {
					await mkdir(root, { recursive: true, mode: 0o700 });
					const command = this.#npmCommand();
					const manager = commandName(command);
					await run(command, [
						"install", parsed.spec, manager === "bun" ? "--cwd" : "--prefix", root,
						...(manager === "bun" ? ["--omit=peer", "--ignore-scripts"]
							: manager === "pnpm" ? ["--ignore-scripts=true", "--config.bin-links=false", "--config.auto-install-peers=false", "--config.strict-peer-dependencies=false", "--config.strict-dep-builds=false"]
								: ["--legacy-peer-deps", "--ignore-scripts=true", "--bin-links=false"]),
					]);
				}
				if (!existsSync(packagePath)) throw new Error(`Temporary npm package could not be identified: ${entry.source}`);
				include(packageResources(packagePath, entry, scope));
				continue;
			}
			if (scope === "temporary" && parsed.kind === "git") {
				const existing = this.getInstalledPath(entry.source, "user");
				if (existing !== undefined) {
					this.#emit({ type: "start", action: "pull", source: entry.source });
					const observer = this.#progress;
					this.#progress = undefined;
					try { await this.#installGit(entry.source, parsed, "user", {}); }
					catch { /* A rejected refresh retains the complete cached checkout. */ }
					finally { this.#progress = observer; }
					this.#emit({ type: "complete", action: "pull", source: entry.source });
					include(packageResources(this.getInstalledPath(entry.source, "user") ?? existing, entry, scope));
					continue;
				}
			}
			let path = this.getInstalledPath(entry.source, scope === "project" ? "project" : "user");
			if (scope === "temporary" || path === undefined) {
				await this.install(entry.source, { local: scope === "project" });
				path = this.getInstalledPath(entry.source, scope === "project" ? "project" : "user");
			}
			if (path !== undefined) include(packageResources(path, entry, scope));
		}
		return deduplicate(result);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		return (["user", "project"] as const).flatMap((scope) => this.#entries(scope).map((raw) => {
			const entry = packageEntry(raw);
			const path = this.getInstalledPath(entry.source, scope);
			return {
				source: entry.source,
				scope,
				filtered: entry.autoload === false || TYPES.some((type) => entry[type] !== undefined),
				...(path === undefined ? {} : { installedPath: path }),
			};
		}));
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		const updates: PackageUpdate[] = [];
		for (const item of this.listConfiguredPackages()) {
			const parsed = parseSource(item.source);
			if (parsed.kind !== "npm" || parsed.name === "" || parsed.spec !== parsed.name || item.installedPath === undefined) continue;
			let current: unknown;
			try { current = readJson(join(item.installedPath, "package.json"), "Installed package manifest")["version"]; } catch { continue; }
			try {
				const output = await run(this.#npmCommand(), ["view", parsed.spec, "version", "--json"]);
				const latest = JSON.parse(output) as unknown;
				if (typeof current === "string" && typeof latest === "string" && valid(latest) !== null && latest !== current) {
					updates.push({ source: item.source, displayName: parsed.name, type: "npm", scope: item.scope });
				}
			} catch { /* An unavailable registry entry has no actionable update. */ }
		}
		return updates;
	}

	async update(source?: string, options: PackageUpdateOptions = {}): Promise<void> {
		const configured = this.listConfiguredPackages();
		const selected = source === undefined ? configured : configured.filter((entry) => entry.source === source);
		if (source !== undefined && selected.length === 0) {
			const needle = source.replace(/^(?:npm|git):/u, "");
			const exact = configured.find((entry) => entry.source.replace(/^(?:npm|git):/u, "") === needle);
			const close = exact ?? configured
				.filter((entry) => entry.source.replace(/^(?:npm|git):/u, "").includes(needle) || needle.includes(entry.source.replace(/^(?:npm|git):/u, "")))
				.sort((left, right) => left.source.length - right.source.length)[0];
			throw new Error(`Package source is not configured: ${source}${close === undefined ? "" : `. Closest configured source: ${close.source}`}`);
		}
		if (this.#offline || process.env.RIGYN_OFFLINE === "1") {
			const moving = selected.filter((entry) => {
				const parsed = parseSource(entry.source);
				if (parsed.kind === "local") return false;
				if (parsed.kind === "git") return parsed.ref === undefined || !/^[a-f0-9]{40}$/u.test(parsed.ref);
				return valid(parsed.spec.slice(parsed.name.length + (parsed.spec === parsed.name ? 0 : 1))) === null;
			});
			if (moving.length > 0) throw new Error(`cannot resolve ${moving[0]!.source} while offline${moving.length > 1 ? ` (${moving.length - 1} more selected network source)` : ""}`);
			return;
		}
		const backupRoot = await mkdtemp(join(getExtensionTempFolder(this.#agentDir), "package-update-backup-"));
		const backups: Array<{ entry: ConfiguredPackage; original?: string; backup?: string }> = [];
		const restoreReceipts: Array<() => Promise<void>> = [];
		try {
			const recoveryScopes = new Set(selected.flatMap((entry) => {
				const parsed = parseSource(entry.source);
				return parsed.kind === "npm" && parsed.name === "" ? [entry.scope] : [];
			}));
			for (const scope of recoveryScopes) restoreReceipts.push(await this.#recoverNpmReceipts(scope, undefined, options));
			for (const [index, entry] of selected.entries()) {
				const original = this.getInstalledPath(entry.source, entry.scope);
				if (original === undefined) { backups.push({ entry }); continue; }
				const backup = join(backupRoot, String(index));
				await cp(original, backup, { recursive: true, dereference: false });
				backups.push({ entry, original, backup });
			}
			const npmByScope = new Map<"user" | "project", string[]>();
			const remaining: ConfiguredPackage[] = [];
			for (const entry of selected) {
				const parsed = parseSource(entry.source);
				if (parsed.kind === "local") continue;
				if (parsed.kind !== "npm" || parsed.name === "") { remaining.push(entry); continue; }
				const selector = npmSelector(parsed);
				if (selector !== undefined && valid(selector) !== null) continue;
				const installedPath = this.getInstalledPath(entry.source, entry.scope);
				const managedRoot = join(this.#scopeBase(entry.scope), "npm", "node_modules");
				let shouldInstall = installedPath === undefined || !inside(managedRoot, installedPath);
				if (!shouldInstall && installedPath !== undefined) {
					let current: unknown;
					try { current = readJson(join(installedPath, "package.json"), "Installed package manifest")["version"]; }
					catch { current = undefined; }
					try {
						const response = JSON.parse(await run(this.#npmCommand(), ["view", parsed.spec, "version", "--json"])) as unknown;
						const latest = Array.isArray(response) && selector !== undefined
							? maxSatisfying(response.filter((value): value is string => typeof value === "string"), selector)
							: typeof response === "string" ? response : undefined;
						shouldInstall = typeof current !== "string" || latest === undefined || current !== latest;
					} catch { shouldInstall = true; }
				}
				if (!shouldInstall) continue;
				const spec = selector === undefined ? `${parsed.name}@latest` : parsed.spec;
				const list = npmByScope.get(entry.scope) ?? [];
				list.push(spec);
				npmByScope.set(entry.scope, list);
			}
			for (const [scope, specs] of npmByScope) {
				if (specs.length === 0) continue;
				const label = `${scope} npm packages`;
				this.#emit({ type: "start", action: "update", source: label });
				const scopeBase = this.#scopeBase(scope);
				await mkdir(scopeBase, { recursive: true });
				const stage = await mkdtemp(join(scopeBase, ".rigyn-package-stage-"));
				try {
					const command = this.#npmCommand();
					const manager = commandName(command);
					await run(command, [
						"install", ...specs, manager === "bun" ? "--cwd" : "--prefix", stage,
						...(manager === "bun" ? ["--omit=peer", ...(options.allowScripts === true ? [] : ["--ignore-scripts"])]
							: manager === "pnpm" ? (options.allowScripts === true
								? ["--ignore-scripts=false", "--config.bin-links=true"]
								: ["--ignore-scripts=true", "--config.bin-links=false", "--config.auto-install-peers=false", "--config.strict-peer-dependencies=false", "--config.strict-dep-builds=false"])
								: ["--legacy-peer-deps", ...(options.allowScripts === true
									? ["--ignore-scripts=false", "--bin-links=true"]
									: ["--ignore-scripts=true", "--bin-links=false"])]),
					], {
						...(options.signal === undefined ? {} : { signal: options.signal }),
						env: {
							...process.env,
							npm_config_ignore_scripts: options.allowScripts === true ? "false" : "true",
							npm_config_bin_links: options.allowScripts === true ? "true" : "false",
						},
					});
					const nodeModules = join(stage, "node_modules");
					if (existsSync(nodeModules)) {
						for (const spec of specs) {
							const name = npmName(spec);
							const candidate = join(nodeModules, name);
							if (!existsSync(candidate)) continue;
							await this.#activation(`npm:${spec}`, scope, candidate, options.signal);
							const destination = join(scopeBase, "npm", "node_modules", name);
							await mkdir(dirname(destination), { recursive: true });
							await rm(destination, { recursive: true, force: true });
							await cp(candidate, destination, { recursive: true, dereference: false });
						}
					}
				} finally { await rm(stage, { recursive: true, force: true }); }
				this.#emit({ type: "complete", action: "update", source: label });
			}
			for (const entry of remaining) {
				await this.install(entry.source, {
					local: entry.scope === "project",
					...(options.allowScripts === undefined ? {} : { allowScripts: options.allowScripts }),
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
			}
		} catch (error) {
			for (const saved of backups) {
				const current = this.getInstalledPath(saved.entry.source, saved.entry.scope);
				if (current !== undefined) await rm(current, { recursive: true, force: true });
				if (saved.original !== undefined && saved.backup !== undefined) {
					await mkdir(dirname(saved.original), { recursive: true });
					await cp(saved.backup, saved.original, { recursive: true, dereference: false });
				}
			}
			for (const restore of restoreReceipts.toReversed()) await restore();
			throw error;
		} finally {
			await rm(backupRoot, { recursive: true, force: true });
		}
	}
}
