import { isDeepStrictEqual } from "node:util";

import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@rigyn/kernel";

import { createId } from "../core/ids.js";
import { isJsonValue } from "../core/json.js";
import { canonicalAssistantDiagnostics } from "../core/assistant-diagnostics.js";
import {
  canonicalAssistantContent as canonicalPublicAssistantContent,
  publicAssistantContent,
} from "../core/public-assistant-content.js";
import { isNormalizedUsage } from "../core/usage.js";
import type {
  CanonicalMessage,
  ImageBlock,
  ModelProtocolFamily,
  NormalizedUsage,
  ProviderState,
  TextBlock,
  ToolResultBlock,
} from "../core/types.js";
import type { SessionManager } from "../storage/session-manager.js";
import type {
  BranchSummaryEntry as CanonicalBranchSummaryEntry,
  CompactionEntry as CanonicalCompactionEntry,
  CustomEntry,
  CustomMessageEntry as CanonicalCustomMessageEntry,
  LabelEntry,
  ModelChangeEntry as CanonicalModelChangeEntry,
  PersistedSessionMessage as CanonicalPersistedSessionMessage,
  SessionEntry as CanonicalSessionEntry,
  SessionHeader,
  SessionInfoEntry,
  ThinkingLevelChangeEntry,
} from "../storage/types.js";
import { protocolFromPublicApi, publicApiFromProtocol } from "./model-boundary.js";

export type {
  CustomEntry,
  LabelEntry,
  SessionInfoEntry,
  ThinkingLevelChangeEntry,
} from "../storage/types.js";
export { REASONING_MEDIA_TYPE } from "../core/public-assistant-content.js";

const CANONICAL_APIS: ReadonlySet<ModelProtocolFamily> = new Set([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
  "gemini-interactions",
  "bedrock-converse",
  "mistral-conversations",
  "ollama-chat",
  "gateway-messages",
]);

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export type ModelChangeEntry = CanonicalModelChangeEntry;
export type CompactionEntry<T = unknown> = Omit<CanonicalCompactionEntry<T>, "usage"> & { usage?: Usage };
export type BranchSummaryEntry<T = unknown> = Omit<CanonicalBranchSummaryEntry<T>, "usage"> & { usage?: Usage };
export type CustomMessageEntry<T = unknown> = Omit<CanonicalCustomMessageEntry<T>, "content"> & {
  content: string | Array<TextContent | ImageContent>;
};

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export type PersistedSessionMessage = AgentMessage;

export interface ReadonlyExtensionSessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getLabel(id: string): string | undefined;
  getBranch(fromId?: string): SessionEntry[];
  buildContextEntries(): SessionEntry[];
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
  getTree(): SessionTreeNode[];
  getSessionName(): string | undefined;
}

