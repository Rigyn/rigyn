import type { JsonValue } from "../core/json.js";
import type { EventSink, ToolUpdate } from "../core/events.js";
import type { ImageBlock, ToolDefinition } from "../core/types.js";
import type { ProcessRunner } from "../process/types.js";
import type { WorkspaceBoundary } from "./paths.js";
import type { ToolExecutionBackend } from "./backend.js";

export type ResourceMode = "read" | "write";
export type ToolExecutionMode = "parallel" | "sequential";
export type ToolResultStatus = "success" | "warning" | "error";

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
  /** Exact session branch when execution is owned by HarnessService. */
  branch?: string;
  /** One-based provider step that produced this invocation when known. */
  step?: number;
}

export type ToolInputPreparer = (
  input: JsonValue,
  context: ToolContext,
) => JsonValue | Promise<JsonValue>;

export interface ToolResult {
  content: string;
  isError: boolean;
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
  artifacts?: ToolArtifact[];
  images?: ImageBlock[];
}

export interface HarnessTool {
  readonly definition: ToolDefinition;
  /** Normalizes trusted compatibility input before schema and custom validation. */
  readonly prepareInput?: ToolInputPreparer;
  /** Sequential tools run alone as source-order barriers within a batch. */
  readonly executionMode?: ToolExecutionMode;
  validate(input: JsonValue): void;
  resources(input: JsonValue, context: ToolContext): Promise<ResourceClaim[]> | ResourceClaim[];
  execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}

export interface ToolInvocation {
  callId: string;
  name: string;
  input: JsonValue;
  index: number;
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
