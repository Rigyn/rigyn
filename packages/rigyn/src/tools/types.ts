import type { JsonValue } from "../core/json.js";
import type { EventSink, ToolUpdate } from "../core/events.js";
import type { ImageBlock, NormalizedUsage, ProviderToolDefinition } from "../core/types.js";
import type { ProcessRunner } from "../process/types.js";
import type { WorkspaceBoundary } from "./paths.js";
import type { ToolExecutionBackend } from "./backend.js";

export type ResourceMode = "read" | "write";
export type ToolExecutionMode = "parallel" | "sequential";
export type ToolResultStatus = "success" | "warning" | "error";
export type ToolRecoveryMode = "repeatable" | "reconcile" | "never_repeat";

export interface ResourceClaim {
  kind: "file" | "process" | "network" | "workspace" | "session";
  key: string;
  mode: ResourceMode;
}

export interface ToolArtifact {
  id: string;
  path: string;
  mediaType: string;
  bytes: number;
}

export interface ArtifactWriter {
  write(
    name: string,
    mediaType: string,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ToolArtifact>;
}

export interface ToolContext {
  workspace: WorkspaceBoundary;
  runner: ProcessRunner;
  /** Routes only explicitly claimed tools across an external execution boundary. */
  backend?: ToolExecutionBackend;
  artifacts?: ArtifactWriter;
  eventSink?: EventSink;
  /** Reports best-effort live output. It never contributes to the model-visible tool result. */
  reportProgress?: (progress: ToolUpdate) => void;
  signal: AbortSignal;
  runId: string;
  threadId: string;
  /** Current durable session file when one exists. */
  sessionFile?: string;
  /** Current provider and model selection for process attribution. */
  provider?: string;
  modelId?: string;
  /** Current user-selected reasoning level. */
  reasoningLevel?: string;
  /** Exact session branch when execution is owned by AgentSession. */
  branch?: string;
  /** One-based provider step that produced this invocation when known. */
  step?: number;
  /** Active model input capabilities when the invocation surface can supply them. */
  activeModel?: { input: readonly ("text" | "image")[] };
}

/** Invocation-scoped context supplied only after a provider tool call is selected. */
export interface ToolExecutionContext extends ToolContext {
  /** Exact provider-supplied tool-call identifier. */
  toolCallId: string;
}

export type ToolInputPreparer = (
  input: JsonValue,
  context: ToolContext,
) => JsonValue | Promise<JsonValue>;

export interface ToolResult {
  content: string;
  /** Original ordered extension-facing content retained for session projection. */
  contentBlocks?: (import("../core/types.js").TextBlock | ImageBlock)[];
  isError: boolean;
  /** Usage incurred by the tool itself, such as a tool-owned model request. */
  usage?: NormalizedUsage;
  /** Compact machine-readable outcome fields used to build model recovery observations. */
  status?: ToolResultStatus;
  summary?: string;
  nextActions?: string[];
  /**
   * Requests an early, successful end after this tool batch. The agent honors
   * the hint only when every result in the provider-requested batch opts in.
   */
  terminate?: boolean;
  metadata?: JsonValue;
  /** Tool names made available by this result for the next provider turn. */
  addedToolNames?: string[];
  artifacts?: ToolArtifact[];
  images?: ImageBlock[];
}

/** Exact durable identity and effective input of a dispatched tool effect. */
export interface DurableToolEffect {
  readonly operationId: string;
  readonly threadId: string;
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}

/** Product-neutral services available while inspecting a previously dispatched effect. */
export interface ToolRecoveryContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
}

export type ToolRecoveryResult =
  | { readonly status: "completed"; readonly result: ToolResult }
  | { readonly status: "not_applied" }
  | { readonly status: "in_doubt"; readonly reason: string };

export type ToolRecoveryContract =
  | { readonly mode: "repeatable" }
  | {
      readonly mode: "reconcile";
      recover(
        effect: DurableToolEffect,
        context: ToolRecoveryContext,
      ): ToolRecoveryResult | Promise<ToolRecoveryResult>;
    }
  | { readonly mode: "never_repeat" };

const DEFAULT_TOOL_RECOVERY: ToolRecoveryContract = Object.freeze({ mode: "never_repeat" });

export function resolveToolRecovery(
  recovery: ToolRecoveryContract | undefined,
): ToolRecoveryContract {
  if (recovery === undefined) return DEFAULT_TOOL_RECOVERY;
  if (recovery === null || typeof recovery !== "object") {
    throw new TypeError("Tool recovery must be an object");
  }
  if (recovery.mode === "reconcile") {
    if (typeof recovery.recover !== "function") {
      throw new TypeError("A reconcile tool recovery policy must define recover");
    }
    return Object.freeze({ mode: "reconcile", recover: recovery.recover });
  }
  if (recovery.mode === "repeatable" || recovery.mode === "never_repeat") {
    if ("recover" in recovery && recovery.recover !== undefined) {
      throw new TypeError(`A ${recovery.mode} tool recovery policy cannot define recover`);
    }
    return Object.freeze({ mode: recovery.mode });
  }
  throw new TypeError("Tool recovery mode must be repeatable, reconcile, or never_repeat");
}

export interface HarnessTool {
  readonly definition: ProviderToolDefinition;
  /** Durable effect recovery policy. Registries resolve omission to never_repeat. */
  readonly recovery?: ToolRecoveryContract;
  /** Normalizes trusted compatibility input before schema and custom validation. */
  readonly prepareInput?: ToolInputPreparer;
  /** Runs this call alone as an exclusive source-order barrier between parallel waves. */
  readonly executionMode?: ToolExecutionMode;
  validate(input: JsonValue): void;
  resources(input: JsonValue, context: ToolContext): Promise<ResourceClaim[]> | ResourceClaim[];
  execute(input: JsonValue, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolInvocation {
  callId: string;
  name: string;
  input: JsonValue;
  /** Nonnegative safe integer that is unique within its invocation batch. */
  index: number;
}

export interface PreparedToolInvocation extends ToolInvocation {
  recoveryMode: ToolRecoveryMode;
}

/** Non-secret durable attribution for a validated input transformation. */
export interface ToolInputTransformationAudit {
  actor: string;
}

export interface ToolInvocationResult {
  invocation: ToolInvocation;
  result: ToolResult;
}

export interface ToolInvocationProgress {
  invocation: ToolInvocation;
  sequence: number;
  progress: ToolUpdate;
}
