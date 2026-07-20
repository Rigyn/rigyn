import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { SkillMetadata } from "../context/skills.js";
import type { ImageBlock, ProviderAdapter } from "../core/types.js";
import {
  createEmbeddingHarnessFromRuntime,
  type EmbeddingHarness,
  type EmbeddingModelSelection,
  type EmbeddingRunHandle,
  type EmbeddingRunOptions,
  type EmbeddingSession,
  type EmbeddingSessionCompactOptions,
  type EmbeddingSessionCreateOptions,
  type EmbeddingSessionEventListener,
  type EmbeddingSessionForkOptions,
  type EmbeddingSessionNavigateOptions,
  type EmbeddingSessionNavigateResult,
  type EmbeddingSessionOpenOptions,
  type EmbeddingSessionRunOptions,
} from "../embedding/index.js";
import { renderExtensionPrompt } from "../extensions/templates.js";
import type { ExtensionPromptTemplate } from "../extensions/types.js";
import { createHarnessRuntime, type CreateHarnessRuntimeOptions, type HarnessRuntime } from "../public-runtime.js";
import type { HarnessRun } from "../service/harness.js";
import type { HarnessResourceCatalog } from "../service/resource-catalog.js";
import type { HarnessSessionListRequest, HarnessSessionPage } from "../service/session-catalog.js";
import type { HarnessTranscriptPage, HarnessTranscriptRequest } from "../service/transcript.js";
import { sha256 } from "../tools/hash.js";
import type { HarnessTool } from "../tools/types.js";

const MAX_FACTORIES = 64;
const MAX_PROGRAMMATIC_PROVIDERS = 64;
const MAX_PROGRAMMATIC_TOOLS = 256;
const MAX_PROGRAMMATIC_SKILLS = 512;
const MAX_PROGRAMMATIC_TEMPLATES = 512;
const MAX_RESOURCE_PATHS = 512;
const MAX_TEMPLATE_BYTES = 1024 * 1024;

export type RigynSdkRunDefaults = Omit<
  Partial<EmbeddingRunOptions>,
  "prompt" | "provider" | "model" | "signal" | "threadId" | "onEvent"
> & {
  selection?: EmbeddingModelSelection;
};

export type RigynSdkRunOptions = Omit<
  EmbeddingRunOptions,
  "provider" | "model" | "threadId"
> & {
  selection?: EmbeddingModelSelection;
};

export type RigynSdkSessionRunOptions = EmbeddingSessionRunOptions;

export interface RigynSdkContextDefaults {
  systemPrompt?: NonNullable<EmbeddingRunOptions["systemPrompt"]>;
  appendSystemPrompt?: NonNullable<EmbeddingRunOptions["appendSystemPrompt"]>;
  additionalInstructions?: NonNullable<EmbeddingRunOptions["additionalInstructions"]>;
}

export interface RigynSdkPromptTemplate {
  id: string;
  template: string;
  description?: string;
  argumentHint?: string;
}

export interface RigynSdkPromptTemplateDescription {
  id: string;
  description?: string;
  argumentHint?: string;
  sha256: string;
}

export interface RigynSdkComposition {
  providers?: readonly ProviderAdapter[];
  tools?: readonly HarnessTool[];
  skills?: readonly SkillMetadata[];
  templates?: readonly RigynSdkPromptTemplate[];
  extensionPaths?: readonly string[];
  packagePaths?: readonly string[];
  skillPaths?: readonly string[];
  promptTemplatePaths?: readonly string[];
  themePaths?: readonly string[];
  context?: RigynSdkContextDefaults;
  dispose?: () => void | Promise<void>;
}

export interface RigynSdkFactoryContext {
  readonly workspace: string;
  /** Aborts before composition disposal begins. */
  readonly signal: AbortSignal;
}

export type RigynSdkExtensionFactory = (
  context: RigynSdkFactoryContext,
) => RigynSdkComposition | void | Promise<RigynSdkComposition | void>;

export type RigynSdkResourceLoader = RigynSdkExtensionFactory;

export interface RigynSdkExtensionsOptions {
  enabled?: boolean;
  paths?: readonly string[];
  packages?: readonly string[];
  allowPackageScripts?: boolean;
  factories?: readonly RigynSdkExtensionFactory[];
}

export interface RigynSdkResourcesOptions {
  skills?: boolean;
  skillPaths?: readonly string[];
  skillMetadata?: readonly SkillMetadata[];
  promptTemplates?: boolean;
  promptTemplatePaths?: readonly string[];
  templates?: readonly RigynSdkPromptTemplate[];
  themes?: boolean;
  themePaths?: readonly string[];
  loaders?: readonly RigynSdkResourceLoader[];
}

