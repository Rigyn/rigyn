import { resolve } from "node:path";

import type { Api, Model } from "@rigyn/models";

import { getAgentDir } from "../config/paths.js";
import {
	DefaultResourceLoader,
	type ResourceExtensionsResult,
	type ResourceLoader,
} from "../core/resource-loader.js";
import {
	RuntimeObservability,
	resolveObservabilityLevel,
	type ObservabilitySink,
} from "../core/observability.js";
import { SettingsManager, type ThinkingLevel } from "../core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";
import type { SessionStartEvent, ToolDefinition } from "../extensions/direct.js";
import {
	ensureExtensionRuntimeHost,
	getExtensionRuntimeHost,
} from "../extensions/compat.js";
import {
	extensionModelRegistry,
	protocolFromPublicApi,
} from "../extensions/model-boundary.js";
import {
	bindDirectProviderWireLifecycle,
	directToolRendererBinding,
	type RuntimeExtensionHost,
} from "../extensions/runtime.js";
import { providerAdapterFromModels } from "../providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../providers/model-compat.js";
import { modelRuntimeForInternalRegistry } from "../providers/model-runtime-ownership.js";
import type { ProviderModel } from "../providers/models.js";
import { ModelRegistry as PublicModelRegistry } from "../providers/public-model-registry.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { ProviderWireLifecycleHost } from "../providers/wire.js";
import { AgentSession } from "../service/agent-session.js";
import {
	attachAgentSessionOwner,
	deferAgentSessionSelection,
} from "../service/agent-session-owner.js";
import { getDefaultSessionDir, SessionManager } from "../storage/session-manager.js";
import { allToolNames } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/backend.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import {
	createHarnessToolFromDefinition,
	isHarnessTool,
	type AgentSessionTool,
} from "../tools/direct-tool.js";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd(). */
	cwd?: string;
	/** Global configuration directory. Default: ~/.rigyn. */
	agentDir?: string;
	/** Canonical model/auth runtime. */
	modelRuntime?: PublicModelRegistry | ModelRuntime;
	/** Lifecycle host already connected to a caller-owned model transport. */
	providerWireLifecycle?: ProviderWireLifecycleHost;
	/** Initial model. Restored session state and configured defaults are used when omitted. */
	model?: ProviderModel | Model<Api>;
	/** Initial thinking level. */
	thinkingLevel?: ThinkingLevel;
	/** Models available to model cycling. */
	scopedModels?: Array<{ model: ProviderModel | Model<Api>; thinkingLevel?: ThinkingLevel }>;
	/** Disable model cycling without changing the selected model. Defaults to true. */
	modelCyclingEnabled?: boolean;
	/** Suppress every tool, or only the default built-ins. */
	noTools?: "all" | "builtin";
	/** Exact active-tool allowlist. */
	tools?: string[];
	/** Tool names removed after the allowlist/default policy. */
	excludeTools?: string[];
	/** Custom tools registered alongside built-ins and extension tools. */
	customTools?: AgentSessionTool[];
	/** Optional host-owned execution boundary for the tools it explicitly claims. */
	toolBackend?: ToolExecutionBackend;
	/** Optional host-owned gate for model-requested tool effects. */
	toolAuthorizationHandler?: ToolAuthorizationHandler;
	/** Resource loader. Default: DefaultResourceLoader with normal discovery. */
	resourceLoader?: ResourceLoader;
	/** Session manager. Default: a new persistent session for cwd. */
	sessionManager?: SessionManager;
	/** Settings manager. Default: SettingsManager.create(cwd, agentDir). */
	settingsManager?: SettingsManager;
	/** Metadata supplied to the initial extension session_start event. */
	sessionStartEvent?: SessionStartEvent;
	/** Caller-owned destination for metadata-only records. Omit to keep SDK sessions silent. */
	observabilitySink?: ObservabilitySink;
}

export type LoadExtensionsResult = ResourceExtensionsResult;

export interface CreateAgentSessionResult {
	session: AgentSession;
	extensionsResult: LoadExtensionsResult;
	modelFallbackMessage?: string;
}

const STABLE_DEFAULT_MODEL = "gpt-5.6-sol";

