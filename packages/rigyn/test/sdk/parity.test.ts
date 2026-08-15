import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import type { ObservabilitySink } from "../../src/core/observability.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import type { RuntimeInlineExtension } from "../../src/extensions/runtime.js";
import { createInMemoryHarness } from "../../src/embedding/index.js";
import { providerFromAdapter } from "../../src/providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "../../src/sdk/index.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

const SOL = "gpt-5.6-sol";
const CALLER_MODEL = "caller-supplied-model";

async function modelRuntime(modelIds: readonly string[] = [CALLER_MODEL, SOL]): Promise<ModelRuntime> {
	const adapter = createScriptedProvider({
		id: "openai-codex",
		models: modelIds.map((id) => ({ id, capabilities: { reasoning: "supported" } })),
		scripts: [],
	});
	const models = createModels();
	models.setProvider(providerFromAdapter(adapter, {
		initialModels: adapter.models.map((model) => ({
			...model,
			compatibility: {
				...model.compatibility,
				protocolFamily: {
					value: "openai-chat-completions" as const,
					source: "configuration" as const,
					observedAt: "2026-08-11T00:00:00.000Z",
				},
			},
		})),
		auth: {
			apiKey: {
				name: "Parity fixture",
				async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
			},
		},
	}));
	const runtime = await ModelRuntime.create({ models, modelsPath: null, allowModelNetwork: false });
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

async function workspace(prefix: string): Promise<{ root: string; cwd: string; agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	return { root, cwd, agentDir };
}

test("SDK defaults to stable Sol, preserves an explicit caller model, and owns no terminal or sink", async () => {
	const { root, cwd, agentDir } = await workspace("rigyn-sdk-default-");
	const runtime = await modelRuntime();
	const writes: string[] = [];
	let flushes = 0;
	let closes = 0;
	const sink: ObservabilitySink = {
		record() {},
		async flush() { flushes += 1; },
		async close() { closes += 1; },
	};
	const originalError = console.error;
	console.error = (value: unknown) => { writes.push(String(value)); };
	try {
		const implicit = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			observabilitySink: sink,
			noTools: "all",
		});
		assert.equal(implicit.session.model?.id, SOL);
		assert.deepEqual(await implicit.session.recoverInterruptedRun(), { recovered: false, blocked: [] });
		await implicit.session.close();

		const callerModel = runtime.getModel("openai-codex", CALLER_MODEL);
		assert.ok(callerModel);
		const explicit = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model: callerModel,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			noTools: "all",
		});
		assert.equal(explicit.session.model?.id, CALLER_MODEL);
		await explicit.session.close();
	} finally {
		console.error = originalError;
		await runtime.close();
		await rm(root, { recursive: true, force: true });
	}
	assert.deepEqual(writes, []);
	assert.equal(flushes > 0, true);
	assert.equal(closes, 0, "the caller retains ownership of its observability sink");
});

test("direct, reusable-service, owner-runtime, and narrow embedding factories retain their intended session boundary", async () => {
	const { root, cwd, agentDir } = await workspace("rigyn-sdk-parity-");
	const runtime = await modelRuntime();
	const model = runtime.getModel("openai-codex", SOL);
	assert.ok(model);
	const extension: RuntimeInlineExtension = {
		name: "sdk-parity",
		factory(api) {
			api.registerTool({
				name: "parity_probe",
				description: "SDK capability parity probe",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				async execute() { return { content: [{ type: "text", text: "ok" }], details: null }; },
			});
		},
	};
	const directLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		extensionFactories: [extension],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await directLoader.refresh();
	const directManager = SessionManager.inMemory(cwd, { id: "direct" });
	const direct = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "high",
		resourceLoader: directLoader,
		sessionManager: directManager,
		settingsManager: SettingsManager.inMemory(),
		noTools: "builtin",
	});
	await direct.session.bindExtensions({ mode: "sdk" });

	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			extensionFactories: [extension],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	});
	const reusableManager = SessionManager.inMemory(cwd, { id: "reusable" });
	const reusable = await createAgentSessionFromServices({
		services,
		sessionManager: reusableManager,
		model,
		thinkingLevel: "high",
		noTools: "builtin",
	});
	await reusable.session.bindExtensions({ mode: "sdk" });

	const owner = await createAgentSessionRuntime(async (request) => {
		const loader = new DefaultResourceLoader({
			cwd: request.cwd,
			agentDir: request.agentDir,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [extension],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await loader.refresh();
		const created = await createAgentSession({
			cwd: request.cwd,
			agentDir: request.agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: "high",
			resourceLoader: loader,
			sessionManager: request.sessionManager,
			settingsManager: SettingsManager.inMemory(),
			noTools: "builtin",
		});
		await created.session.bindExtensions({ mode: "sdk" });
		return {
			...created,
			services: {
				cwd: request.cwd,
				agentDir: request.agentDir,
				async close() { await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close(); },
			},
		};
	}, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd, { id: "owner" }),
	});

	for (const [session, manager] of [
		[direct.session, directManager],
		[reusable.session, reusableManager],
		[owner.session, owner.session.nativeSessionManager],
	] as const) {
		assert.equal(session.model?.id, SOL);
		assert.equal(session.thinkingLevel, "high");
		assert.deepEqual(session.getActiveTools(), ["parity_probe"]);
		assert.equal(session.nativeSessionManager, manager);
		assert.deepEqual(await session.recoverInterruptedRun(), { recovered: false, blocked: [] });
	}

	const narrowProvider = createScriptedProvider({
		id: "narrow-parity",
		models: [{ id: "narrow-model", capabilities: { reasoning: "supported" } }],
		scripts: [{ kind: "turn", content: [{ type: "text", text: "narrow complete" }] }],
	});
	await using narrow = await createInMemoryHarness({
		provider: narrowProvider,
		model: "narrow-model",
		api: "openai-chat-completions",
		workspace: cwd,
	});
	narrow.session.setThinkingLevel("high");
	assert.equal(narrow.session.model?.id, "narrow-model");
	assert.deepEqual(await narrow.session.recoverInterruptedRun(), { recovered: false, blocked: [] });
	assert.equal((await narrow.session.run({ prompt: "verify narrow facade" })).results.at(-1)?.finalText, "narrow complete");

	await owner.dispose();
	await reusable.session.close();
	await direct.session.close();
	await Promise.all([
		getExtensionRuntimeHost(services.resourceLoader.getExtensions().runtime)?.close(),
		getExtensionRuntimeHost(directLoader.getExtensions().runtime)?.close(),
	]);
	await runtime.close();
	await rm(root, { recursive: true, force: true });
});
