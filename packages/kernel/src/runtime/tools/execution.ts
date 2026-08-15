import type { EventSink, ToolUpdate } from "../core/events.js";
import type { JsonValue } from "../core/json.js";
import type {
  ImageBlock,
  NormalizedUsage,
  ProviderToolDefinition,
  TextBlock,
} from "../core/types.js";

export interface ToolInvocation {
  callId: string;
  name: string;
  input: JsonValue;
  /** Nonnegative safe integer that is unique within its invocation batch. */
  index: number;
}

export type ToolRecoveryMode = "repeatable" | "reconcile" | "never_repeat";

export interface PreparedToolInvocation extends ToolInvocation {
  recoveryMode: ToolRecoveryMode;
}

export type ToolResultStatus = "success" | "warning" | "error";

export interface ToolArtifact {
  id: string;
  path: string;
  mediaType: string;
  bytes: number;
}

export interface ToolResult {
  content: string;
  contentBlocks?: (TextBlock | ImageBlock)[];
  isError: boolean;
  usage?: NormalizedUsage;
  status?: ToolResultStatus;
  summary?: string;
  nextActions?: string[];
  terminate?: boolean;
  metadata?: JsonValue;
  addedToolNames?: string[];
  artifacts?: ToolArtifact[];
  images?: ImageBlock[];
}

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

export interface ToolExecutionContext {
  eventSink: EventSink;
  signal: AbortSignal;
  runId: string;
  threadId: string;
  step: number;
}

export interface ToolExecutionObserver {
  transformed?(
    invocation: ToolInvocation,
    audit: readonly ToolInputTransformationAudit[],
  ): Promise<void> | void;
  started?(invocation: PreparedToolInvocation): Promise<void> | void;
  dispatching?(invocation: PreparedToolInvocation): Promise<void> | void;
  progress?(update: ToolInvocationProgress): Promise<void> | void;
  completed?(result: ToolInvocationResult): Promise<void> | void;
}

export interface ToolExecutionOptions {
  rejected?: ReadonlyMap<number, ToolResult>;
}

export interface ToolTurnSnapshot {
  definitions: ProviderToolDefinition[];
}

export interface ToolExecutionPort {
  turnSnapshot(): ToolTurnSnapshot;
  execute(
    invocations: ToolInvocation[],
    context: ToolExecutionContext,
    observer: ToolExecutionObserver,
    options: ToolExecutionOptions,
  ): Promise<ToolInvocationResult[]>;
}