export interface ExtensionSessionManager extends ReadonlyExtensionSessionManager {
  setSessionFile(path: string): void;
  newSession(options?: { id?: string; parentSession?: string }): string | undefined;
  isPersisted(): boolean;
  usesDefaultSessionDir(): boolean;
  appendMessage(message: AgentMessage): string;
  appendThinkingLevelChange(thinkingLevel: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string;
  appendCustomEntry<T = unknown>(customType: string, data?: T): string;
  appendSessionInfo(name: string): string;
  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: T,
  ): string;
  getChildren(parentId: string): SessionEntry[];
  appendLabelChange(targetId: string, label: string | undefined): string;
  buildSessionContext(): SessionContext;
  branch(branchFromId: string): void;
  resetLeaf(): void;
  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage,
  ): string;
  createBranchedSession(leafId: string): string | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function token(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function publicTimestamp(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function canonicalTimestamp(value: number): string {
  const milliseconds = timestamp(value, "Message timestamp");
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new TypeError("Message timestamp is outside the supported range");
  return date.toISOString();
}

export function extensionUsage(value: NormalizedUsage | undefined): Usage {
  const input = value?.inputTokens ?? 0;
  const output = value?.outputTokens ?? 0;
  const cacheRead = value?.cacheReadTokens ?? 0;
  const cacheWrite = value?.cacheWriteTokens ?? 0;
  const totalTokens = value?.totalTokens ?? input + output + cacheRead + cacheWrite;
  const cost = value?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(value?.cacheWrite1hTokens === undefined ? {} : { cacheWrite1h: value.cacheWrite1hTokens }),
    ...(value?.reasoningTokens === undefined ? {} : { reasoning: value.reasoningTokens }),
    totalTokens,
    cost: { ...cost },
  };
}

export function canonicalUsage(value: Usage): NormalizedUsage {
  const input = token(value.input, "Usage input");
  const output = token(value.output, "Usage output");
  const cacheRead = token(value.cacheRead, "Usage cacheRead");
  const cacheWrite = token(value.cacheWrite, "Usage cacheWrite");
  const totalTokens = token(value.totalTokens, "Usage totalTokens");
  if (totalTokens !== input + output + cacheRead + cacheWrite) {
    throw new TypeError("Usage totalTokens must equal input + output + cacheRead + cacheWrite");
  }
  const costValue = record(value.cost);
  if (costValue === undefined) throw new TypeError("Usage cost must be an object");
  const inputCost = finiteNonNegative(costValue.input, "Usage input cost");
  const outputCost = finiteNonNegative(costValue.output, "Usage output cost");
  const cacheReadCost = finiteNonNegative(costValue.cacheRead, "Usage cacheRead cost");
  const cacheWriteCost = finiteNonNegative(costValue.cacheWrite, "Usage cacheWrite cost");
  const totalCost = finiteNonNegative(costValue.total, "Usage total cost");
  const expectedCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  if (Math.abs(totalCost - expectedCost) > Math.max(1e-12, Math.abs(totalCost) * 1e-9)) {
    throw new TypeError("Usage total cost must equal its component costs");
  }
  const result: NormalizedUsage = {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
      total: expectedCost,
    },
  };
  if (value.cacheWrite1h !== undefined) result.cacheWrite1hTokens = token(value.cacheWrite1h, "Usage cacheWrite1h");
  if (value.reasoning !== undefined) result.reasoningTokens = token(value.reasoning, "Usage reasoning");
  if (!isNormalizedUsage(result)) throw new TypeError("Usage is internally inconsistent");
  return result;
}

export function extensionImage(value: ImageBlock): ImageContent {
  if (value.data === undefined) {
    throw new TypeError("Extension-visible images must contain base64 data; URL-only images cannot cross this boundary");
  }
  return { type: "image", data: value.data, mimeType: value.mediaType };
}

export function canonicalImage(value: ImageContent): ImageBlock {
  if (value === null || typeof value !== "object" || value.type !== "image") {
    throw new TypeError("Image content must be an image block");
  }
  if (typeof value.data !== "string") throw new TypeError("Image data must be a base64 string");
  return { type: "image", mediaType: nonEmpty(value.mimeType, "Image MIME type"), data: value.data };
}

export function extensionInputContent(
  value: string | readonly (TextBlock | ImageBlock)[],
): string | Array<TextContent | ImageContent> {
  if (typeof value === "string") return value;
  return value.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : extensionImage(block));
}

export function extensionContent(
  value: readonly (TextBlock | ImageBlock)[],
): Array<TextContent | ImageContent> {
  const converted = extensionInputContent(value);
  return typeof converted === "string" ? [{ type: "text", text: converted }] : converted;
}

export function canonicalInputContent(
  value: string | readonly (TextContent | ImageContent)[],
): string | Array<TextBlock | ImageBlock> {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new TypeError("Message content must be a string or content array");
  return value.map((block) => {
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new TypeError("Text content must contain text");
      return { type: "text", text: block.text };
    }
    return canonicalImage(block);
  });
}

export function canonicalContent(
  value: readonly (TextContent | ImageContent)[],
): Array<TextBlock | ImageBlock> {
  const converted = canonicalInputContent(value);
  if (typeof converted === "string") throw new TypeError("Content must be an array");
  return converted;
}

function extensionAssistantContent(message: CanonicalMessage): AssistantMessage["content"] {
  return publicAssistantContent(message.content);
}

function extensionStopReason(reason: CanonicalMessage["stopReason"]): AssistantMessage["stopReason"] {
  if (reason === "length" || reason === "stop" || reason === "error" || reason === "aborted") return reason;
  if (reason === "tool_calls") return "toolUse";
  if (reason === "cancelled") return "aborted";
  if (reason === undefined) return "stop";
  return reason === "context_limit" ? "length" : "error";
}