function publicRuntime(value: PublicModelRegistry | ModelRuntime): ModelRuntime {
	return value instanceof ModelRuntime
		? value
		: modelRuntimeForInternalRegistry(value.internalRegistry());
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function findConfiguredModel(
	models: readonly Model<Api>[],
	settings: SettingsManager,
): Model<Api> | undefined {
	const provider = settings.getDefaultProvider();
	const id = settings.getDefaultModel();
	if (id === undefined) return undefined;
	return models.find((model) => model.id === id && (provider === undefined || model.provider === provider));
}

function stableDefault(models: readonly Model<Api>[]): Model<Api> | undefined {
	return models.find((model) => model.provider === "openai-codex" && model.id === STABLE_DEFAULT_MODEL)
		?? models.find((model) => model.provider === "openai" && model.id === STABLE_DEFAULT_MODEL)
		?? models.find((model) => model.id === STABLE_DEFAULT_MODEL);
}

function implicitDefault(models: readonly Model<Api>[]): Model<Api> | undefined {
	return stableDefault(models)
		?? models[0];
}

function customToolNames(tools: readonly AgentSessionTool[]): string[] {
	return tools.map((tool) => isHarnessTool(tool) ? tool.definition.name : tool.name);
}

function splitCustomTools(tools: readonly AgentSessionTool[]): {
	harness: AgentSessionTool[];
	direct: ToolDefinition[];
} {
	const harness: AgentSessionTool[] = [];
	const direct: ToolDefinition[] = [];
	for (const tool of tools) {
		if (isHarnessTool(tool)) {
			harness.push(tool);
			continue;
		}
		if (typeof tool === "object" && tool !== null && "definition" in tool) {
			void (tool as { definition: unknown }).definition;
			throw new TypeError("SDK custom harness tool has an invalid definition");
		}
		direct.push(tool as ToolDefinition);
	}
	return { harness, direct };
}

function discoveryView(host: RuntimeExtensionHost, loader: ResourceLoader) {
	const maximum = 512;
	const commands = [
		...BUILTIN_SLASH_COMMANDS.map((command) => ({
			kind: "command" as const,
			source: "builtin" as const,
			name: command.name,
			...(command.description === undefined ? {} : { description: command.description }),
			...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
		})),
		...host.commands().map((command) => ({
			kind: "command" as const,
			source: "runtime_extension" as const,
			name: command.name,
			extensionId: command.extensionId,
			...(command.description === undefined ? {} : { description: command.description }),
			...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
		})),
	];
	const prompts = loader.getPrompts().prompts.map((prompt) => ({
		kind: "prompt" as const,
		name: prompt.name,
		extensionId: prompt.sourceInfo.source,
		...(prompt.description === "" ? {} : { description: prompt.description }),
		...(prompt.argumentHint === undefined ? {} : { argumentHint: prompt.argumentHint }),
	}));
	const skills = loader.getSkills().skills.map((skill) => ({
		kind: "skill" as const,
		name: skill.name,
		description: skill.description,
		scope: skill.sourceInfo.scope === "user" ? "user" as const : "workspace" as const,
		trusted: true,
		disableModelInvocation: skill.disableModelInvocation,
	}));
	return {
		resources: [
			...commands.slice(0, maximum),
			...prompts.slice(0, maximum),
			...skills.slice(0, maximum),
		],
		truncated: commands.length > maximum || prompts.length > maximum || skills.length > maximum,
		omitted: {
			commands: Math.max(0, commands.length - maximum),
			prompts: Math.max(0, prompts.length - maximum),
			skills: Math.max(0, skills.length - maximum),
		},
	};
}

function nativeModel(
	runtime: ModelRuntime,
	model: ProviderModel | Model<Api>,
): ProviderModel {
	return runtime.internalRegistry().find(model.provider, model.id)
		?? extensionModelRegistry(runtime.internalRegistry()).resolve(model as Model<Api>);
}

/** Create one directly composed AgentSession without terminal ownership. */
export async function createAgentSession(
	options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const cwd = resolve(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const settings = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const ownedModelRuntime = options.modelRuntime === undefined
		? await ModelRuntime.create({
			authPath: resolve(agentDir, "auth.json"),
			modelsPath: resolve(agentDir, "model-providers.json"),
		})
		: undefined;
	const modelRuntime = ownedModelRuntime ?? publicRuntime(options.modelRuntime!);
	const models = modelRuntime.models();
	const providers = new ProviderRegistry(
		models.getProviders().map((provider) => providerAdapterFromModels(models, provider.id)),
	);
	const manager = options.sessionManager
		?? SessionManager.create(cwd, settings.getSessionDir() ?? getDefaultSessionDir(cwd, agentDir));
	const loader = options.resourceLoader ?? new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
	let session: AgentSession | undefined;
	let extensionsResult: ResourceExtensionsResult | undefined;
	let observability: RuntimeObservability | undefined;
	const wireCleanups = new Set<() => void>();
	let ownedExtensionHost: RuntimeExtensionHost | undefined;
	try {
		if (options.providerWireLifecycle !== undefined && options.modelRuntime === undefined) {
			throw new Error("providerWireLifecycle requires a caller-supplied modelRuntime");
		}
		if (options.resourceLoader === undefined) await loader.refresh();
		extensionsResult = loader.getExtensions();
		const suppliedHost = getExtensionRuntimeHost(extensionsResult.runtime);
		const extensionHost = suppliedHost ?? ensureExtensionRuntimeHost(extensionsResult.runtime, cwd);
		if (options.resourceLoader === undefined || suppliedHost === undefined) ownedExtensionHost = extensionHost;
		const configureHost = (host: RuntimeExtensionHost): void => {
			if (options.resourceLoader === undefined) ownedExtensionHost = host;
			host.setDirectDiscoveryHandler((signal) => {
				signal?.throwIfAborted();
				return discoveryView(host, loader);
			});
			if (options.providerWireLifecycle === undefined) return;
			const cleanup = bindDirectProviderWireLifecycle(host, options.providerWireLifecycle);
			wireCleanups.add(cleanup);
			host.addRegistrationCleanup(() => {
				wireCleanups.delete(cleanup);
				cleanup();
			});
		};
		configureHost(extensionHost);
		observability = options.observabilitySink === undefined
			? undefined
			: new RuntimeObservability(options.observabilitySink, {
				mode: "sdk",
				level: resolveObservabilityLevel(settings.getObservabilityLevel()),
				closeSink: false,
			});
		const customInputs = options.customTools ?? [];
		const custom = splitCustomTools(customInputs);
		const harnessTools = customInputs.map((tool) => isHarnessTool(tool)
			? tool
			: createHarnessToolFromDefinition(tool, () => {
				if (session === undefined) throw new Error("SDK tool context is not ready");
				return session.createReplacedSessionContext();
			}));
		const renderer = directToolRendererBinding(
			custom.direct,
			cwd,
			(diagnostic) => extensionHost?.addDiagnostic({
				extensionId: "sdk",
				sourcePath: "<sdk:custom-tool>",
				message: diagnostic.message,
			}),
		);
		const callerNames = customToolNames(customInputs);
		const extensionToolNames = extensionHost.tools().map((tool) => tool.definition.name);
		const explicitToolPolicy = options.tools !== undefined
			|| options.noTools !== undefined
			|| options.excludeTools !== undefined;
		const scopedModels = options.scopedModels?.map((entry) => ({
			model: nativeModel(modelRuntime, entry.model),
			...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
		}));
		const selectedNames = options.tools !== undefined
			? options.tools
			: options.noTools === "all"
				? []
				: options.noTools === "builtin"
					? [...callerNames, ...extensionToolNames]
					: [...allToolNames, ...callerNames, ...extensionToolNames];
		session = await AgentSession.create({
			sessionManager: manager,
			providers,
			modelRegistry: modelRuntime.internalRegistry(),
			...(options.providerWireLifecycle === undefined
				? {}
				: { providerWireLifecycle: options.providerWireLifecycle }),
			resourceLoader: loader,
			extensionsResult,
			workspace: cwd,
			agentDirectory: agentDir,
			settingsManager: settings,
			projectTrusted: settings.isProjectTrusted(),
			...(observability === undefined ? {} : { observability }),
			...(harnessTools.length === 0 ? {} : { tools: harnessTools }),
			...(renderer === undefined ? {} : { toolRendererBinding: renderer }),
			...(explicitToolPolicy ? {
				initialToolSelection: {
					names: [...new Set(selectedNames)],
					excludedNames: [...new Set(options.excludeTools ?? [])],
					activateExtensionToolsOnBind: options.tools === undefined && options.noTools !== "all",
				},
			} : {}),
			...(options.toolBackend === undefined ? {} : { toolBackend: options.toolBackend }),
			...(options.toolAuthorizationHandler === undefined
				? {}
				: { toolAuthorizationHandler: options.toolAuthorizationHandler }),
			...(scopedModels === undefined ? {} : { scopedModels }),
			...(options.modelCyclingEnabled === undefined
				? {}
				: { modelCyclingEnabled: options.modelCyclingEnabled }),
			...(options.sessionStartEvent === undefined ? {} : { sessionStartEvent: options.sessionStartEvent }),
			refresh: async () => {
				const host = getExtensionRuntimeHost(loader.getExtensions().runtime);
				if (host !== undefined) configureHost(host);
			},
		});

		const persisted = manager.buildSessionContext().model;
		const missingPersisted = persisted !== null && session.nativeModel === undefined;
		const available = modelRuntime.getAvailableSnapshot();
		const configured = findConfiguredModel(modelRuntime.getModels(), settings);
		const scopedFirst = options.scopedModels?.[0]?.model;
		const selected = options.model
			?? (session.model === undefined ? configured : undefined)
			?? (session.model === undefined ? scopedFirst : undefined)
			?? (session.model === undefined ? implicitDefault(available) : undefined);
		const hasPersistedThinking = manager.getEntries().some((entry) => entry.type === "thinking_level_change");
		const requestedThinking = (options.thinkingLevel
			?? (hasPersistedThinking ? session.thinkingLevel : settings.getDefaultThinkingLevel() ?? "medium")) as ThinkingLevel;
		if (session.suspendedRun === undefined) {
			if (selected !== undefined) await session.setModel(selected);
			session.setThinkingLevel(requestedThinking);
		} else {
			const restoredModel = session.model;
			const pendingModel = selected === undefined || (
				restoredModel !== undefined &&
				restoredModel.provider === selected.provider &&
				restoredModel.id === selected.id &&
				protocolFromPublicApi(restoredModel.api) === protocolFromPublicApi(selected.api)
			) ? undefined : selected;
			deferAgentSessionSelection(session, {
				...(pendingModel === undefined ? {} : { model: pendingModel }),
				...(requestedThinking === session.thinkingLevel ? {} : { thinkingLevel: requestedThinking }),
			});
		}
		if (options.resourceLoader === undefined) await session.bindExtensions({ mode: "sdk" });

		attachAgentSessionOwner(session, async () => {
			const failures: unknown[] = [];
			for (const cleanup of [...wireCleanups]) {
				try { cleanup(); }
				catch (error) { failures.push(error); }
			}
			wireCleanups.clear();
			try { await ownedExtensionHost?.close(); }
			catch (error) { failures.push(error); }
			try { await observability?.close(); }
			catch (error) { failures.push(error); }
			try { await ownedModelRuntime?.close(); }
			catch (error) { failures.push(error); }
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "SDK session cleanup failed");
		});
		const fallbackModel = session.model ?? (session.suspendedRun === undefined ? undefined : selected);
		const fallback = missingPersisted && fallbackModel !== undefined
			? `Could not restore model ${persisted.provider}/${persisted.modelId}. Using ${modelKey(fallbackModel)}.`
			: undefined;
		return {
			session,
			extensionsResult,
			...(fallback === undefined ? {} : { modelFallbackMessage: fallback }),
		};
	} catch (error) {
		if (session !== undefined) await session.close().catch(() => undefined);
		else manager.closeV4Store();
		if (session === undefined) {
			extensionsResult?.runtime.invalidate("Extension runtime disposed after SDK construction failure");
		}
		for (const cleanup of wireCleanups) {
			try { cleanup(); } catch { /* Preserve the construction failure. */ }
		}
		await ownedExtensionHost?.close().catch(() => undefined);
		await observability?.close().catch(() => undefined);
		await ownedModelRuntime?.close().catch(() => undefined);
		throw error;
	}
}

export { AgentSession, parseSkillBlock } from "../service/agent-session.js";
export type {
	AgentSessionAgent,
	AgentSessionAgentState,
	AgentSessionBashResult,
	AgentSessionConfig,
	AgentSessionEnvelopeListener,
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionInputImage,
	AgentSessionModel,
	AgentSessionModelCycleResult,
	AgentSessionOptions,
	AgentSessionPromptOptions,
	AgentSessionReplacedContext,
	AgentSessionRun,
	AgentSessionNativeScopedModel,
	AgentSessionScopedModel,
	AgentSessionState,
	AgentSessionStats,
	AgentSessionToolInfo,
	AgentSessionTreeNavigationResult,
	AgentSessionUsageBreakdownEntry,
	ExtensionBindings,
	ModelCycleResult,
	ParsedSkillBlock,
	PromptOptions,
	SessionStats,
} from "../service/agent-session.js";
export { SessionManager } from "../storage/session-manager.js";
export type { ReadonlySessionManager } from "../storage/session-manager.js";
export type { SessionBranchQuery } from "../storage/types.js";
export { DefaultResourceLoader, loadProjectContextFiles } from "../core/resource-loader.js";
export type { ResourceExtensionsResult, ResourceLoader } from "../core/resource-loader.js";
export { loadPromptTemplates } from "../core/prompt-templates.js";
export type { PromptTemplate } from "../core/prompt-templates.js";
export { formatSkillsForPrompt, loadSkills, loadSkillsFromDir } from "../core/skills.js";
export type {
	LoadSkillsFromDirOptions,
	LoadSkillsOptions,
	LoadSkillsResult,
	Skill,
	SkillFrontmatter,
} from "../core/skills.js";
export { discoverSkills, discoverSkillsDetailed, loadSkill } from "../context/skills.js";
export { SettingsManager } from "../core/settings-manager.js";
export type { FullscreenScrollbar, PersistedSettings, ThinkingLevel } from "../core/settings-manager.js";
export { ModelRegistry } from "../providers/public-model-registry.js";
export { ModelRuntime } from "../providers/model-compat.js";
export type { ProviderModel } from "../providers/models.js";
export type { ProviderWireLifecycleHost } from "../providers/wire.js";
export { defineTool } from "../extensions/direct.js";
export type {
	DurableToolEffect,
	ResourceClaim,
	ToolDefinition,
	ToolRecoveryContext,
	ToolRecoveryContract,
	ToolRecoveryMode,
	ToolRecoveryResult,
} from "../extensions/direct.js";
export type { ToolContext } from "../tools/types.js";
export { createHarnessToolFromDefinition, isHarnessTool } from "../tools/direct-tool.js";
export type { AgentSessionTool, AgentTool } from "../tools/direct-tool.js";
export type { HarnessTool } from "../tools/types.js";
export {
	allToolNames,
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
	createTool,
	createToolDefinition,
} from "../tools/catalog.js";
export type { Tool, ToolDef, ToolName, ToolsOptions } from "../tools/catalog.js";
export { withFileMutationQueue } from "../tools/file-mutation-queue.js";
export type { ToolExecutionBackend } from "../tools/backend.js";
export type {
	ToolAuthorizationContext,
	ToolAuthorizationDecision,
	ToolAuthorizationHandler,
	ToolAuthorizationOwner,
	ToolAuthorizationRequest,
} from "../tools/approval.js";
export {
	AgentSessionRuntime,
	SessionImportFileNotFoundError,
	createAgentSessionRuntime,
} from "../service/agent-session-runtime.js";
export type {
	AgentSessionRuntimeLifecycle,
	AgentSessionRuntimeDiagnostic,
	AgentSessionRuntimeServices,
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
	SessionGuardResult,
} from "../service/agent-session-runtime.js";
export {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../service/agent-session-services.js";
export type {
	AgentSessionServices,
	CreateAgentSessionFromServicesOptions,
	CreateAgentSessionServicesOptions,
} from "../service/agent-session-services.js";
