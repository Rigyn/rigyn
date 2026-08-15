import { isProxy } from "node:util/types";
import { resolve } from "node:path";

import { boundedJsonSnapshot } from "@rigyn/kernel/runtime/core/bounded-json";
import type { AgentTool as KernelAgentTool } from "@rigyn/kernel";
import type { Static, TSchema } from "typebox";

import type {
  AgentToolResult,
  ExtensionContext,
  RegisteredTool,
  ToolDefinition,
} from "../extensions/direct.js";
import {
  canonicalContent,
  canonicalUsage,
  extensionContent,
  extensionUsage,
} from "../extensions/session-contract.js";
import type { JsonValue } from "../core/json.js";
import type { ProviderToolDefinition } from "../core/types.js";
import { DirectProcessRunner } from "../process/runner.js";
import { assertSchema } from "./schema.js";
import { WorkspaceBoundary } from "./paths.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolContext,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolRecoveryContract,
  ToolResult,
} from "./types.js";

const MAX_DIRECT_DETAILS_BYTES = 16 * 1024;
const MAX_DIRECT_CONTENT_BYTES = 1024 * 1024;
const MAX_DIRECT_VALUES = 65_536;
const MAX_DIRECT_CONTAINERS = 16_384;
const MAX_DIRECT_DEPTH = 64;
const MAX_ADDED_TOOLS = 256;

type DirectToolMetadata<TParameters extends TSchema, TDetails, TState> = Pick<
  ToolDefinition<TParameters, TDetails, TState>,
  | "constrainedSampling"
  | "executionMode"
  | "loading"
  | "prepareArguments"
  | "promptGuidelines"
  | "promptSnippet"
  | "recovery"
  | "renderCall"
  | "renderResult"
  | "renderShell"
  | "resources"
>;

/** Agent-loop tool shape augmented with Rigyn execution and rendering metadata. */
export type AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TState = Record<string, unknown>,
> = Omit<KernelAgentTool<TParameters, TDetails>, "execute" | "prepareArguments"> &
  DirectToolMetadata<TParameters, TDetails, TState> & {
    execute(
      toolCallId: string,
      params: Static<TParameters>,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
    ): Promise<AgentToolResult<TDetails>>;
  };

export type AgentSessionTool = HarnessTool | ToolDefinition;

export interface HarnessToolDefinitionOptions<
  TParameters extends TSchema,
  TDetails,
> {
  cwd: string;
  tool: HarnessTool;
  label: string;
  parameters: TParameters;
  details(result: ToolResult): TDetails;
}

function boundedClone<T>(value: T, label: string, maximumBytes: number): T {
  return boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: MAX_DIRECT_VALUES,
    maximumContainers: MAX_DIRECT_CONTAINERS,
    maximumDepth: MAX_DIRECT_DEPTH,
  }).value as T;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function dataField(source: Record<string, unknown>, name: string, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(source, name);
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError(`${label}.${name} must be an enumerable data property`);
  }
  return descriptor.value;
}

function addedToolNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const snapshot = boundedClone(value, "Tool addedToolNames", 32 * 1024);
  if (!Array.isArray(snapshot) || snapshot.length > MAX_ADDED_TOOLS) {
    throw new TypeError(`Tool addedToolNames must contain at most ${MAX_ADDED_TOOLS} names`);
  }
  const names = snapshot.map((name) => {
    if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(name)) {
      throw new TypeError("Tool addedToolNames contains an invalid name");
    }
    return name;
  });
  return [...new Set(names)];
}