function extensionApi(message: CanonicalMessage): string {
  return message.publicApi ?? (message.api === undefined ? "rigyn-messages" : publicApiFromProtocol(message.api));
}

function extensionProviderState(message: CanonicalMessage & { providerState?: ProviderState }): AssistantMessage["providerState"] {
  if (message.providerState === undefined) return undefined;
  return {
    source: {
      api: extensionApi(message),
      provider: message.provider ?? "rigyn",
      model: message.model ?? "unknown",
    },
    value: structuredClone(message.providerState),
  };
}

function extensionUserMessage(message: CanonicalMessage): UserMessage {
  const content: Array<TextContent | ImageContent> = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "image") content.push(extensionImage(block));
  }
  return { role: "user", content, timestamp: publicTimestamp(message.createdAt) };
}

function extensionAssistantMessage(message: CanonicalMessage & { providerState?: ProviderState }): AssistantMessage {
  const providerState = extensionProviderState(message);
  const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
  return {
    role: "assistant",
    content: extensionAssistantContent(message),
    api: extensionApi(message),
    provider: message.provider ?? "rigyn",
    model: message.model ?? "unknown",
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    usage: extensionUsage(message.usage),
    stopReason: extensionStopReason(message.stopReason),
    ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    ...(providerState === undefined ? {} : { providerState }),
    timestamp: publicTimestamp(message.createdAt),
  };
}

function toolResultContent(block: ToolResultBlock): Array<TextContent | ImageContent> {
  const stored = block.contentBlocks;
  if (stored !== undefined) return stored.map((item) => item.type === "text"
    ? { type: "text", text: item.text }
    : extensionImage(item));
  return [
    { type: "text", text: block.content },
    ...(block.images ?? []).map(extensionImage),
  ];
}

export function extensionToolResult(
  message: CanonicalMessage,
  block: ToolResultBlock,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: block.callId,
    toolName: block.name,
    content: toolResultContent(block),
    ...(block.metadata === undefined ? {} : { details: structuredClone(block.metadata) }),
    ...(block.addedToolNames === undefined ? {} : { addedToolNames: [...block.addedToolNames] }),
    ...(message.usage === undefined ? {} : { usage: extensionUsage(message.usage) }),
    isError: block.isError,
    timestamp: publicTimestamp(message.createdAt),
  };
}

export function extensionToolResultBlock(
  block: ToolResultBlock,
  options: { timestamp?: number; usage?: NormalizedUsage } = {},
): ToolResultMessage {
  const timestampValue = options.timestamp ?? Date.now();
  return extensionToolResult({
    id: createId("msg"),
    role: "tool",
    content: [block],
    createdAt: canonicalTimestamp(timestampValue),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  }, block);
}

function extensionCustomMessage(message: CanonicalMessage): CustomMessage {
  const custom = message.custom;
  if (custom === undefined) throw new TypeError("Canonical custom message metadata is missing");
  return {
    role: "custom",
    customType: custom.customType,
    content: extensionInputContent(message.content.filter(
      (block): block is TextBlock | ImageBlock => block.type === "text" || block.type === "image",
    )),
    display: custom.display,
    ...(custom.details === undefined ? {} : { details: structuredClone(custom.details) }),
    timestamp: custom.timestamp,
  };
}

export function extensionMessages(message: CanonicalPersistedSessionMessage): AgentMessage[] {
  if (message.role === "bashExecution") {
    const value: BashExecutionMessage = { ...message };
    return [value];
  }
  if (message.role === "custom") {
    return [{
      ...message,
      content: extensionInputContent(message.content),
    }];
  }
  if (message.custom !== undefined) return [extensionCustomMessage(message)];
  if (message.role === "assistant") return [extensionAssistantMessage(message)];
  if (message.role === "tool") {
    return message.content
      .filter((block): block is ToolResultBlock => block.type === "tool_result")
      .map((block) => extensionToolResult(message, block));
  }
  return [extensionUserMessage(message)];
}

export function extensionMessage(message: CanonicalMessage): AgentMessage {
  const converted = extensionMessages(message);
  if (converted.length !== 1) {
    throw new TypeError("A canonical tool batch must be projected through the session-entry boundary");
  }
  return converted[0]!;
}

