import type { AssistantMessageDiagnostic } from "@rigyn/models";

import type { MessageId, ToolCallId } from "../../runtime/core/ids.js";
import type { JsonValue } from "../../runtime/core/json.js";
import type { ModelProtocolFamily } from "./model-contracts.js";
import type { FinishReason, ProviderId } from "./provider-identity.js";
import type { NormalizedUsage } from "./usage-contracts.js";

export interface TextBlock {
  type: "text";
  text: string;
  /** Provider-owned signature replayable only at the exact source model boundary. */
  textSignature?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Provider-owned signature replayable only at the exact source model boundary. */
  thinkingSignature?: string;
  /** True when the provider returned an opaque/redacted reasoning block. */
  redacted?: boolean;
  /** Visibility retained for terminal and extension stream projection. */
  visibility?: "summary" | "provider_trace";
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data?: string;
  url?: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  callId: ToolCallId;
  name: string;
  arguments: JsonValue;
  rawArguments?: string;
  /** Provider-owned reasoning signature replayable only at the exact source model boundary. */
  thoughtSignature?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  callId: ToolCallId;
  name: string;
  content: string;
  /** Original ordered extension-facing text/image content when available. */
  contentBlocks?: (TextBlock | ImageBlock)[];
  isError: boolean;
  status?: "success" | "warning" | "error";
  summary?: string;
  nextActions?: string[];
  images?: ImageBlock[];
  artifactIds?: string[];
  metadata?: JsonValue;
  /** Tool-owned accounting retained without provider-raw diagnostics. */
  usage?: Omit<NormalizedUsage, "raw">;
  addedToolNames?: string[];
}

export interface OpaqueBlock {
  type: "provider_opaque";
  provider: ProviderId;
  mediaType: string;
  value: JsonValue;
  serialized?: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | OpaqueBlock;

/** Ordered assistant blocks that may be finalized by a normalized provider stream. */
export type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface CanonicalMessage {
  id: MessageId;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  displayText?: string;
  createdAt: string;
  provider?: ProviderId;
  model?: string;
  api?: ModelProtocolFamily;
  /** Exact public API identifier when an extension API is carried by a core protocol. */
  publicApi?: string;
  purpose?: "instructions" | "compaction";
  /** Terminal metadata retained for assistant history and resume diagnostics. */
  stopReason?: FinishReason;
  errorMessage?: string;
  usage?: NormalizedUsage;
  /** Actual provider-selected model when it differs from the requested model. */
  responseModel?: string;
  /** Provider response identity used for diagnostics and supported continuations. */
  responseId?: string;
  /** Bounded, redacted, JSON-safe public response diagnostics. */
  diagnostics?: AssistantMessageDiagnostic[];
  /** A failed attempt kept in history but excluded from subsequent model context. */
  retryTransient?: true;
  /** Host-only identity for extension-authored context projected to providers as a user message. */
  custom?: {
    customType: string;
    display: boolean;
    details?: unknown;
    timestamp: number;
  };
}

export interface ProviderToolDefinition {
  name: string;
  /** Concise human-facing name used by interactive renderers. */
  label?: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  /** Hint that supporting providers may load this executable definition on demand. */
  loading?: "eager" | "deferred";
  /** Optional concise system-prompt entry for an active tool. */
  promptSnippet?: string;
  /** Optional active-tool guidance appended to the system prompt. */
  promptGuidelines?: string[];
  constrainedSampling?: false | import("@rigyn/models").ConstrainedSamplingConfig;
}