export type RigynSdkRuntimeOptions = Pick<
  CreateHarnessRuntimeOptions,
  "projectTrusted" | "recover" | "sessionDirectory"
>;

export interface CreateRigynSdkOptions {
  workspace?: string;
  provider?: ProviderAdapter;
  providers?: readonly ProviderAdapter[];
  tools?: readonly HarnessTool[];
  extensions?: RigynSdkExtensionsOptions;
  resources?: RigynSdkResourcesOptions;
  context?: RigynSdkContextDefaults;
  defaultSelection?: EmbeddingModelSelection;
  runDefaults?: RigynSdkRunDefaults;
  runtime?: RigynSdkRuntimeOptions;
}

export interface RigynSdkSession {
  readonly threadId: string;
  readonly branch: string;
  start(options: RigynSdkSessionRunOptions): Promise<EmbeddingRunHandle>;
  run(options: RigynSdkSessionRunOptions): Promise<HarnessRun>;
  steer(message: string, images?: ImageBlock[]): void;
  followUp(message: string, images?: ImageBlock[]): void;
  abort(reason?: string): void;
  compact(options?: EmbeddingSessionCompactOptions): Promise<Awaited<ReturnType<EmbeddingSession["compact"]>>>;
  fork(options?: EmbeddingSessionForkOptions): Promise<RigynSdkSession>;
  navigate(options: EmbeddingSessionNavigateOptions): Promise<EmbeddingSessionNavigateResult>;
  transcript(input?: Omit<HarnessTranscriptRequest, "threadId" | "branch">): Promise<HarnessTranscriptPage>;
  setName(name?: string, signal?: AbortSignal): Promise<void>;
  getModel(): EmbeddingModelSelection | undefined;
  setModel(selection: EmbeddingModelSelection, signal?: AbortSignal): Promise<EmbeddingModelSelection>;
  subscribe(listener: EmbeddingSessionEventListener): () => void;
}