export function extensionAssistantEvent(
  event: unknown,
  message: CanonicalMessage,
): AssistantMessageEvent {
  const assistant = extensionAssistantMessage(message);
  const value = record(event);
  if (value === undefined || typeof value.type !== "string") return { type: "start", partial: assistant };
  const index = Number.isSafeInteger(value.part) && Number(value.part) >= 0
    ? Number(value.part)
    : Number.isSafeInteger(value.index) && Number(value.index) >= 0
      ? Number(value.index)
      : 0;
  if (value.type === "text_started") {
    return { type: "text_start", contentIndex: index, partial: assistant };
  }
  if (value.type === "text_delta" && typeof value.text === "string") {
    return { type: "text_delta", contentIndex: index, delta: value.text, partial: assistant };
  }
  if (value.type === "text_completed" && typeof value.text === "string") {
    return {
      type: "text_end",
      contentIndex: index,
      content: value.text,
      ...(typeof value.textSignature === "string" ? { contentSignature: value.textSignature } : {}),
      partial: assistant,
    };
  }
  if (value.type === "reasoning_started") {
    return { type: "thinking_start", contentIndex: index, partial: assistant };
  }
  if (value.type === "reasoning_delta" && typeof value.text === "string") {
    return { type: "thinking_delta", contentIndex: index, delta: value.text, partial: assistant };
  }
  if (value.type === "reasoning_completed" && typeof value.text === "string") {
    return {
      type: "thinking_end",
      contentIndex: index,
      content: value.text,
      ...(typeof value.thinkingSignature === "string" ? { contentSignature: value.thinkingSignature } : {}),
      ...(typeof value.redacted === "boolean" ? { redacted: value.redacted } : {}),
      partial: assistant,
    };
  }
  if (value.type === "tool_call_started") {
    return { type: "toolcall_start", contentIndex: index, partial: assistant };
  }
  if (value.type === "tool_call_delta" && typeof value.jsonFragment === "string") {
    return { type: "toolcall_delta", contentIndex: index, delta: value.jsonFragment, partial: assistant };
  }
  if (value.type === "tool_call_completed" && typeof value.name === "string") {
    const argumentsValue = record(value.arguments) ?? {};
    return {
      type: "toolcall_end",
      contentIndex: index,
      toolCall: {
        type: "toolCall",
        id: typeof value.id === "string" ? value.id : `call_${index}`,
        name: value.name,
        arguments: isJsonValue(argumentsValue) ? structuredClone(argumentsValue) : {},
        ...(typeof value.thoughtSignature === "string" ? { thoughtSignature: value.thoughtSignature } : {}),
      },
      partial: assistant,
    };
  }
  return { type: "start", partial: assistant };
}

function canonicalApi(value: string, previous: CanonicalMessage | undefined): ModelProtocolFamily {
  if (previous !== undefined && extensionApi(previous) === value && previous.api !== undefined) return previous.api;
  const protocol = protocolFromPublicApi(value);
  if (!CANONICAL_APIS.has(protocol)) throw new TypeError(`Assistant API ${value} has no canonical provider protocol`);
  return protocol;
}

function canonicalStopReason(
  value: AssistantMessage["stopReason"],
  previous: CanonicalMessage | undefined,
): NonNullable<CanonicalMessage["stopReason"]> {
  if (previous?.stopReason !== undefined && extensionStopReason(previous.stopReason) === value) return previous.stopReason;
  if (value === "toolUse") return "tool_calls";
  return value;
}

function canonicalProviderState(value: AssistantMessage, previous: CanonicalMessage | undefined): ProviderState | undefined {
  if (value.providerState === undefined) return undefined;
  if (previous === undefined) throw new TypeError("Provider continuation state cannot be introduced by an extension");
  const exposed = extensionProviderState(previous as CanonicalMessage & { providerState?: ProviderState });
  if (exposed === undefined || !isDeepStrictEqual(exposed, value.providerState)) {
    throw new TypeError("Provider continuation state is host-owned and cannot be changed by an extension");
  }
  return (previous as CanonicalMessage & { providerState?: ProviderState }).providerState;
}

