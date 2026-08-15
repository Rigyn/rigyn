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
import type {
  ActiveBranchUsage,
  SessionEntryProjectionMetadata,
  SessionManager,
} from "../storage/session-manager.js";
import type {
  BranchSummaryEntry as CanonicalBranchSummaryEntry,
  CompactionEntry as CanonicalCompactionEntry,
  CustomEntry,
  CustomMessageEntry as CanonicalCustomMessageEntry,
  LabelEntry,
  ModelChangeEntry as CanonicalModelChangeEntry,
  PersistedSessionMessage as CanonicalPersistedSessionMessage,
  SessionBranchQuery,
  SessionEntry as CanonicalSessionEntry,
  SessionHeader,
  SessionInfoEntry,
  ThinkingLevelChangeEntry,
} from "../storage/types.js";
import {
  selectSessionBranchEntries,
  validateSessionBranchQuery,
} from "../storage/session-branch-query.js";
import { protocolFromPublicApi, publicApiFromProtocol } from "./model-boundary.js";

export type {
  CustomEntry,
  LabelEntry,
  SessionHeader,
  SessionInfoEntry,
  SessionBranchQuery,
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
  "ollama-chat",
  "extension-stream",
]);

export interface SessionEntryBase {
  timestamp: string;
  parentId: string | null;
  id: string;
  type: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  message: AgentMessage;
  type: "message";
}

export type ModelChangeEntry = CanonicalModelChangeEntry;
export type CompactionEntry<T = unknown> = Omit<CanonicalCompactionEntry<T>, "usage"> & { usage?: Usage };
export type BranchSummaryEntry<T = unknown> = Omit<CanonicalBranchSummaryEntry<T>, "usage"> & { usage?: Usage };
export type CustomMessageEntry<T = unknown> = Omit<CanonicalCustomMessageEntry<T>, "content"> & {
  content: string | Array<TextContent | ImageContent>;
};

type SessionConversationEntry =
  | SessionMessageEntry
  | CustomMessageEntry;
type SessionSelectionEntry =
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CustomEntry
  | LabelEntry
  | SessionInfoEntry;
type SessionSummaryEntry = CompactionEntry | BranchSummaryEntry;

export type SessionEntry = SessionConversationEntry | SessionSelectionEntry | SessionSummaryEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  labelTimestamp?: string;
  label?: string;
  children: SessionTreeNode[];
  entry: SessionEntry;
}