/** A narrow owner facade. Provider registries, credential stores, session stores, and agent internals stay private. */
export interface RigynSdk {
  readonly workspace: string;
  readonly trusted: boolean;
  start(options: RigynSdkRunOptions): Promise<EmbeddingRunHandle>;
  run(options: RigynSdkRunOptions): Promise<HarnessRun>;
  createSession(options?: EmbeddingSessionCreateOptions): Promise<RigynSdkSession>;
  openSession(options: EmbeddingSessionOpenOptions): Promise<RigynSdkSession>;
  listSessions(options?: HarnessSessionListRequest): Promise<HarnessSessionPage>;
  waitForIdle(signal?: AbortSignal): Promise<void>;
  resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog>;
  reload(options?: { signal?: AbortSignal }): Promise<{ warnings: string[] }>;
  promptTemplates(): RigynSdkPromptTemplateDescription[];
  renderPrompt(id: string, input?: string): string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

interface ResolvedSdkComposition {
  providers: ProviderAdapter[];
  tools: HarnessTool[];
  skills: SkillMetadata[];
  templates: ExtensionPromptTemplate[];
  extensionPaths: string[];
  packagePaths: string[];
  skillPaths: string[];
  promptTemplatePaths: string[];
  themePaths: string[];
  context: RigynSdkContextDefaults;
  disposers: Array<() => void | Promise<void>>;
}

function optionalEntries<T>(values: readonly T[] | undefined): T[] {
  return values === undefined ? [] : [...values];
}

function boundedCount(length: number, maximum: number, label: string): void {
  if (length > maximum) throw new RangeError(`${label} exceeds ${maximum}`);
}

function templateEntry(value: RigynSdkPromptTemplate): ExtensionPromptTemplate {
  const id = value.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id !== value.id) {
    throw new Error(`Invalid SDK prompt template id: ${value.id}`);
  }
  if (value.template.includes("\0")) throw new Error(`SDK prompt template ${id} contains NUL`);
  if (Buffer.byteLength(value.template, "utf8") > MAX_TEMPLATE_BYTES) {
    throw new RangeError(`SDK prompt template ${id} exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }
  return {
    id,
    extensionId: "rigyn-sdk",
    sourcePath: `rigyn-sdk:${id}`,
    sha256: sha256(value.template),
    template: value.template,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.argumentHint === undefined ? {} : { argumentHint: value.argumentHint }),
  };
}

function mergeContext(
  target: RigynSdkContextDefaults,
  value: RigynSdkContextDefaults | undefined,
  label: string,
): RigynSdkContextDefaults {
  if (value === undefined) return target;
  if (target.systemPrompt !== undefined && value.systemPrompt !== undefined) {
    throw new Error(`Multiple SDK system prompts were provided; conflict at ${label}`);
  }
  const additional = [target.additionalInstructions, value.additionalInstructions]
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const systemPrompt = target.systemPrompt ?? value.systemPrompt;
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    appendSystemPrompt: [
      ...(target.appendSystemPrompt ?? []),
      ...(value.appendSystemPrompt ?? []),
    ],
    ...(additional.length === 0
      ? {}
      : {
          additionalInstructions: additional.length === 1
            ? additional[0]
            : {
                text: additional.map((entry) => entry.text).join("\n\n"),
                source: "Rigyn SDK composition",
              },
        }),
  };
}

function addComposition(
  resolved: ResolvedSdkComposition,
  value: RigynSdkComposition | void,
  label: string,
): void {
  if (value === undefined) return;
  resolved.providers.push(...optionalEntries(value.providers));
  resolved.tools.push(...optionalEntries(value.tools));
  resolved.skills.push(...optionalEntries(value.skills).map((skill) => structuredClone(skill)));
  resolved.templates.push(...optionalEntries(value.templates).map(templateEntry));
  resolved.extensionPaths.push(...optionalEntries(value.extensionPaths));
  resolved.packagePaths.push(...optionalEntries(value.packagePaths));
  resolved.skillPaths.push(...optionalEntries(value.skillPaths));
  resolved.promptTemplatePaths.push(...optionalEntries(value.promptTemplatePaths));
  resolved.themePaths.push(...optionalEntries(value.themePaths));
  resolved.context = mergeContext(resolved.context, value.context, label);
  if (value.dispose !== undefined) resolved.disposers.push(value.dispose);
}

async function resolveComposition(
  workspace: string,
  options: CreateRigynSdkOptions,
  controller: AbortController,
): Promise<ResolvedSdkComposition> {
  const signal = controller.signal;
  const factories = optionalEntries(options.extensions?.factories);
  const loaders = optionalEntries(options.resources?.loaders);
  boundedCount(factories.length, MAX_FACTORIES, "SDK extension factory count");
  boundedCount(loaders.length, MAX_FACTORIES, "SDK resource loader count");
  const resolved: ResolvedSdkComposition = {
    providers: [],
    tools: [],
    skills: [],
    templates: [],
    extensionPaths: optionalEntries(options.extensions?.paths),
    packagePaths: optionalEntries(options.extensions?.packages),
    skillPaths: optionalEntries(options.resources?.skillPaths),
    promptTemplatePaths: optionalEntries(options.resources?.promptTemplatePaths),
    themePaths: optionalEntries(options.resources?.themePaths),
    context: {},
    disposers: [],
  };
  addComposition(resolved, {
    providers: [
      ...(options.provider === undefined ? [] : [options.provider]),
      ...optionalEntries(options.providers),
    ],
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.resources?.skillMetadata === undefined ? {} : { skills: options.resources.skillMetadata }),
    ...(options.resources?.templates === undefined ? {} : { templates: options.resources.templates }),
    ...(options.context === undefined ? {} : { context: options.context }),
  }, "options");
  try {
    const context = Object.freeze({ workspace, signal });
    for (const [index, factory] of factories.entries()) {
      signal.throwIfAborted();
      addComposition(resolved, await factory(context), `extension factory ${index + 1}`);
    }
    for (const [index, loader] of loaders.entries()) {
      signal.throwIfAborted();
      addComposition(resolved, await loader(context), `resource loader ${index + 1}`);
    }
    boundedCount(resolved.providers.length, MAX_PROGRAMMATIC_PROVIDERS, "SDK provider count");
    boundedCount(resolved.tools.length, MAX_PROGRAMMATIC_TOOLS, "SDK tool count");
    boundedCount(resolved.skills.length, MAX_PROGRAMMATIC_SKILLS, "SDK skill count");
    boundedCount(resolved.templates.length, MAX_PROGRAMMATIC_TEMPLATES, "SDK prompt template count");
    boundedCount(
      resolved.extensionPaths.length + resolved.packagePaths.length + resolved.skillPaths.length
        + resolved.promptTemplatePaths.length + resolved.themePaths.length,
      MAX_RESOURCE_PATHS,
      "SDK resource path count",
    );
    const providerIds = new Set<string>();
    for (const provider of resolved.providers) {
      if (providerIds.has(provider.id)) throw new Error(`Duplicate SDK provider: ${provider.id}`);
      providerIds.add(provider.id);
    }
    const templateIds = new Set<string>();
    for (const template of resolved.templates) {
      if (templateIds.has(template.id)) throw new Error(`Duplicate SDK prompt template: ${template.id}`);
      templateIds.add(template.id);
    }
    return resolved;
  } catch (error) {
    controller.abort(new Error("Rigyn SDK composition failed"));
    const cleanupFailures = await runDisposers(resolved.disposers);
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Rigyn SDK composition failed");
    }
    throw error;
  }
}

function contextual<T extends {
  systemPrompt?: EmbeddingRunOptions["systemPrompt"];
  appendSystemPrompt?: EmbeddingRunOptions["appendSystemPrompt"];
  additionalInstructions?: EmbeddingRunOptions["additionalInstructions"];
}>(value: T, context: RigynSdkContextDefaults): T {
  const appendSystemPrompt = [
    ...(context.appendSystemPrompt ?? []),
    ...(value.appendSystemPrompt ?? []),
  ];
  return {
    ...value,
    ...(value.systemPrompt === undefined && context.systemPrompt !== undefined
      ? { systemPrompt: context.systemPrompt }
      : {}),
    ...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
    ...(value.additionalInstructions === undefined && context.additionalInstructions !== undefined
      ? { additionalInstructions: context.additionalInstructions }
      : {}),
  };
}

class OwnedRigynSdkSession implements RigynSdkSession {
  readonly #session: EmbeddingSession;
  readonly #defaults: RigynSdkRunDefaults;
  readonly #selection: EmbeddingModelSelection | undefined;
  readonly #context: RigynSdkContextDefaults;

  constructor(
    session: EmbeddingSession,
    defaults: RigynSdkRunDefaults,
    selection: EmbeddingModelSelection | undefined,
    context: RigynSdkContextDefaults,
  ) {
    this.#session = session;
    this.#defaults = defaults;
    this.#selection = selection;
    this.#context = context;
  }

  get threadId(): string { return this.#session.threadId; }
  get branch(): string { return this.#session.branch; }

  async start(options: RigynSdkSessionRunOptions): Promise<EmbeddingRunHandle> {
    return await this.#session.start(this.#runOptions(options));
  }

  async run(options: RigynSdkSessionRunOptions): Promise<HarnessRun> {
    return await this.#session.run(this.#runOptions(options));
  }

  steer(message: string, images?: ImageBlock[]): void { this.#session.steer(message, images); }
  followUp(message: string, images?: ImageBlock[]): void { this.#session.followUp(message, images); }
  abort(reason?: string): void { this.#session.abort(reason); }

  async compact(options: EmbeddingSessionCompactOptions = {}): Promise<Awaited<ReturnType<EmbeddingSession["compact"]>>> {
    return await this.#session.compact({
      ...options,
      ...(options.selection === undefined && this.#selection !== undefined ? { selection: this.#selection } : {}),
    });
  }

  async fork(options: EmbeddingSessionForkOptions = {}): Promise<RigynSdkSession> {
    return new OwnedRigynSdkSession(
      await this.#session.fork(options),
      this.#defaults,
      this.#selection,
      this.#context,
    );
  }

  async navigate(options: EmbeddingSessionNavigateOptions): Promise<EmbeddingSessionNavigateResult> {
    return await this.#session.navigate({
      ...options,
      ...(options.selection === undefined && this.#selection !== undefined ? { selection: this.#selection } : {}),
    });
  }

  async transcript(input: Omit<HarnessTranscriptRequest, "threadId" | "branch"> = {}): Promise<HarnessTranscriptPage> {
    return await this.#session.transcript(input);
  }

  async setName(name?: string, signal?: AbortSignal): Promise<void> { await this.#session.setName(name, signal); }
  getModel(): EmbeddingModelSelection | undefined { return this.#session.getModel(); }
  async setModel(selection: EmbeddingModelSelection, signal?: AbortSignal): Promise<EmbeddingModelSelection> {
    return await this.#session.setModel(selection, signal);
  }
  subscribe(listener: EmbeddingSessionEventListener): () => void { return this.#session.subscribe(listener); }

  #runOptions(options: RigynSdkSessionRunOptions): EmbeddingSessionRunOptions {
    const {
      branch: _branch,
      selection: defaultSelection,
      ...defaults
    } = this.#defaults;
    const { selection: requestedSelection, ...input } = options;
    const merged = contextual({ ...defaults, ...input }, this.#context);
    const selection = requestedSelection ?? defaultSelection ?? this.#selection;
    return selection === undefined ? merged : { ...merged, selection };
  }
}

class OwnedRigynSdk implements RigynSdk {
  readonly #runtime: HarnessRuntime;
  readonly #embedding: EmbeddingHarness;
  readonly #composition: ResolvedSdkComposition;
  readonly #defaultSelection: EmbeddingModelSelection | undefined;
  readonly #runDefaults: RigynSdkRunDefaults;
  readonly #templates: ReadonlyMap<string, ExtensionPromptTemplate>;
  readonly #compositionController: AbortController;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(input: {
    runtime: HarnessRuntime;
    composition: ResolvedSdkComposition;
    defaultSelection?: EmbeddingModelSelection;
    runDefaults?: RigynSdkRunDefaults;
    compositionController: AbortController;
  }) {
    this.#runtime = input.runtime;
    this.#embedding = createEmbeddingHarnessFromRuntime(input.runtime);
    this.#composition = input.composition;
    this.#defaultSelection = input.defaultSelection;
    this.#runDefaults = Object.freeze({ ...(input.runDefaults ?? {}) });
    this.#templates = new Map(input.composition.templates.map((template) => [template.id, template]));
    this.#compositionController = input.compositionController;
  }

  get workspace(): string { return this.#runtime.workspace; }
  get trusted(): boolean { return this.#runtime.trusted; }

  async start(options: RigynSdkRunOptions): Promise<EmbeddingRunHandle> {
    this.#assertOpen();
    return await this.#enqueueLifecycle(async () => await this.#embedding.start(this.#runOptions(options)));
  }

  async run(options: RigynSdkRunOptions): Promise<HarnessRun> {
    return await (await this.start(options)).result;
  }

  async createSession(options: EmbeddingSessionCreateOptions = {}): Promise<RigynSdkSession> {
    this.#assertOpen();
    return this.#session(await this.#embedding.createSession(options));
  }

  async openSession(options: EmbeddingSessionOpenOptions): Promise<RigynSdkSession> {
    this.#assertOpen();
    return this.#session(await this.#embedding.openSession(options));
  }

  async listSessions(options: HarnessSessionListRequest = {}): Promise<HarnessSessionPage> {
    this.#assertOpen();
    return await this.#embedding.listSessions(options);
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    await this.#embedding.waitForIdle(signal);
  }

  async resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog> {
    this.#assertOpen();
    return await this.#embedding.resourceCatalog(signal);
  }

  async reload(options: { signal?: AbortSignal } = {}): Promise<{ warnings: string[] }> {
    this.#assertOpen();
    return await this.#enqueueLifecycle(async () => {
      removeProgrammaticProviders(this.#runtime, this.#composition);
      let result: { warnings: string[] };
      try {
        result = await this.#runtime.reload(options);
      } catch (error) {
        registerProgrammaticProviders(this.#runtime, this.#composition);
        throw error;
      }
      await applyProgrammaticComposition(this.#runtime, this.#composition);
      return result;
    });
  }

  promptTemplates(): RigynSdkPromptTemplateDescription[] {
    this.#assertOpen();
    return [...this.#templates.values()].map((template) => ({
      id: template.id,
      sha256: template.sha256,
      ...(template.description === undefined ? {} : { description: template.description }),
      ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
    }));
  }

  renderPrompt(id: string, input = ""): string {
    this.#assertOpen();
    const template = this.#templates.get(id);
    if (template === undefined) throw new Error(`Unknown SDK prompt template: ${id}`);
    return renderExtensionPrompt(template, input);
  }

  close(): Promise<void> {
    this.#closing ??= this.#enqueueLifecycle(async () => {
      this.#compositionController.abort(new Error("Rigyn SDK closed"));
      const failures: unknown[] = [];
      removeProgrammaticProviders(this.#runtime, this.#composition);
      try {
        await this.#embedding.close();
      } catch (error) {
        failures.push(error);
      }
      failures.push(...await runDisposers(this.#composition.disposers));
      if (failures.length > 0) throw new AggregateError(failures, "Rigyn SDK cleanup failed");
    });
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

  #runOptions(options: RigynSdkRunOptions): EmbeddingRunOptions {
    const { selection: defaultSelection, ...defaults } = this.#runDefaults;
    const { selection: requestedSelection, ...input } = options;
    const selection = requestedSelection ?? defaultSelection ?? this.#defaultSelection;
    if (selection === undefined) {
      throw new Error("Rigyn SDK has no model selection; set defaultSelection or pass selection");
    }
    return contextual({
      ...defaults,
      ...input,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }, this.#composition.context);
  }

  #session(session: EmbeddingSession): RigynSdkSession {
    return new OwnedRigynSdkSession(
      session,
      this.#runDefaults,
      this.#defaultSelection,
      this.#composition.context,
    );
  }

  #assertOpen(): void {
    if (this.#closing !== undefined) throw new Error("Rigyn SDK is closing");
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#lifecycleTail.then(operation);
    this.#lifecycleTail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

async function applyProgrammaticComposition(
  runtime: HarnessRuntime,
  composition: ResolvedSdkComposition,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  registerProgrammaticProviders(runtime, composition);
  await runtime.service.setSdkComposition({
    tools: composition.tools,
    skills: composition.skills,
  }, signal);
}

function registerProgrammaticProviders(
  runtime: HarnessRuntime,
  composition: ResolvedSdkComposition,
): void {
  for (const provider of composition.providers) {
    if (runtime.providers.has(provider.id)) {
      if (runtime.providers.get(provider.id) !== provider) {
        throw new Error(`SDK provider conflicts with configured provider: ${provider.id}`);
      }
      continue;
    }
    runtime.providers.register(provider);
  }
}

function removeProgrammaticProviders(
  runtime: HarnessRuntime,
  composition: ResolvedSdkComposition,
): void {
  for (const provider of composition.providers) {
    runtime.providers.unregister(provider.id, provider, { preservePersistedCatalog: true });
  }
}

async function disposeComposition(
  controller: AbortController,
  disposers: readonly (() => void | Promise<void>)[],
): Promise<unknown[]> {
  controller.abort(new Error("Rigyn SDK initialization failed"));
  return await runDisposers(disposers);
}

async function runDisposers(
  disposers: readonly (() => void | Promise<void>)[],
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Creates one configured, persistent Rigyn owner from declarative resources and
 * bounded programmatic composition. Provider adapters remain caller-owned.
 */
export async function createRigynSdk(options: CreateRigynSdkOptions = {}): Promise<RigynSdk> {
  const workspace = await realpath(resolve(options.workspace ?? process.cwd()));
  const compositionController = new AbortController();
  let composition: ResolvedSdkComposition | undefined;
  let runtime: HarnessRuntime | undefined;
  try {
    composition = await resolveComposition(workspace, options, compositionController);
    runtime = await createHarnessRuntime({
      workspace,
      extensions: options.extensions?.enabled ?? true,
      extensionPaths: composition.extensionPaths,
      packagePaths: composition.packagePaths,
      allowPackageScripts: options.extensions?.allowPackageScripts ?? false,
      ...(options.resources?.skills === undefined ? {} : { skills: options.resources.skills }),
      skillPaths: composition.skillPaths,
      ...(options.resources?.promptTemplates === undefined
        ? {}
        : { promptTemplates: options.resources.promptTemplates }),
      promptTemplatePaths: composition.promptTemplatePaths,
      ...(options.resources?.themes === undefined ? {} : { themes: options.resources.themes }),
      themePaths: composition.themePaths,
      ...(options.runtime ?? {}),
    });
    await applyProgrammaticComposition(runtime, composition);
    const configuredSelection = options.defaultSelection
      ?? (runtime.config.defaultProvider === undefined || runtime.config.defaultModel === undefined
        ? undefined
        : {
            provider: runtime.config.defaultProvider,
            model: runtime.config.defaultModel,
            ...(runtime.config.thinking === undefined ? {} : { reasoningEffort: runtime.config.thinking }),
          });
    return new OwnedRigynSdk({
      runtime,
      composition,
      ...(configuredSelection === undefined ? {} : { defaultSelection: configuredSelection }),
      ...(options.runDefaults === undefined ? {} : { runDefaults: options.runDefaults }),
      compositionController,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    if (runtime !== undefined) {
      if (composition !== undefined) removeProgrammaticProviders(runtime, composition);
      try { await runtime.close(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    failures.push(...await disposeComposition(compositionController, composition?.disposers ?? []));
    if (failures.length > 1) throw new AggregateError(failures, "Rigyn SDK initialization failed");
    throw error;
  }
}