function canonicalResponseMetadata(
  value: AssistantMessage,
  previous: CanonicalMessage | undefined,
): Pick<CanonicalMessage, "responseModel" | "responseId" | "diagnostics"> {
  if (previous === undefined) {
    if (value.responseModel !== undefined || value.responseId !== undefined || value.diagnostics !== undefined) {
      throw new TypeError("Provider response metadata cannot be introduced by an extension");
    }
    return {};
  }

  const diagnostics = canonicalAssistantDiagnostics(previous.diagnostics);
  if (value.responseModel !== undefined && value.responseModel !== previous.responseModel) {
    throw new TypeError("Provider response metadata is host-owned and cannot be changed by an extension");
  }
  if (value.responseId !== undefined && value.responseId !== previous.responseId) {
    throw new TypeError("Provider response metadata is host-owned and cannot be changed by an extension");
  }
  if (value.diagnostics !== undefined) {
    const selected = canonicalAssistantDiagnostics(value.diagnostics);
    if (!isDeepStrictEqual(selected, diagnostics)) {
      throw new TypeError("Provider response metadata is host-owned and cannot be changed by an extension");
    }
  }
  return {
    ...(previous.responseModel === undefined ? {} : { responseModel: previous.responseModel }),
    ...(previous.responseId === undefined ? {} : { responseId: previous.responseId }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function canonicalUserMessage(value: UserMessage, previous?: CanonicalMessage): CanonicalMessage {
  const selected = canonicalInputContent(value.content);
  const content = typeof selected === "string" ? [{ type: "text" as const, text: selected }] : selected;
  return {
    id: previous?.id ?? createId("msg"),
    role: "user",
    content,
    createdAt: previous?.createdAt ?? canonicalTimestamp(value.timestamp),
    ...(previous?.displayText === undefined ? {} : { displayText: previous.displayText }),
    ...(previous?.purpose === undefined ? {} : { purpose: previous.purpose }),
  };
}

function canonicalAssistantMessage(value: AssistantMessage, previous?: CanonicalMessage): CanonicalMessage & { providerState?: ProviderState } {
  const api = canonicalApi(nonEmpty(value.api, "Assistant API"), previous);
  const publicApi = publicApiFromProtocol(api) === value.api ? undefined : value.api;
  const providerState = canonicalProviderState(value, previous);
  const responseMetadata = canonicalResponseMetadata(value, previous);
  return {
    id: previous?.id ?? createId("msg"),
    role: "assistant",
    content: canonicalPublicAssistantContent(value.content),
    createdAt: previous?.createdAt ?? canonicalTimestamp(value.timestamp),
    provider: nonEmpty(value.provider, "Assistant provider"),
    model: nonEmpty(value.model, "Assistant model"),
    api,
    ...(publicApi === undefined ? {} : { publicApi }),
    ...responseMetadata,
    usage: canonicalUsage(value.usage),
    stopReason: canonicalStopReason(value.stopReason, previous),
    ...(value.errorMessage === undefined ? {} : { errorMessage: value.errorMessage }),
    ...(providerState === undefined ? {} : { providerState }),
    ...(previous?.displayText === undefined ? {} : { displayText: previous.displayText }),
    ...(previous?.retryTransient === undefined ? {} : { retryTransient: previous.retryTransient }),
  };
}

function canonicalToolResultMessage(value: ToolResultMessage, previous?: CanonicalMessage): CanonicalMessage {
  const content = canonicalInputContent(value.content);
  if (typeof content === "string") throw new TypeError("Tool result content must be an array");
  if (value.details !== undefined && !isJsonValue(value.details)) {
    throw new TypeError("Tool result details must be JSON-safe for session persistence");
  }
  if (value.addedToolNames !== undefined && (
    !Array.isArray(value.addedToolNames) || value.addedToolNames.some((name) => typeof name !== "string" || name.trim() === "")
  )) throw new TypeError("Tool result addedToolNames must contain non-empty strings");
  const texts = content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text);
  const images = content.filter((block): block is ImageBlock => block.type === "image");
  const block: ToolResultBlock = {
    type: "tool_result",
    callId: nonEmpty(value.toolCallId, "Tool-call id") as ToolResultBlock["callId"],
    name: nonEmpty(value.toolName, "Tool name"),
    content: texts.join(""),
    contentBlocks: content,
    isError: value.isError,
    ...(value.details === undefined ? {} : { metadata: structuredClone(value.details) }),
    ...(value.addedToolNames === undefined ? {} : { addedToolNames: [...value.addedToolNames] }),
    ...(images.length === 0 ? {} : { images }),
  };
  return {
    id: previous?.id ?? createId("msg"),
    role: "tool",
    content: [block],
    createdAt: previous?.createdAt ?? canonicalTimestamp(value.timestamp),
    ...(value.usage === undefined ? {} : { usage: canonicalUsage(value.usage) }),
  };
}

function canonicalBashMessage(value: BashExecutionMessage): CanonicalPersistedSessionMessage {
  return {
    role: "bashExecution",
    command: value.command,
    output: value.output,
    exitCode: value.exitCode,
    cancelled: value.cancelled,
    truncated: value.truncated,
    ...(value.fullOutputPath === undefined ? {} : { fullOutputPath: value.fullOutputPath }),
    timestamp: timestamp(value.timestamp, "Bash message timestamp"),
    ...(value.excludeFromContext === undefined ? {} : { excludeFromContext: value.excludeFromContext }),
  };
}

function canonicalCustom(value: CustomMessage): CanonicalPersistedSessionMessage {
  if (value.details !== undefined && !isJsonValue(value.details)) {
    throw new TypeError("Custom message details must be JSON-safe for session persistence");
  }
  return {
    role: "custom",
    customType: nonEmpty(value.customType, "Custom message type"),
    content: canonicalInputContent(value.content),
    display: value.display,
    ...(value.details === undefined ? {} : { details: structuredClone(value.details) }),
    timestamp: timestamp(value.timestamp, "Custom message timestamp"),
  };
}

export function canonicalMessage(value: AgentMessage, previous?: CanonicalMessage): CanonicalPersistedSessionMessage {
  if (value.role === "user") return canonicalUserMessage(value, previous);
  if (value.role === "assistant") return canonicalAssistantMessage(value, previous);
  if (value.role === "toolResult") return canonicalToolResultMessage(value, previous);
  if (value.role === "bashExecution") return canonicalBashMessage(value);
  if (value.role === "custom") return canonicalCustom(value);
  throw new TypeError(`Message role ${String(value.role)} cannot be written directly to a session message entry`);
}

export function extensionCanonicalMessages(messages: readonly CanonicalMessage[]): AgentMessage[] {
  return messages.flatMap((message) => extensionMessages(message));
}

export function canonicalAgentMessages(
  messages: readonly AgentMessage[],
  previous: readonly CanonicalMessage[] = [],
): CanonicalMessage[] {
  return messages.map((message, index) => {
    const converted = canonicalMessage(message, previous[index]);
    if (converted.role === "bashExecution" || converted.role === "custom") {
      throw new TypeError("Context replacements may contain only model conversation messages");
    }
    return converted;
  });
}

interface ProjectedEntry {
  publicEntry: SessionEntry;
  canonicalId: string;
}

interface SessionProjection {
  entries: ProjectedEntry[];
  byId: Map<string, ProjectedEntry>;
  canonicalIdByPublicId: Map<string, string>;
  tailByCanonicalId: Map<string, string>;
}

function projectedId(base: string, index: number, used: Set<string>): string {
  if (index === 0 && !used.has(base)) return base;
  let suffix = index;
  let candidate = `${base}~${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}~${suffix}`;
  }
  return candidate;
}

function projectMessageEntry(
  entry: Extract<CanonicalSessionEntry, { type: "message" }>,
  parentId: string | null,
  used: Set<string>,
): SessionMessageEntry[] {
  const messages = extensionMessages(entry.message);
  const result: SessionMessageEntry[] = [];
  let parent = parentId;
  for (const [index, message] of messages.entries()) {
    const id = projectedId(entry.id, index, used);
    used.add(id);
    result.push({ type: "message", id, parentId: parent, timestamp: entry.timestamp, message });
    parent = id;
  }
  if (result.length > 0) return result;
  const id = projectedId(entry.id, 0, used);
  used.add(id);
  return [{
    type: "message",
    id,
    parentId,
    timestamp: entry.timestamp,
    message: {
      role: "custom",
      customType: "empty-tool-batch",
      content: "",
      display: false,
      timestamp: publicTimestamp(entry.timestamp),
    },
  }];
}

function projectEntry(
  entry: CanonicalSessionEntry,
  parentId: string | null,
  used: Set<string>,
): SessionEntry[] {
  if (entry.type === "message") return projectMessageEntry(entry, parentId, used);
  const id = projectedId(entry.id, 0, used);
  used.add(id);
  if (entry.type === "model_change") {
    return [{
      type: "model_change",
      id,
      parentId,
      timestamp: entry.timestamp,
      provider: entry.provider,
      modelId: entry.modelId,
    }];
  }
  if (entry.type === "compaction") {
    const { usage, ...rest } = entry;
    return [{
      ...rest,
      id,
      parentId,
      ...(usage === undefined ? {} : { usage: extensionUsage(usage) }),
    }];
  }
  if (entry.type === "branch_summary") {
    const { usage, ...rest } = entry;
    return [{
      ...rest,
      id,
      parentId,
      ...(usage === undefined ? {} : { usage: extensionUsage(usage) }),
    }];
  }
  if (entry.type === "custom_message") {
    return [{ ...entry, id, parentId, content: extensionInputContent(entry.content) }];
  }
  return [{ ...entry, id, parentId }];
}

function projectSession(entries: readonly CanonicalSessionEntry[]): SessionProjection {
  const projected: ProjectedEntry[] = [];
  const byId = new Map<string, ProjectedEntry>();
  const canonicalIdByPublicId = new Map<string, string>();
  const tailByCanonicalId = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    const parentId = entry.parentId === null ? null : tailByCanonicalId.get(entry.parentId) ?? entry.parentId;
    const converted = projectEntry(entry, parentId, used);
    for (const publicEntry of converted) {
      const item = { publicEntry, canonicalId: entry.id };
      projected.push(item);
      byId.set(publicEntry.id, item);
      canonicalIdByPublicId.set(publicEntry.id, entry.id);
    }
    const tail = converted.at(-1);
    if (tail !== undefined) tailByCanonicalId.set(entry.id, tail.id);
  }
  return { entries: projected, byId, canonicalIdByPublicId, tailByCanonicalId };
}