function directResult(value: unknown): ToolResult {
  const selected = record(value, "Tool result");
  const rawContent = dataField(selected, "content", "Tool result") ?? [];
  const content = canonicalContent(boundedClone(
    rawContent,
    "Tool result content",
    MAX_DIRECT_CONTENT_BYTES,
  ) as AgentToolResult["content"]);
  const details = dataField(selected, "details", "Tool result");
  let metadata: JsonValue | undefined;
  if (details !== undefined) {
    try {
      metadata = boundedClone(details, "Tool result details", MAX_DIRECT_DETAILS_BYTES) as JsonValue;
    } catch {
      metadata = undefined;
    }
  }
  const usage = dataField(selected, "usage", "Tool result");
  const terminate = dataField(selected, "terminate", "Tool result");
  if (terminate !== undefined && typeof terminate !== "boolean") {
    throw new TypeError("Tool result.terminate must be a boolean");
  }
  const names = addedToolNames(dataField(selected, "addedToolNames", "Tool result"));
  const images = content.filter((block) => block.type === "image");
  return {
    content: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"),
    contentBlocks: content,
    isError: false,
    ...(usage === undefined
      ? {}
      : {
          usage: canonicalUsage(boundedClone(
            usage,
            "Tool result usage",
            MAX_DIRECT_DETAILS_BYTES,
          ) as Parameters<typeof canonicalUsage>[0]),
        }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(images.length === 0 ? {} : { images }),
    ...(names === undefined ? {} : { addedToolNames: names }),
    ...(terminate === undefined ? {} : { terminate }),
  };
}

function directContent(result: ToolResult): AgentToolResult["content"] {
  if (result.contentBlocks !== undefined) return extensionContent(result.contentBlocks);
  const blocks: Parameters<typeof extensionContent>[0] = [
    ...(result.content === "" ? [] : [{ type: "text" as const, text: result.content }]),
    ...(result.images ?? []),
  ];
  return extensionContent(blocks);
}

function publicResult<TDetails>(
  result: ToolResult,
  details: (result: ToolResult) => TDetails,
): AgentToolResult<TDetails> {
  const selectedDetails = details(result);
  const safeDetails = selectedDetails === undefined
    ? selectedDetails
    : boundedClone(selectedDetails, "Tool result details", MAX_DIRECT_DETAILS_BYTES);
  const names = result.addedToolNames === undefined
    ? undefined
    : addedToolNames(result.addedToolNames);
  return {
    content: directContent(result),
    details: safeDetails,
    ...(result.usage === undefined ? {} : { usage: extensionUsage(result.usage) }),
    ...(names === undefined ? {} : { addedToolNames: names }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  };
}

function standaloneWorkspace(cwd: string): WorkspaceBoundary {
  try {
    return WorkspaceBoundary.createSync(cwd);
  } catch {
    // Injected filesystem operations are allowed to use a virtual working directory.
    return { root: resolve(cwd) } as WorkspaceBoundary;
  }
}

function standaloneContext(
  cwd: string,
  toolCallId: string,
  signal: AbortSignal,
  reportProgress: ToolContext["reportProgress"],
): ToolExecutionContext {
  return {
    workspace: standaloneWorkspace(cwd),
    runner: new DirectProcessRunner(),
    signal,
    runId: `direct:${toolCallId}`,
    threadId: "direct",
    toolCallId,
    ...(reportProgress === undefined ? {} : { reportProgress }),
  };
}

/** Project a harness-native tool into the public TypeBox definition contract. */
export function createHarnessToolDefinition<
  TParameters extends TSchema,
  TDetails,
>(options: HarnessToolDefinitionOptions<TParameters, TDetails>): ToolDefinition<TParameters, TDetails> {
  const definition = options.tool.definition;
  return {
    name: definition.name,
    label: options.label,
    description: definition.description,
    parameters: options.parameters,
    ...(definition.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
    ...(definition.loading === undefined ? {} : { loading: definition.loading }),
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...definition.promptGuidelines] }),
    ...(options.tool.prepareInput === undefined
      ? {}
      : { prepareArguments: (input) => options.tool.prepareInput!(input as JsonValue, {
          workspace: standaloneWorkspace(options.cwd),
          runner: new DirectProcessRunner(),
          signal: new AbortController().signal,
          runId: "direct:prepare",
          threadId: "direct",
        }) as Static<TParameters> | Promise<Static<TParameters>> }),
    ...(options.tool.executionMode === undefined ? {} : { executionMode: options.tool.executionMode }),
    ...(options.tool.recovery === undefined ? {} : { recovery: options.tool.recovery }),
    resources: (input, context) => options.tool.resources(input as JsonValue, context),
    async execute(toolCallId, input, signal, onUpdate) {
      const selectedSignal = signal ?? new AbortController().signal;
      selectedSignal.throwIfAborted();
      const reportProgress: ToolContext["reportProgress"] = onUpdate === undefined
        ? undefined
        : (progress) => {
            const content = progress.type === "output" ? progress.delta : progress.content;
            const details = progress.type === "result" ? progress.metadata : undefined;
            onUpdate({
              content: content === "" ? [] : [{ type: "text", text: content }],
              details: details as TDetails,
            });
          };
      const result = await options.tool.execute(
        input as JsonValue,
        standaloneContext(options.cwd, toolCallId, selectedSignal, reportProgress),
      );
      selectedSignal.throwIfAborted();
      if (result.isError) {
        throw new Error(result.content.startsWith("Tool failed: ")
          ? result.content.slice("Tool failed: ".length)
          : result.content);
      }
      return publicResult(result, options.details);
    },
  };
}

/** Adapt a public direct tool for the coordinated harness runtime. */
export function createHarnessToolFromDefinition<
  TParameters extends TSchema,
  TDetails,
  TState,