export interface SessionContext {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  messages: AgentMessage[];
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
  findEntriesOnBranch(query?: SessionBranchQuery): SessionEntry[];
  findEntryOnBranch(query?: SessionBranchQuery): SessionEntry | undefined;
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
  return {
    ...(value?.inputTokens === undefined ? {} : { input: value.inputTokens }),
    ...(value?.outputTokens === undefined ? {} : { output: value.outputTokens }),
    ...(value?.cacheReadTokens === undefined ? {} : { cacheRead: value.cacheReadTokens }),
    ...(value?.cacheWriteTokens === undefined ? {} : { cacheWrite: value.cacheWriteTokens }),
    ...(value?.cacheWrite1hTokens === undefined ? {} : { cacheWrite1h: value.cacheWrite1hTokens }),
    ...(value?.reasoningTokens === undefined ? {} : { reasoning: value.reasoningTokens }),
    ...(value?.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
    ...(value?.cost === undefined ? {} : { cost: { ...value.cost } }),
  };
}

export function canonicalUsage(value: Usage): NormalizedUsage {
  const input = value.input === undefined ? undefined : token(value.input, "Usage input");
  const output = value.output === undefined ? undefined : token(value.output, "Usage output");
  const cacheRead = value.cacheRead === undefined ? undefined : token(value.cacheRead, "Usage cacheRead");
  const cacheWrite = value.cacheWrite === undefined ? undefined : token(value.cacheWrite, "Usage cacheWrite");
  const totalTokens = value.totalTokens === undefined ? undefined : token(value.totalTokens, "Usage totalTokens");
  const components = [input, output, cacheRead, cacheWrite];
  if (
    totalTokens !== undefined && components.every((component) => component !== undefined) &&
    totalTokens !== components.reduce<number>((sum, component) => sum + component!, 0)
  ) {
    throw new TypeError("Usage totalTokens must equal input + output + cacheRead + cacheWrite");
  }
  const result: NormalizedUsage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  if (value.cost !== undefined) {
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
    result.cost = { input: inputCost, output: outputCost, cacheRead: cacheReadCost, cacheWrite: cacheWriteCost, total: expectedCost };
  }
  if (value.cacheWrite1h !== undefined) {
    if (cacheWrite === undefined) throw new TypeError("Usage cacheWrite1h requires cacheWrite");
    const cacheWrite1h = token(value.cacheWrite1h, "Usage cacheWrite1h");
    if (cacheWrite1h > cacheWrite) throw new TypeError("Usage cacheWrite1h must not exceed cacheWrite");
    result.cacheWrite1hTokens = cacheWrite1h;
  }
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
  return message.publicApi ?? (message.api === undefined ? "extension-stream" : publicApiFromProtocol(message.api));
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
  if (value === "pending") return "incomplete";
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
  const selected = canonicalInputContent(value.content ?? []);
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
    content: canonicalPublicAssistantContent(value.content ?? []),
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
  const content = canonicalInputContent(value.content ?? []);
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
    ...(value.isError === undefined ? {} : { isError: value.isError }),
    cancelled: value.cancelled,
    ...(value.timedOut === undefined ? {} : { timedOut: value.timedOut }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
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
    content: canonicalInputContent(value.content ?? []),
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

interface IndexedProjectedEntry {
  canonicalId: string;
  parentId: string | null;
  publicIds: string[];
  publicStart: number;
}

interface SessionProjectionIndex {
  entries: IndexedProjectedEntry[];
  canonicalIdByPublicId: Map<string, string>;
  tailByCanonicalId: Map<string, string>;
  used: Set<string>;
  totalEntries: number;
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

function emptySessionProjectionIndex(): SessionProjectionIndex {
  return {
    entries: [],
    canonicalIdByPublicId: new Map(),
    tailByCanonicalId: new Map(),
    used: new Set(),
    totalEntries: 0,
  };
}

function appendSessionProjectionIndex(
  index: SessionProjectionIndex,
  metadata: readonly SessionEntryProjectionMetadata[],
): void {
  for (const entry of metadata) {
    if (!Number.isSafeInteger(entry.projectedEntryCount) || entry.projectedEntryCount < 1) {
      throw new Error(`Session entry ${entry.id} has an invalid projected entry count`);
    }
    const parentId = entry.parentId === null
      ? null
      : index.tailByCanonicalId.get(entry.parentId) ?? entry.parentId;
    const publicIds: string[] = [];
    for (let row = 0; row < entry.projectedEntryCount; row += 1) {
      const id = projectedId(entry.id, row, index.used);
      index.used.add(id);
      index.canonicalIdByPublicId.set(id, entry.id);
      publicIds.push(id);
    }
    const tail = publicIds.at(-1)!;
    index.entries.push({
      canonicalId: entry.id,
      parentId,
      publicIds,
      publicStart: index.totalEntries,
    });
    index.tailByCanonicalId.set(entry.id, tail);
    index.totalEntries += publicIds.length;
  }
}

function projectionIndexFromSessionProjection(projection: SessionProjection): SessionProjectionIndex {
  const index = emptySessionProjectionIndex();
  for (const item of projection.entries) {
    let entry = index.entries.at(-1);
    if (entry?.canonicalId !== item.canonicalId) {
      entry = {
        canonicalId: item.canonicalId,
        parentId: item.publicEntry.parentId,
        publicIds: [],
        publicStart: index.totalEntries,
      };
      index.entries.push(entry);
    }
    entry.publicIds.push(item.publicEntry.id);
    index.used.add(item.publicEntry.id);
    index.canonicalIdByPublicId.set(item.publicEntry.id, item.canonicalId);
    index.tailByCanonicalId.set(item.canonicalId, item.publicEntry.id);
    index.totalEntries += 1;
  }
  return index;
}

function canonicalIndexAtPublicOffset(entries: readonly IndexedProjectedEntry[], offset: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle]!;
    if (entry.publicStart + entry.publicIds.length <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
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

/** @internal Resolve an extension-visible entry id to its canonical journal entry. */
export function canonicalSessionEntryId(manager: SessionManager, publicId: string): string | undefined {
  return projectSession(manager.getEntries()).byId.get(publicId)?.canonicalId;
}

function cloneEntry<T>(value: T): T {
  return structuredClone(value);
}

class ExtensionSessionManagerFacade implements ExtensionSessionManager {
  readonly #manager: SessionManager;
  #cachedProjection: { key: string; value: SessionProjection } | undefined;
  #cachedProjectionIndex: {
    entryCount: number;
    key: string;
    revision: number;
    value: SessionProjectionIndex;
  } | undefined;

  constructor(manager: SessionManager) {
    this.#manager = manager;
  }

  #projection(): SessionProjection {
    const getSessionId = Reflect.get(this.#manager, "getSessionId") as (() => string) | undefined;
    const getSessionFile = Reflect.get(this.#manager, "getSessionFile") as (() => string | undefined) | undefined;
    const getTreeRevision = Reflect.get(this.#manager, "getTreeRevision") as (() => number) | undefined;
    const getEntryCount = Reflect.get(this.#manager, "getEntryCount") as (() => number) | undefined;
    if (
      getSessionId === undefined ||
      getSessionFile === undefined ||
      getTreeRevision === undefined ||
      getEntryCount === undefined
    ) return projectSession(this.#manager.getEntries());
    const key = [
      getSessionId.call(this.#manager),
      getSessionFile.call(this.#manager) ?? "",
      getTreeRevision.call(this.#manager),
      getEntryCount.call(this.#manager),
    ].join("\0");
    if (this.#cachedProjection?.key === key) return this.#cachedProjection.value;
    const value = projectSession(this.#manager.getEntries());
    this.#cachedProjection = { key, value };
    return value;
  }

  #projectionIndex(): SessionProjectionIndex {
    const getSessionId = Reflect.get(this.#manager, "getSessionId") as (() => string) | undefined;
    const getSessionFile = Reflect.get(this.#manager, "getSessionFile") as (() => string | undefined) | undefined;
    const getTreeRevision = Reflect.get(this.#manager, "getTreeRevision") as (() => number) | undefined;
    const getEntryCount = Reflect.get(this.#manager, "getEntryCount") as (() => number) | undefined;
    const getMetadataPage = Reflect.get(this.#manager, "getEntryProjectionMetadataPage") as ((
      offset: number,
      limit: number,
    ) => SessionEntryProjectionMetadata[]) | undefined;
    if (
      getSessionId === undefined
      || getSessionFile === undefined
      || getTreeRevision === undefined
      || getEntryCount === undefined
      || getMetadataPage === undefined
    ) return projectionIndexFromSessionProjection(this.#projection());
    const key = [getSessionId.call(this.#manager), getSessionFile.call(this.#manager) ?? ""].join("\0");
    const revision = getTreeRevision.call(this.#manager);
    const entryCount = getEntryCount.call(this.#manager);
    const cached = this.#cachedProjectionIndex;
    if (cached?.key === key && cached.revision === revision && cached.entryCount === entryCount) {
      return cached.value;
    }
    if (
      cached?.key === key
      && revision > cached.revision
      && entryCount > cached.entryCount
    ) {
      const metadata = getMetadataPage.call(
        this.#manager,
        cached.entryCount,
        entryCount - cached.entryCount,
      );
      if (metadata.length !== entryCount - cached.entryCount) {
        throw new Error("Session projection metadata did not cover the appended entries");
      }
      appendSessionProjectionIndex(cached.value, metadata);
      this.#cachedProjectionIndex = { key, revision, entryCount, value: cached.value };
      return cached.value;
    }
    const metadata = getMetadataPage.call(this.#manager, 0, entryCount);
    if (metadata.length !== entryCount) {
      throw new Error("Session projection metadata did not cover the session entries");
    }
    const value = emptySessionProjectionIndex();
    appendSessionProjectionIndex(value, metadata);
    this.#cachedProjectionIndex = { key, revision, entryCount, value };
    return value;
  }

  #canonicalId(publicId: string): string {
    return this.#projectionIndex().canonicalIdByPublicId.get(publicId) ?? publicId;
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
    return id === null ? null : this.#projectionIndex().tailByCanonicalId.get(id) ?? id;
  }

  getLeafEntry(): SessionEntry | undefined {
    const id = this.getLeafId();
    return id === null ? undefined : this.getEntry(id);
  }

  /** @internal Preserves canonical usage provenance for host presentation. */
  getActiveBranchUsage(): ActiveBranchUsage {
    return this.#manager.getActiveBranchUsage();
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

  findEntriesOnBranch(query: SessionBranchQuery = {}): SessionEntry[] {
    validateSessionBranchQuery(query);
    const start = query.start === undefined ? this.getLeafId() : query.start;
    if (start === null) return [];
    const path = this.getBranch(start);
    if (path.length === 0) throw new Error(`Entry ${start} not found`);
    return selectSessionBranchEntries(path, query).map((entry) => cloneEntry(entry));
  }

  findEntryOnBranch(query: SessionBranchQuery = {}): SessionEntry | undefined {
    return this.findEntriesOnBranch({ ...query, limit: 1 })[0];
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

  /** @internal Bounded projection used by streaming interfaces. */
  getEntriesPage(offset: number, limit: number): { entries: SessionEntry[]; totalEntries: number } {
    const projection = this.#projectionIndex();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || limit < 1) {
      return { entries: [], totalEntries: projection.totalEntries };
    }
    const end = Math.min(projection.totalEntries, offset + limit);
    if (offset >= end) return { entries: [], totalEntries: projection.totalEntries };
    const firstCanonical = canonicalIndexAtPublicOffset(projection.entries, offset);
    const lastCanonical = canonicalIndexAtPublicOffset(projection.entries, end - 1);
    const metadata = projection.entries.slice(firstCanonical, lastCanonical + 1);
    const getEntriesPage = Reflect.get(this.#manager, "getEntriesPage") as ((
      offset: number,
      limit: number,
    ) => CanonicalSessionEntry[]) | undefined;
    const canonical = getEntriesPage === undefined
      ? this.#manager.getEntries().slice(firstCanonical, firstCanonical + metadata.length)
      : getEntriesPage.call(this.#manager, firstCanonical, metadata.length);
    if (canonical.length !== metadata.length) {
      throw new Error("Session entry page did not match its projection metadata");
    }
    const entries: SessionEntry[] = [];
    for (const [entryIndex, entry] of canonical.entries()) {
      const indexed = metadata[entryIndex]!;
      if (entry.id !== indexed.canonicalId) {
        throw new Error("Session entry page changed while it was being projected");
      }
      const converted = projectEntry(entry, indexed.parentId, new Set());
      if (converted.length !== indexed.publicIds.length) {
        throw new Error(`Session entry ${entry.id} changed its projected entry count`);
      }
      for (const [row, publicEntry] of converted.entries()) {
        entries.push({
          ...publicEntry,
          id: indexed.publicIds[row]!,
          parentId: row === 0 ? indexed.parentId : indexed.publicIds[row - 1]!,
        });
      }
    }
    const pageStart = offset - metadata[0]!.publicStart;
    return {
      entries: entries.slice(pageStart, pageStart + limit).map((entry) => cloneEntry(entry)),
      totalEntries: projection.totalEntries,
    };
  }

  getTree(): SessionTreeNode[] {
    const projection = this.#projection();
    const entries = projection.entries.map((entry) => cloneEntry(entry.publicEntry));
    const nodes = new Map<string, SessionTreeNode>(
      entries.map((entry) => [entry.id, { entry, children: [] }]),
    );
    const roots: SessionTreeNode[] = [];
    for (const [index, entry] of entries.entries()) {
      const node = nodes.get(entry.id)!;
      const canonicalId = projection.entries[index]?.canonicalId ?? entry.id;
      const label = this.#manager.getLabel(canonicalId);
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