export function extensionSessionEntries(entries: readonly CanonicalSessionEntry[]): SessionEntry[] {
  return projectSession(entries).entries.map((entry) => cloneEntry(entry.publicEntry));
}

export function extensionSessionEntry(entry: CanonicalSessionEntry): SessionEntry {
  const converted = extensionSessionEntries([entry]);
  if (converted.length !== 1) {
    throw new TypeError("A batched tool entry has more than one extension-visible session entry");
  }
  return converted[0]!;
}

function cloneEntry<T>(value: T): T {
  return structuredClone(value);
}

class ExtensionSessionManagerFacade implements ExtensionSessionManager {
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    this.#manager = manager;
  }

  #projection(): SessionProjection {
    return projectSession(this.#manager.getEntries());
  }

  #canonicalId(publicId: string): string {
    return this.#projection().canonicalIdByPublicId.get(publicId) ?? publicId;
  }

  getCwd(): string { return this.#manager.getCwd(); }
  getSessionDir(): string { return this.#manager.getSessionDir(); }
  getSessionId(): string { return this.#manager.getSessionId(); }
  getSessionFile(): string | undefined { return this.#manager.getSessionFile(); }
  isPersisted(): boolean { return this.#manager.isPersisted(); }
  usesDefaultSessionDir(): boolean { return this.#manager.usesDefaultSessionDir(); }
  setSessionFile(path: string): void { this.#manager.setSessionFile(path); }
  newSession(options?: { id?: string; parentSession?: string }): string | undefined { return this.#manager.newSession(options); }

  getLeafId(): string | null {
    const id = this.#manager.getLeafId();
    return id === null ? null : this.#projection().tailByCanonicalId.get(id) ?? id;
  }

  getLeafEntry(): SessionEntry | undefined {
    const id = this.getLeafId();
    return id === null ? undefined : this.getEntry(id);
  }

  getEntry(id: string): SessionEntry | undefined {
    const entry = this.#projection().byId.get(id)?.publicEntry;
    return entry === undefined ? undefined : cloneEntry(entry);
  }

  getLabel(id: string): string | undefined { return this.#manager.getLabel(this.#canonicalId(id)); }

  getBranch(fromId?: string): SessionEntry[] {
    const projection = this.#projection();
    const target = fromId === undefined ? undefined : projection.byId.get(fromId);
    const branch = this.#manager.getBranch(target?.canonicalId ?? fromId);
    const ids = new Set(branch.map((entry) => entry.id));
    const result: SessionEntry[] = [];
    for (const item of projection.entries) {
      if (!ids.has(item.canonicalId)) continue;
      result.push(cloneEntry(item.publicEntry));
      if (fromId !== undefined && item.publicEntry.id === fromId) break;
    }
    return result;
  }

  buildContextEntries(): SessionEntry[] {
    const projection = projectSession(this.#manager.buildContextEntries());
    return projection.entries.map((entry) => cloneEntry(entry.publicEntry));
  }

  buildSessionContext(): SessionContext {
    const context = this.#manager.buildSessionContext();
    const messages: AgentMessage[] = [];
    for (const message of context.messages) {
      if (message.role === "branchSummary") {
        const value: BranchSummaryMessage = { ...message };
        messages.push(value);
      } else if (message.role === "compactionSummary") {
        const value: CompactionSummaryMessage = { ...message };
        messages.push(value);
      } else messages.push(...extensionMessages(message));
    }
    return {
      messages,
      thinkingLevel: context.thinkingLevel,
      model: context.model === null ? null : { provider: context.model.provider, modelId: context.model.modelId },
    };
  }

  getHeader(): SessionHeader | null {
    const header = this.#manager.getHeader();
    return header === null ? null : cloneEntry(header);
  }

  getEntries(): SessionEntry[] {
    return this.#projection().entries.map((entry) => cloneEntry(entry.publicEntry));
  }

  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodes = new Map<string, SessionTreeNode>(
      entries.map((entry) => [entry.id, { entry, children: [] }]),
    );
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
      const node = nodes.get(entry.id)!;
      const label = this.getLabel(entry.id);
      if (label !== undefined) node.label = label;
      if (entry.parentId === null || !nodes.has(entry.parentId)) roots.push(node);
      else nodes.get(entry.parentId)!.children.push(node);
    }
    return roots;
  }

  getSessionName(): string | undefined { return this.#manager.getSessionName(); }
  appendMessage(message: AgentMessage): string { return this.#manager.appendMessage(canonicalMessage(message)); }
  appendThinkingLevelChange(level: string): string { return this.#manager.appendThinkingLevelChange(level); }

  appendModelChange(provider: string, modelId: string): string {
    return this.#manager.appendModelChange(provider, modelId);
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string {
    return this.#manager.appendCompaction(
      summary,
      this.#canonicalId(firstKeptEntryId),
      tokensBefore,
      details,
      fromHook,
      usage === undefined ? undefined : canonicalUsage(usage),
    );
  }

  appendCustomEntry<T = unknown>(customType: string, data?: T): string {
    return this.#manager.appendCustomEntry(customType, data);
  }

  appendSessionInfo(name: string): string { return this.#manager.appendSessionInfo(name); }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: T,
  ): string {
    return this.#manager.appendCustomMessageEntry(customType, canonicalInputContent(content), display, details);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.getEntries().filter((entry) => entry.parentId === parentId);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    return this.#manager.appendLabelChange(this.#canonicalId(targetId), label);
  }

  branch(branchFromId: string): void { this.#manager.branch(this.#canonicalId(branchFromId)); }
  resetLeaf(): void { this.#manager.resetLeaf(); }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage,
  ): string {
    return this.#manager.branchWithSummary(
      branchFromId === null ? null : this.#canonicalId(branchFromId),
      summary,
      details,
      fromHook,
      usage === undefined ? undefined : canonicalUsage(usage),
    );
  }

  createBranchedSession(leafId: string): string | undefined {
    return this.#manager.createBranchedSession(this.#canonicalId(leafId));
  }
}

const sessionFacades = new WeakMap<SessionManager, ExtensionSessionManager>();

export function extensionSessionManager(manager: SessionManager): ExtensionSessionManager {
  const existing = sessionFacades.get(manager);
  if (existing !== undefined) return existing;
  const facade = new ExtensionSessionManagerFacade(manager);
  sessionFacades.set(manager, facade);
  return facade;
}