>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
  context: (toolContext: ToolExecutionContext) => ExtensionContext,
): HarnessTool {
  const providerDefinition: ProviderToolDefinition = {
    name: definition.name,
    ...(definition.label === undefined ? {} : { label: definition.label }),
    description: definition.description,
    inputSchema: definition.parameters as unknown as Record<string, JsonValue>,
    ...(definition.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
    ...(definition.loading === undefined ? {} : { loading: definition.loading }),
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...definition.promptGuidelines] }),
  };
  return {
    definition: providerDefinition,
    ...(definition.prepareArguments === undefined
      ? {}
      : { prepareInput: (input) => definition.prepareArguments!(input) as JsonValue | Promise<JsonValue> }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    ...(definition.recovery === undefined ? {} : { recovery: definition.recovery }),
    validate(input): void {
      assertSchema(providerDefinition.inputSchema, input);
    },
    resources: definition.resources === undefined
      ? () => []
      : (input, toolContext) => definition.resources!(input as Static<TParameters>, toolContext),
    async execute(input, toolContext) {
      toolContext.signal.throwIfAborted();
      const onUpdate = toolContext.reportProgress === undefined
        ? undefined
        : (partial: AgentToolResult<TDetails>): void => {
            const converted = directResult(partial);
            toolContext.reportProgress?.({
              type: "result",
              content: converted.content,
              isError: false,
              ...(converted.metadata === undefined ? {} : { metadata: converted.metadata }),
            });
          };
      const result = await definition.execute(
        toolContext.toolCallId,
        input as Static<TParameters>,
        toolContext.signal,
        onUpdate,
        context(toolContext),
      );
      toolContext.signal.throwIfAborted();
      return directResult(result);
    },
  };
}

/** Retain the public definition while presenting the agent-loop callable shape. */
export function wrapToolDefinition<
  TParameters extends TSchema,
  TDetails,
  TState,
>(definition: ToolDefinition<TParameters, TDetails, TState>): AgentTool<TParameters, TDetails, TState> {
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
    ...(definition.loading === undefined ? {} : { loading: definition.loading }),
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...definition.promptGuidelines] }),
    ...(definition.prepareArguments === undefined
      ? {}
      : { prepareArguments: definition.prepareArguments }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    ...(definition.recovery === undefined ? {} : { recovery: definition.recovery }),
    ...(definition.resources === undefined ? {} : { resources: definition.resources }),
    ...(definition.renderShell === undefined ? {} : { renderShell: definition.renderShell }),
    ...(definition.renderCall === undefined ? {} : { renderCall: definition.renderCall }),
    ...(definition.renderResult === undefined ? {} : { renderResult: definition.renderResult }),
    async execute(toolCallId, params, signal, onUpdate) {
      return await definition.execute(toolCallId, params, signal, onUpdate, undefined as never);
    },
  };
}

/** Recreate a public direct definition from an agent-loop tool. */
export function createToolDefinitionFromAgentTool<
  TParameters extends TSchema,
  TDetails,
  TState,
>(tool: AgentTool<TParameters, TDetails, TState>): ToolDefinition<TParameters, TDetails, TState> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
    ...(tool.loading === undefined ? {} : { loading: tool.loading }),
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
    ...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode as ToolExecutionMode }),
    ...(tool.recovery === undefined ? {} : { recovery: tool.recovery as ToolRecoveryContract }),
    ...(tool.resources === undefined
      ? {}
      : { resources: (input, context) => tool.resources!(input, context) as ResourceClaim[] | Promise<ResourceClaim[]> }),
    ...(tool.renderShell === undefined ? {} : { renderShell: tool.renderShell }),
    ...(tool.renderCall === undefined ? {} : { renderCall: tool.renderCall }),
    ...(tool.renderResult === undefined ? {} : { renderResult: tool.renderResult }),
    execute(toolCallId, input, signal, onUpdate) {
      return tool.execute(toolCallId, input, signal, onUpdate);
    },
  };
}

export function wrapRegisteredTool(tool: RegisteredTool): AgentTool {
  return wrapToolDefinition(tool.definition);
}

export function wrapRegisteredTools(tools: Iterable<RegisteredTool>): AgentTool[] {
  return [...tools].map(wrapRegisteredTool);
}

function valueAt(source: object, key: PropertyKey): unknown {
  let selected: object | null = source;
  while (selected !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(selected, key);
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
    selected = Object.getPrototypeOf(selected);
  }
  return undefined;
}

export function isHarnessTool(value: unknown): value is HarnessTool {
  if (value === null || typeof value !== "object" || isProxy(value)) return false;
  const definition = valueAt(value, "definition");
  if (definition === null || typeof definition !== "object" || isProxy(definition)) return false;
  return typeof valueAt(definition, "name") === "string"
    && typeof valueAt(value, "validate") === "function"
    && typeof valueAt(value, "resources") === "function"
    && typeof valueAt(value, "execute") === "function";
}
