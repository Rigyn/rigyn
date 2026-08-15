import {
  bashExecutionToText,
  convertToLlm as projectMessagesForProvider,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  type AgentMessage,
  type StreamFn,
  type ThinkingLevel,
} from "@rigyn/kernel";
import {
  calculateContextTokens as modelContextTokens,
  contentText,
  estimateContextTokens as estimateModelContextTokens,
  retryAssistantCall,
  uuidv7,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type RetryCallbacks,
  type RetryPolicy,
  type SimpleStreamOptions,
  type Usage,
} from "@rigyn/models";
import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";
import { boundedJsonSnapshot } from "@rigyn/kernel/runtime/core/bounded-json";
import type { JsonValue } from "@rigyn/kernel/runtime/core/json";
import type { CanonicalMessage, ContentBlock } from "@rigyn/kernel/runtime/core/types";
import { estimateMessageTokens as estimateKernelMessageTokens } from "@rigyn/kernel/runtime/context/projection";
import { completeSimple } from "@rigyn/models/compat";

import { deriveContextBudget, fallbackContextBudget } from "./budget.js";
import { estimateTextTokens } from "./projection.js";

import type {
  ReadonlyExtensionSessionManager,
  SessionEntry,
} from "../extensions/session-contract.js";

export interface CompactionSettings {
  enabled: boolean;
  recentTokens: number;
  reserveTokens: number;
  triggerPercent?: number;
  /** Published provider input-token ceiling, independent of the total context window. */
  maxInputTokens?: number;
}

const defaultCompactionBudget = fallbackContextBudget();
const UNSAFE_ARGUMENT_ESTIMATE_CHARS = 4 * 1_024 * 1_024;

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: defaultCompactionBudget.reservedOutputTokens,
  recentTokens: Math.max(1, Math.floor(defaultCompactionBudget.compactAtTokens * 0.2)),
  triggerPercent: 85,
};

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

export interface BranchPreparation {
  totalTokens: number;
  fileOps: FileOperations;
  messages: AgentMessage[];
}

export interface CollectEntriesResult {
  entries: SessionEntry[];
  commonAncestorId: string | null;
}

export interface BranchSummaryResult {
  error?: string;
  aborted?: boolean;
  summary?: string;
  modifiedFiles?: string[];
  readFiles?: string[];
  usage?: Usage;
}

export interface BranchSummaryDetails {
  modifiedFiles: string[];
  readFiles: string[];
}

export interface GenerateBranchSummaryOptions {
  callbacks?: RetryCallbacks;
  retry?: RetryPolicy;
  streamFn?: StreamFn;
  reserveTokens?: number;
  replaceInstructions?: boolean;
  customInstructions?: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  apiKey?: string;
  model: Model;
}

export interface CompactionPreparation {
  settings: CompactionSettings;
  fileOps: FileOperations;
  previousSummary?: string | undefined;
  tokensBefore: number;
  isSplitTurn: boolean;
  turnPrefixMessages: AgentMessage[];
  messagesToSummarize: AgentMessage[];
  firstKeptEntryId: string;
}

export interface CompactionResult<T = unknown> {
  details?: T;
  usage?: Usage;
  /** Host-computed estimate for the returned compacted context. */
  estimatedTokensAfter?: number;
  tokensBefore: number;
  firstKeptEntryId: string;
  summary: string;
}

export type ReadonlyCompactionSessionManager = Pick<
  ReadonlyExtensionSessionManager,
  "getBranch" | "getEntry"
>;

const TOOL_RESULT_MAX_CHARS = 2_000;
const EMPTY_HISTORY_TEXT = "There is no earlier history to summarize.";
const MISSING_RETAINED_ENTRY_ID = "The first retained session entry must have an ID before compaction.";

const BRANCH_PREPARATION_LIMITS = {
  maxContextBytes: 256 * 1024,
  maxContextTokens: 32 * 1024,
  maxPathsPerKind: 512,
  maxPathBytes: 4 * 1024,
  maxPathBytesPerKind: 64 * 1024,
} as const;

function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

function entryMessages(entry: SessionEntry): AgentMessage[] {
  switch (entry.type) {
    case "message": {
      const message = entry.message as AgentMessage & { content?: unknown };
      const requiresContent = message.role === "user" || message.role === "assistant" || message.role === "toolResult";
      return requiresContent && message.content == null
        ? [{ ...message, content: [] } as AgentMessage]
        : [message];
    }
    case "custom_message":
      return [createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)];
    case "branch_summary":
      return entry.summary === ""
        ? []
        : [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
    case "compaction":
      return [
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      ];
    default:
      return [];
  }
}

function compactionMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "compaction") return undefined;
  return entryMessages(entry)[0];
}

function branchMessage(entry: SessionEntry): AgentMessage | undefined {
  return entry.type !== "branch_summary"
    ? entryMessages(entry)[0]
    : createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
}

interface BranchProjection {
  entry: SessionEntry;
  message: AgentMessage;
}

function projectBranchMessages(entries: SessionEntry[]): BranchProjection[] {
  const projected = entries.flatMap((entry) => {
    const message = branchMessage(entry);
    return message === undefined ? [] : [{ entry, message }];
  });
  const calls = new Map<string, { count: number; name: string }>();
  const results = new Map<string, { count: number; name: string }>();
  for (const { message } of projected) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const prior = calls.get(block.id);
        calls.set(block.id, { count: (prior?.count ?? 0) + 1, name: block.name });
      }
    } else if (message.role === "toolResult") {
      const prior = results.get(message.toolCallId);
      results.set(message.toolCallId, { count: (prior?.count ?? 0) + 1, name: message.toolName });
    }
  }
  const paired = new Set([...calls].flatMap(([id, call]) => {
    const result = results.get(id);
    return call.count === 1 && result?.count === 1 && result.name === call.name ? [id] : [];
  }));
  return projected.flatMap(({ entry, message }) => {
    let selected = message;
    if (message.role === "assistant") {
      const content = message.content.filter((block) => block.type !== "toolCall" || paired.has(block.id));
      if (content.length === 0) return [];
      selected = content.length === message.content.length ? message : { ...message, content };
    } else if (message.role === "toolResult" && !paired.has(message.toolCallId)) return [];
    return [{ entry, message: selected }];
  });
}

function safeBranchBoundaries(frames: readonly BranchProjection[]): boolean[] {
  const spans = new Map<string, { first: number; last: number }>();
  frames.forEach((frame, index) => {
    const message = frame.message;
    const ids = message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : message.role === "toolResult" ? [message.toolCallId] : [];
    for (const id of ids) {
      const prior = spans.get(id);
      spans.set(id, {
        first: Math.min(prior?.first ?? index, index),
        last: Math.max(prior?.last ?? index, index),
      });
    }
  });
  return Array.from(
    { length: frames.length + 1 },
    (_value, boundary) => [...spans.values()].every(
      (span) => !(span.first < boundary && boundary <= span.last),
    ),
  );
}

interface SafeArguments {
  serialized: string;
  value: { [key: string]: JsonValue };
}

function snapshotArguments(value: unknown): SafeArguments | undefined {
  try {
    const snapshot = boundedJsonSnapshot(value, {
      label: "Compaction tool-call arguments",
      maximumBytes: ASSISTANT_CONTENT_LIMITS.fieldBytes,
      maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
      maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
      maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
    });
    if (snapshot.value === null || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
      return undefined;
    }
    return { serialized: snapshot.serialized, value: snapshot.value as { [key: string]: JsonValue } };
  } catch {
    return undefined;
  }
}

function canonicalInputBlocks(
  content: string | readonly { type: string; text?: string; data?: string; mimeType?: string }[],
): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image" && typeof block.mimeType === "string") {
      blocks.push({
        type: "image",
        mediaType: block.mimeType,
        ...(typeof block.data === "string" ? { data: block.data } : {}),
      });
    }
  }
  return blocks;
}

function canonicalTokenProjection(message: AgentMessage): CanonicalMessage | undefined {
  const base = { id: "public-compaction-estimate", createdAt: new Date(0).toISOString() } as const;
  if (message.role === "user") {
    return { ...base, role: "user", content: canonicalInputBlocks(message.content) };
  }
  if (message.role === "assistant") {
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "thinking") content.push({ type: "thinking", thinking: block.thinking });
      else {
        const argumentsSnapshot = snapshotArguments(block.arguments);
        if (argumentsSnapshot === undefined) return undefined;
        content.push({
          type: "tool_call",
          callId: block.id,
          name: block.name,
          arguments: argumentsSnapshot.value,
          rawArguments: argumentsSnapshot.serialized,
        });
      }
    }
    return { ...base, role: "assistant", content };
  }
  if (message.role === "toolResult") {
    const text = typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    const images = typeof message.content === "string"
      ? []
      : message.content.flatMap((block) => block.type === "image"
        ? [{ type: "image" as const, mediaType: block.mimeType, data: block.data }]
        : []);
    return {
      ...base,
      role: "tool",
      content: [{
        type: "tool_result",
        callId: message.toolCallId,
        name: message.toolName,
        content: text,
        isError: message.isError,
        ...(images.length === 0 ? {} : { images }),
      }],
    };
  }
  const text = message.role === "bashExecution"
    ? bashExecutionToText(message)
    : message.role === "custom"
      ? message.content
      : message.summary;
  return {
    ...base,
    role: "user",
    content: typeof text === "string" ? [{ type: "text", text }] : canonicalInputBlocks(text),
  };
}

export function estimateTokens(message: AgentMessage): number {
  const projection = canonicalTokenProjection(message);
  return projection === undefined
    ? Math.ceil(UNSAFE_ARGUMENT_ESTIMATE_CHARS / 4)
    : estimateKernelMessageTokens(projection);
}

export function calculateContextTokens(usage: Usage): number | undefined {
  if (Number.isSafeInteger(usage.totalTokens) && usage.totalTokens! > 0) {
    return usage.totalTokens;
  }
  const inputTokens = modelContextTokens(usage);
  if (
    inputTokens === undefined || usage.output === undefined ||
    !Number.isSafeInteger(usage.output) || usage.output < 0
  ) return undefined;
  const total = inputTokens + usage.output;
  return Number.isSafeInteger(total) ? total : undefined;
}

function assistantUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  return (calculateContextTokens(message.usage) ?? 0) > 0 ? message.usage : undefined;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const usage = assistantUsage(entry.message);
    if (usage !== undefined) return usage;
  }
  return undefined;
}

export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  let lastUsageIndex = -1;
  let usage: Usage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    usage = assistantUsage(messages[index]!);
    if (usage !== undefined) {
      lastUsageIndex = index;
      break;
    }
  }
  const usageTokens = usage === undefined ? 0 : (calculateContextTokens(usage) ?? 0);
  const trailingStart = lastUsageIndex + 1;
  const boundedAdd = (left: number, right: number): number => {
    const total = left + right;
    return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
  };
  const trailingTokens = messages
    .slice(trailingStart)
    .reduce((total, message) => boundedAdd(total, estimateTokens(message)), 0);
  return {
    tokens: boundedAdd(usageTokens, trailingTokens),
    usageTokens,
    trailingTokens,
    lastUsageIndex: lastUsageIndex < 0 ? null : lastUsageIndex,
  };
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  if (
    settings.maxInputTokens !== undefined &&
    (!Number.isSafeInteger(settings.maxInputTokens) || settings.maxInputTokens < 1)
  ) {
    throw new RangeError("maxInputTokens must be a positive safe integer");
  }
  const budget = deriveContextBudget({
    contextTokens: contextWindow,
    ...(settings.maxInputTokens === undefined ? {} : { maxInputTokens: settings.maxInputTokens }),
  }, {
    reserveTokens: settings.reserveTokens,
    ...(settings.triggerPercent === undefined ? {} : { triggerPercent: settings.triggerPercent }),
  });
  return budget !== undefined && contextTokens > budget.compactAtTokens;
}

function isCutPointMessage(message: AgentMessage): boolean {
  return message.role === "user"
    || message.role === "assistant"
    || message.role === "bashExecution"
    || message.role === "custom"
    || message.role === "branchSummary"
    || message.role === "compactionSummary";
}

function isTurnStartMessage(message: AgentMessage): boolean {
  return message.role === "user"
    || message.role === "bashExecution"
    || message.role === "custom"
    || message.role === "branchSummary"
    || message.role === "compactionSummary";
}

function isTurnStartEntry(entry: SessionEntry): boolean {
  return entry.type !== "compaction" && entryMessages(entry).some(isTurnStartMessage);
}

interface ToolSpan {
  first: number;
  last: number;
  sawCall: boolean;
  sawResult: boolean;
}

function conversationToolSpans(entries: readonly SessionEntry[], startIndex: number, endIndex: number): ToolSpan[] {
  const spans = new Map<string, ToolSpan>();
  const visit = (id: string, index: number, kind: "call" | "result"): void => {
    const prior = spans.get(id);
    const span = prior ?? { first: index, last: index, sawCall: false, sawResult: false };
    span.first = Math.min(span.first, index);
    span.last = Math.max(span.last, index);
    if (kind === "call") span.sawCall = true;
    else span.sawResult = true;
    spans.set(id, span);
  };
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    for (const message of entryMessages(entry)) {
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") visit(block.id, index, "call");
        }
      } else if (message.role === "toolResult") visit(message.toolCallId, index, "result");
    }
  }
  return [...spans.values()].filter((span) => span.sawCall && span.sawResult);
}

function eligibleCutBoundaries(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
  const boundaries: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    if (
      entry !== undefined &&
      entry.type !== "compaction" &&
      entryMessages(entry).some(isCutPointMessage)
    ) boundaries.push(index);
  }
  return boundaries;
}

function safeCutBoundaries(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
  const spans = conversationToolSpans(entries, startIndex, endIndex);
  return eligibleCutBoundaries(entries, startIndex, endIndex).filter(
    (boundary) => spans.every((span) => !(span.first < boundary && boundary <= span.last)),
  );
}

export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
  for (let index = entryIndex; index >= startIndex; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && isTurnStartEntry(entry)) return index;
  }
  return -1;
}

export function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  recentTokens: number,
): CutPointResult {
  const eligible = eligibleCutBoundaries(entries, startIndex, endIndex);
  const boundaries = safeCutBoundaries(entries, startIndex, endIndex);
  if (boundaries.length === 0) {
    return {
      firstKeptEntryIndex: startIndex,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  let accumulatedTokens = 0;
  let desiredBoundary = eligible[0] ?? boundaries[0]!;
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const tokens = entryMessages(entry).reduce((total, message) => total + estimateTokens(message), 0);
    if (tokens === 0) continue;
    accumulatedTokens += tokens;
    if (accumulatedTokens < recentTokens) continue;
    desiredBoundary = eligible.find((candidate) => candidate >= index) ?? desiredBoundary;
    break;
  }
  const firstKeptEntryIndex = boundaries.findLast((boundary) => boundary <= desiredBoundary)
    ?? boundaries.find((boundary) => boundary > desiredBoundary)
    ?? boundaries[0]!;

  let adjustedKeptEntryIndex = firstKeptEntryIndex;
  while (adjustedKeptEntryIndex > startIndex) {
    const previous = entries[adjustedKeptEntryIndex - 1];
    if (previous === undefined || previous.type === "compaction" || entryMessages(previous).length > 0) break;
    adjustedKeptEntryIndex -= 1;
  }

  const selected = entries[adjustedKeptEntryIndex];
  const startsTurn = selected !== undefined && isTurnStartEntry(selected);
  const turnStartIndex = startsTurn
    ? -1
    : findTurnStartIndex(entries, adjustedKeptEntryIndex, startIndex);
  return {
    firstKeptEntryIndex: adjustedKeptEntryIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}

function toolArgumentPath(value: unknown): unknown {
  const snapshot = snapshotArguments(value);
  return snapshot?.value.path;
}

function recordBoundedPath(paths: Set<string>, value: unknown): void {
  if (
    typeof value !== "string" || value === "" ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > BRANCH_PREPARATION_LIMITS.maxPathBytes ||
    paths.has(value)
  ) return;
  const bytes = Buffer.byteLength(value, "utf8");
  let retainedBytes = [...paths].reduce((total, path) => total + Buffer.byteLength(path, "utf8"), 0);
  while (
    paths.size >= BRANCH_PREPARATION_LIMITS.maxPathsPerKind ||
    retainedBytes + bytes > BRANCH_PREPARATION_LIMITS.maxPathBytesPerKind
  ) {
    const oldest = paths.values().next().value as string | undefined;
    if (oldest === undefined) return;
    paths.delete(oldest);
    retainedBytes -= Buffer.byteLength(oldest, "utf8");
  }
  paths.add(value);
}

function recordNestedPaths(paths: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  const start = Math.max(0, value.length - (BRANCH_PREPARATION_LIMITS.maxPathsPerKind * 2));
  for (let index = start; index < value.length; index += 1) recordBoundedPath(paths, value[index]);
}

function extractSuccessfulFileOps(messages: readonly AgentMessage[], fileOps: FileOperations): void {
  const calls = new Map<string, { name: string; path: unknown }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      calls.set(block.id, { name: block.name, path: toolArgumentPath(block.arguments) });
    }
  }
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError) continue;
    const call = calls.get(message.toolCallId);
    if (call === undefined || call.name !== message.toolName) continue;
    if (call.name === "read") recordBoundedPath(fileOps.read, call.path);
    else if (call.name === "write") recordBoundedPath(fileOps.written, call.path);
    else if (call.name === "edit") recordBoundedPath(fileOps.edited, call.path);
  }
}

function computeFileLists(fileOps: FileOperations): CompactionDetails {
  const modified = new Set(fileOps.edited);
  for (const path of fileOps.written) modified.add(path);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const taggedLists = [
    ["files-read", readFiles],
    ["files-changed", modifiedFiles],
  ] as const;
  const metadata = taggedLists
    .filter(([, paths]) => paths.length > 0)
    .map(([tag, paths]) => `<${tag}>\n${paths.join("\n")}\n</${tag}>`)
    .join("\n\n");
  return metadata === "" ? "" : `\n\n${metadata}`;
}

export function prepareBranchEntries(entries: SessionEntry[], tokenBudget?: number): BranchPreparation {
  const requestedTokenBudget = tokenBudget === undefined ? undefined : Math.floor(tokenBudget);
  if (requestedTokenBudget !== undefined && (!Number.isFinite(requestedTokenBudget) || requestedTokenBudget <= 0)) {
    return { messages: [], fileOps: createFileOps(), totalTokens: 0 };
  }
  const projections = projectBranchMessages(entries);
  const safeStarts = safeBranchBoundaries(projections);
  const effectiveTokenBudget = Math.min(
    BRANCH_PREPARATION_LIMITS.maxContextTokens,
    requestedTokenBudget ?? BRANCH_PREPARATION_LIMITS.maxContextTokens,
  );
  let selectedStart = projections.length;
  let suffixBytes = 0;
  let suffixTokens = 0;
  for (let index = projections.length - 1; index >= 0; index -= 1) {
    const projection = projections[index]!;
    const messageTokens = estimateTokens(projection.message);
    if (suffixTokens + messageTokens > effectiveTokenBudget) break;
    let messageBytes: number;
    try {
      const text = serializeConversation(convertToLlm([projection.message]));
      messageBytes = Buffer.byteLength(text, "utf8");
    } catch {
      break;
    }
    const separatorBytes = index === projections.length - 1 ? 0 : 2;
    if (suffixBytes + separatorBytes + messageBytes > BRANCH_PREPARATION_LIMITS.maxContextBytes) break;
    suffixTokens += messageTokens;
    suffixBytes += separatorBytes + messageBytes;
    if (safeStarts[index] === true) selectedStart = index;
  }
  if (projections.length > 0 && selectedStart === projections.length) {
    throw new Error("The newest complete message or tool pair cannot fit the branch summary context bounds");
  }
  const selected = projections.slice(selectedStart);
  const messages = selected.map((projection) => projection.message);
  const fileOps = createFileOps();
  const firstSelectedId = selected[0]?.entry.id;
  const firstSelectedEntry = firstSelectedId === undefined
    ? entries.length
    : entries.findIndex((entry) => entry.id === firstSelectedId);
  const activityEntries = entries.slice(firstSelectedEntry < 0 ? entries.length : firstSelectedEntry);
  for (const entry of activityEntries) {
    if (entry.type !== "branch_summary" || entry.fromHook || entry.details === undefined) continue;
    const details = entry.details as Partial<BranchSummaryDetails>;
    recordNestedPaths(fileOps.read, details.readFiles);
    recordNestedPaths(fileOps.edited, details.modifiedFiles);
  }
  extractSuccessfulFileOps(activityEntries.flatMap(entryMessages), fileOps);
  return {
    messages,
    fileOps,
    totalTokens: selected.reduce((total, projection) => total + estimateTokens(projection.message), 0),
  };
}

export function collectEntriesForBranchSummary(
  session: ReadonlyCompactionSessionManager,
  oldLeafId: string | null,
  targetId: string,
): CollectEntriesResult {
  if (oldLeafId === null) return { entries: [], commonAncestorId: null };

  const oldPathIds = new Set(session.getBranch(oldLeafId).map((entry) => entry.id));
  const targetPath = session.getBranch(targetId);
  let commonAncestorId: string | null = null;
  for (let index = targetPath.length - 1; index >= 0; index -= 1) {
    const id = targetPath[index]?.id;
    if (id !== undefined && oldPathIds.has(id)) {
      commonAncestorId = id;
      break;
    }
  }

  const entries: SessionEntry[] = [];
  let current: string | null = oldLeafId;
  while (current !== null && current !== commonAncestorId) {
    const entry = session.getEntry(current);
    if (entry === undefined) break;
    entries.push(entry);
    current = entry.parentId;
  }
  entries.reverse();
  return { entries, commonAncestorId };
}

type TextContentSource = string | readonly { type: string; text?: string }[];

function textParts(content: TextContentSource): string[] {
  if (typeof content === "string") return [content];
  const output: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (!(index in content)) continue;
    const block = content[index]!;
    if (block.type === "text" && typeof block.text === "string") output.push(block.text);
  }
  return output;
}

function truncatedToolText(content: TextContentSource): string | undefined {
  let output = "";
  let total = 0;
  const retain = (part: string): void => {
    total += part.length;
    if (output.length < TOOL_RESULT_MAX_CHARS) {
      output += part.slice(0, TOOL_RESULT_MAX_CHARS - output.length);
    }
  };
  if (typeof content === "string") retain(content);
  else for (let index = 0; index < content.length; index += 1) {
    if (!(index in content)) continue;
    const block = content[index]!;
    if (block.type === "text" && typeof block.text === "string") retain(block.text);
  }
  if (total === 0) return undefined;
  return total <= TOOL_RESULT_MAX_CHARS
    ? output
    : `${output}\n\n[... ${total - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
}

export function serializeConversation(messages: Message[]): string {
  const sections: string[] = [];
  let retainedBytes = 0;
  let retainedArgumentBytes = 0;
  const pushSectionParts = (prefix: string, parts: readonly string[], separator: string): void => {
    const outerBytes = sections.length === 0 ? 0 : 2;
    const separatorBytes = Buffer.byteLength(separator, "utf8");
    let sectionBytes = Buffer.byteLength(prefix, "utf8");
    if (outerBytes + sectionBytes > ASSISTANT_CONTENT_LIMITS.contentBytes - retainedBytes) {
      throw new TypeError(
        `Compaction conversation exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate UTF-8 bytes`,
      );
    }
    for (let index = 0; index < parts.length; index += 1) {
      const added = Buffer.byteLength(parts[index]!, "utf8") + (index === 0 ? 0 : separatorBytes);
      if (added > ASSISTANT_CONTENT_LIMITS.contentBytes - retainedBytes - outerBytes - sectionBytes) {
        throw new TypeError(
          `Compaction conversation exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate UTF-8 bytes`,
        );
      }
      sectionBytes += added;
    }
    retainedBytes += outerBytes + sectionBytes;
    sections.push(prefix + parts.join(separator));
  };
  for (const message of messages) {
    if (message.role === "user") {
      const text = textParts(message.content);
      if (text.some((part) => part !== "")) pushSectionParts("[User]: ", text, "");
      continue;
    }
    if (message.role === "toolResult") {
      const text = truncatedToolText(message.content);
      if (text !== undefined) pushSectionParts("[Tool result]: ", [text], "");
      continue;
    }

    const thinking: string[] = [];
    const text: string[] = [];
    const callParts: string[] = [];
    let calls = 0;
    for (const block of message.content) {
      if (block.type === "thinking") thinking.push(block.thinking);
      else if (block.type === "text") text.push(block.text);
      else if (block.type === "toolCall") {
        const snapshot = boundedJsonSnapshot(block.arguments, {
          label: "Compaction tool-call arguments",
          maximumBytes: ASSISTANT_CONTENT_LIMITS.fieldBytes,
          maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
          maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
          maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
        });
        if (snapshot.bytes > ASSISTANT_CONTENT_LIMITS.contentBytes - retainedArgumentBytes) {
          throw new TypeError(
            `Compaction tool-call arguments exceed ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate UTF-8 bytes`,
          );
        }
        retainedArgumentBytes += snapshot.bytes;
        if (snapshot.value === null || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
          throw new TypeError("Compaction tool-call arguments must be a plain JSON object");
        }
        const argumentsText = Object.entries(snapshot.value)
          .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
          .join(", ");
        if (calls > 0) callParts.push("; ");
        callParts.push(block.name, "(", argumentsText, ")");
        calls += 1;
      }
    }
    if (thinking.length > 0) pushSectionParts("[Assistant thinking]: ", thinking, "\n");
    if (text.length > 0) pushSectionParts("[Assistant]: ", text, "\n");
    if (calls > 0) pushSectionParts("[Assistant tool calls]: ", callParts, "");
  }
  return sections.join("\n\n");
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return projectMessagesForProvider(messages);
}

export const SUMMARIZATION_SYSTEM_PROMPT = [
  "Condense the supplied conversation into a durable continuation checkpoint.",
  "Do not answer the conversation or perform its tasks; return only the requested summary.",
].join(" ");

const NEW_SUMMARY_INSTRUCTIONS = [
  "Produce a concise checkpoint organized by goals, constraints, completed work, current work, blockers, decisions, next actions, and critical technical context.",
  "Retain exact paths, identifiers, commands, and errors needed to resume safely.",
].join(" ");

const UPDATED_SUMMARY_INSTRUCTIONS = [
  "Merge the new conversation material into the earlier checkpoint.",
  "Preserve still-relevant goals, constraints, decisions, and technical details; update progress and next actions to reflect the latest state.",
].join(" ");

const BRANCH_SUMMARY_INSTRUCTIONS = [
  "Summarize the abandoned branch for a later return.",
  "Capture its goal, constraints, finished and unfinished work, blockers, decisions, and next actions while retaining exact technical identifiers.",
].join(" ");

const TURN_PREFIX_INSTRUCTIONS = [
  "Summarize only this early portion of a split turn.",
  "State the original request, early progress, and context required to understand the retained suffix.",
].join(" ");

function requestOptions(
  selectedModel: Model,
  outputLimit: number,
  credential: string | undefined,
  requestHeaders: Record<string, string> | undefined,
  requestEnvironment: Record<string, string> | undefined,
  abortSignal: AbortSignal | undefined,
  reasoningLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
  return {
    maxTokens: outputLimit,
    apiKey: credential,
    headers: requestHeaders,
    env: requestEnvironment,
    signal: abortSignal,
    ...(selectedModel.reasoning && reasoningLevel !== undefined && reasoningLevel !== "off"
      ? { reasoning: reasoningLevel }
      : {}),
  } as SimpleStreamOptions;
}

function assertSummarizationInputLimit(model: Model, context: Context): void {
  const maxInputTokens = model.maxInputTokens;
  if (maxInputTokens === undefined) return;
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) {
    throw new RangeError("Model maximum input token limit must be a positive safe integer");
  }
  const estimatedInput = estimateModelContextTokens(context).tokens;
  if (estimatedInput > maxInputTokens) {
    throw new RangeError(
      `Estimated prompt tokens (${estimatedInput}) exceed the model maximum input token limit (${maxInputTokens})`,
    );
  }
}

async function invokeCheckpointModel(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  streamFn?: StreamFn,
  retry?: RetryPolicy,
  callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
  assertSummarizationInputLimit(model, context);
  const request = {
    ...options,
    cacheRetention: "none" as const,
    sessionId: uuidv7(),
  };
  return await retryAssistantCall(async () => {
    if (streamFn === undefined) return await completeSimple(model, context, request);
    const stream = await streamFn(model, context, request);
    return await stream.result();
  }, retry, request.signal, callbacks);
}

function checkpointResponseViolation(
  response: AssistantMessage,
  text: string,
  maxOutputTokens: number,
): string | undefined {
  if (response.content.some((block) => block.type === "toolCall")) {
    return "included a tool call despite requesting a text-only summary";
  }
  const reportedOutputTokens = response.usage.output;
  if (reportedOutputTokens !== undefined && reportedOutputTokens > 0) {
    return reportedOutputTokens > maxOutputTokens
      ? `reported ${reportedOutputTokens} output tokens, above its limit of ${maxOutputTokens}`
      : undefined;
  }
  const estimatedOutputTokens = estimateTextTokens(text);
  if (estimatedOutputTokens > maxOutputTokens) {
    return `estimated ${estimatedOutputTokens} output tokens, above its limit of ${maxOutputTokens}`;
  }
  return undefined;
}

function requireCompletedCheckpoint(
  response: AssistantMessage,
  operation: string,
  maxOutputTokens: number,
): { text: string; usage: Usage } {
  const detail = response.errorMessage?.trim();
  if (response.stopReason === "aborted") {
    throw new Error(`${operation} was aborted${detail ? `: ${detail}` : ""}`);
  }
  if (response.stopReason === "error") {
    throw new Error(`${operation} could not produce a checkpoint${detail ? `: ${detail}` : ""}`);
  }
  if (response.stopReason !== "stop") {
    throw new Error(`${operation} ended with ${response.stopReason} before producing a complete checkpoint`);
  }
  const text = contentText(response.content);
  const violation = checkpointResponseViolation(response, text, maxOutputTokens);
  if (violation !== undefined) throw new Error(`${operation} ${violation}`);
  return { usage: response.usage, text };
}

function checkpointContext(
  messages: AgentMessage[],
  instructions: string,
  previousSummary?: string,
): Context {
  const conversation = serializeConversation(convertToLlm(messages));
  const prior = previousSummary === undefined
    ? ""
    : `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\n${prior}${instructions}`;
  return {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  };
}

interface CheckpointRequest {
  callbacks?: RetryCallbacks | undefined;
  context: Context;
  credential?: string | undefined;
  environment?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  maxOutputTokens: number;
  model: Model;
  operation: string;
  reasoning?: ThinkingLevel | undefined;
  retry?: RetryPolicy | undefined;
  signal?: AbortSignal | undefined;
  stream?: StreamFn | undefined;
}

async function requestCompletedCheckpoint(request: CheckpointRequest): Promise<{ text: string; usage: Usage }> {
  const response = await invokeCheckpointModel(
    request.model,
    request.context,
    requestOptions(
      request.model,
      request.maxOutputTokens,
      request.credential,
      request.headers,
      request.environment,
      request.signal,
      request.reasoning,
    ),
    request.stream,
    request.retry,
    request.callbacks,
  );
  return requireCompletedCheckpoint(response, request.operation, request.maxOutputTokens);
}

export async function generateSummary(
  messages: AgentMessage[],
  selectedModel: Model,
  tokenReserve: number,
  credential: string | undefined,
  requestHeaders?: Record<string, string>,
  abortSignal?: AbortSignal,
  extraInstructions?: string,
  priorSummary?: string,
  reasoningLevel?: ThinkingLevel,
  executeStream?: StreamFn,
  requestEnvironment?: Record<string, string>,
  retryPolicy?: RetryPolicy,
  retryCallbacks?: RetryCallbacks,
): Promise<string> {
  return (await generateSummaryWithUsage(
    messages,
    selectedModel,
    tokenReserve,
    credential,
    requestHeaders,
    abortSignal,
    extraInstructions,
    priorSummary,
    reasoningLevel,
    executeStream,
    requestEnvironment,
    retryPolicy,
    retryCallbacks,
  )).text;
}

export async function generateSummaryWithUsage(
  messages: AgentMessage[],
  selectedModel: Model,
  tokenReserve: number,
  credential: string | undefined,
  requestHeaders?: Record<string, string>,
  abortSignal?: AbortSignal,
  extraInstructions?: string,
  priorSummary?: string,
  reasoningLevel?: ThinkingLevel,
  executeStream?: StreamFn,
  requestEnvironment?: Record<string, string>,
  retryPolicy?: RetryPolicy,
  retryCallbacks?: RetryCallbacks,
): Promise<{ text: string; usage: Usage }> {
  const maxTokens = Math.min(
    Math.floor(tokenReserve * 0.8),
    selectedModel.maxTokens > 0 ? selectedModel.maxTokens : Number.POSITIVE_INFINITY,
  );
  let instructions = priorSummary
    ? UPDATED_SUMMARY_INSTRUCTIONS
    : NEW_SUMMARY_INSTRUCTIONS;
  if (extraInstructions) {
    instructions += `\n\nAdditional focus: ${extraInstructions}`;
  }
  return await requestCompletedCheckpoint({
    model: selectedModel,
    context: checkpointContext(messages, instructions, priorSummary),
    maxOutputTokens: maxTokens,
    operation: "Session checkpoint",
    credential,
    headers: requestHeaders,
    environment: requestEnvironment,
    signal: abortSignal,
    reasoning: reasoningLevel,
    stream: executeStream,
    retry: retryPolicy,
    callbacks: retryCallbacks,
  });
}

export async function generateBranchSummary(
  entries: SessionEntry[],
  options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
  const contextWindow = Math.floor(options.model.contextWindow);
  const outputTokens = Math.min(2_048, Math.floor(options.model.maxTokens));
  const publishedInputTokens = options.model.maxInputTokens === undefined
    ? contextWindow
    : Math.floor(options.model.maxInputTokens);
  const reserveTokens = Math.max(0, Math.floor(options.reserveTokens ?? 18_000));
  const inputTokenBudget = Math.min(contextWindow - outputTokens, publishedInputTokens) - reserveTokens;
  if (
    !Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(publishedInputTokens) || !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(reserveTokens) || !Number.isSafeInteger(inputTokenBudget) ||
    contextWindow <= 0 || publishedInputTokens <= 0 || outputTokens <= 0 || inputTokenBudget <= 0
  ) {
    return { error: "The selected model does not leave a positive input budget for branch summarization" };
  }
  const prepared = prepareBranchEntries(entries, inputTokenBudget);
  if (prepared.messages.length === 0) return { summary: "Nothing is available for summarization" };

  let instructions = BRANCH_SUMMARY_INSTRUCTIONS;
  if (options.replaceInstructions && options.customInstructions) instructions = options.customInstructions;
  else if (options.customInstructions) instructions += `\n\nAdditional focus: ${options.customInstructions}`;
  const request = {
    apiKey: options.apiKey,
    headers: options.headers,
    env: options.env,
    signal: options.signal,
    maxTokens: outputTokens,
  } as SimpleStreamOptions;
  const summaryContext = checkpointContext(prepared.messages, instructions);
  if (estimateModelContextTokens(summaryContext).tokens > inputTokenBudget) {
    return { error: "The branch summary request exceeds the selected model input budget" };
  }
  const response = await invokeCheckpointModel(
    options.model,
    summaryContext,
    request,
    options.streamFn,
    options.retry,
    options.callbacks,
  );
  if (response.stopReason === "aborted") return { aborted: true };
  if (response.stopReason === "error") {
    return { error: response.errorMessage || "Summary generation failed" };
  }
  if (response.stopReason !== "stop") {
    return { error: `Branch summarization ended with ${response.stopReason} before producing a complete summary` };
  }

  const files = computeFileLists(prepared.fileOps);
  const generated = contentText(response.content);
  const violation = checkpointResponseViolation(response, generated, outputTokens);
  if (violation !== undefined) return { error: `Branch summarization ${violation}` };
  const summary = `A prior conversation branch was explored and then left.\nContinuation context from that branch:\n\n${generated}`
    + formatFileOperations(files.readFiles, files.modifiedFiles);
  return {
    summary: summary || "The summarizer returned no text",
    usage: response.usage,
    ...files,
  };
}

interface CompactionAnchor {
  entry?: SessionEntry & { type: "compaction" };
  index: number;
  retainedStart: number;
}

function locateCompactionAnchor(entries: SessionEntry[]): CompactionAnchor {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      const entry = entries[index];
      if (entry?.type !== "compaction") break;
      const retainedIndex = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
      return {
        entry,
        index,
        retainedStart: retainedIndex >= 0 && retainedIndex < index ? retainedIndex : index + 1,
      };
    }
  }
  return { index: -1, retainedStart: 0 };
}

function activeCompactionMessages(entries: SessionEntry[], anchor: CompactionAnchor): AgentMessage[] {
  if (anchor.entry === undefined) return entries.flatMap(entryMessages);
  const retained = entries
    .slice(anchor.retainedStart, anchor.index)
    .filter((entry) => entry.type !== "compaction");
  return [anchor.entry, ...retained, ...entries.slice(anchor.index + 1)].flatMap(entryMessages);
}

function retainedFileOperations(anchor: CompactionAnchor): FileOperations {
  const operations = createFileOps();
  if (anchor.entry?.fromHook || anchor.entry?.details === undefined) return operations;
  const details = anchor.entry.details as Partial<CompactionDetails>;
  recordNestedPaths(operations.read, details.readFiles);
  recordNestedPaths(operations.edited, details.modifiedFiles);
  return operations;
}

function summaryMessages(entries: SessionEntry[], start: number, end: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = start; index < end; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const message = compactionMessage(entry);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

export function prepareCompaction(
  entries: SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  if (entries.at(-1)?.type === "compaction") return undefined;

  const anchor = locateCompactionAnchor(entries);
  const cut = findCutPoint(entries, anchor.retainedStart, entries.length, settings.recentTokens);
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (firstKept?.id === undefined) return undefined;

  const summarizedEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize = summaryMessages(entries, anchor.retainedStart, summarizedEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? summaryMessages(entries, cut.turnStartIndex, cut.firstKeptEntryIndex)
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

  const fileOps = retainedFileOperations(anchor);
  extractSuccessfulFileOps([...messagesToSummarize, ...turnPrefixMessages], fileOps);
  return {
    settings,
    fileOps,
    previousSummary: anchor.entry?.summary,
    tokensBefore: estimateContextTokens(activeCompactionMessages(entries, anchor)).tokens,
    isSplitTurn: cut.isSplitTurn,
    turnPrefixMessages,
    messagesToSummarize,
    firstKeptEntryId: firstKept.id,
  };
}

function combineUsage(earlier: Usage, later: Usage): Usage {
  const completeSum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined || right === undefined ||
    !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 ||
    !Number.isSafeInteger(left + right)
      ? undefined
      : left + right;
  const cacheRead = completeSum(earlier.cacheRead, later.cacheRead);
  const cacheWrite = completeSum(earlier.cacheWrite, later.cacheWrite);
  const cacheWrite1h = completeSum(earlier.cacheWrite1h, later.cacheWrite1h);
  const reasoning = completeSum(earlier.reasoning, later.reasoning);
  const input = completeSum(earlier.input, later.input);
  const output = completeSum(earlier.output, later.output);
  const totalTokens = completeSum(earlier.totalTokens, later.totalTokens);
  let cost: Usage["cost"];
  if (earlier.cost !== undefined && later.cost !== undefined) {
    const inputCost = earlier.cost.input + later.cost.input;
    const outputCost = earlier.cost.output + later.cost.output;
    const cacheReadCost = earlier.cost.cacheRead + later.cost.cacheRead;
    const cacheWriteCost = earlier.cost.cacheWrite + later.cost.cacheWrite;
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    if ([inputCost, outputCost, cacheReadCost, cacheWriteCost, totalCost].every((value) => Number.isFinite(value) && value >= 0)) {
      cost = { input: inputCost, output: outputCost, cacheRead: cacheReadCost, cacheWrite: cacheWriteCost, total: totalCost };
    }
  }
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cost === undefined ? {} : { cost }),
  };
}

async function generateTurnPrefixSummary(
  prefixMessages: AgentMessage[],
  selectedModel: Model,
  tokenReserve: number,
  credential: string | undefined,
  requestHeaders: Record<string, string> | undefined,
  requestEnvironment: Record<string, string> | undefined,
  abortSignal: AbortSignal | undefined,
  reasoningLevel: ThinkingLevel | undefined,
  executeStream: StreamFn | undefined,
  retryPolicy: RetryPolicy | undefined,
  retryCallbacks: RetryCallbacks | undefined,
): Promise<{ text: string; usage: Usage }> {
  const maxTokens = Math.min(
    Math.floor(tokenReserve * 0.5),
    selectedModel.maxTokens > 0 ? selectedModel.maxTokens : Number.POSITIVE_INFINITY,
  );
  return await requestCompletedCheckpoint({
    model: selectedModel,
    context: checkpointContext(prefixMessages, TURN_PREFIX_INSTRUCTIONS),
    maxOutputTokens: maxTokens,
    operation: "Retained turn prefix",
    credential,
    headers: requestHeaders,
    environment: requestEnvironment,
    signal: abortSignal,
    reasoning: reasoningLevel,
    stream: executeStream,
    retry: retryPolicy,
    callbacks: retryCallbacks,
  });
}

export async function compact(
  prepared: CompactionPreparation,
  selectedModel: Model,
  credential: string | undefined,
  requestHeaders?: Record<string, string>,
  extraInstructions?: string,
  abortSignal?: AbortSignal,
  reasoningLevel?: ThinkingLevel,
  executeStream?: StreamFn,
  requestEnvironment?: Record<string, string>,
  retryPolicy?: RetryPolicy,
  retryCallbacks?: RetryCallbacks,
): Promise<CompactionResult> {
  let summary: string;
  let usage: Usage;
  if (prepared.isSplitTurn && prepared.turnPrefixMessages.length > 0) {
    let historyText = EMPTY_HISTORY_TEXT;
    let historyUsage: Usage | undefined;
    if (prepared.messagesToSummarize.length > 0) {
      const generated = await generateSummaryWithUsage(
        prepared.messagesToSummarize,
        selectedModel,
        prepared.settings.reserveTokens,
        credential,
        requestHeaders,
        abortSignal,
        extraInstructions,
        prepared.previousSummary,
        reasoningLevel,
        executeStream,
        requestEnvironment,
        retryPolicy,
        retryCallbacks,
      );
      historyText = generated.text;
      historyUsage = generated.usage;
    }
    const prefix = await generateTurnPrefixSummary(
      prepared.turnPrefixMessages,
      selectedModel,
      prepared.settings.reserveTokens,
      credential,
      requestHeaders,
      requestEnvironment,
      abortSignal,
      reasoningLevel,
      executeStream,
      retryPolicy,
      retryCallbacks,
    );
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = historyUsage === undefined ? prefix.usage : combineUsage(historyUsage, prefix.usage);
  } else {
    const generated = await generateSummaryWithUsage(
      prepared.messagesToSummarize,
      selectedModel,
      prepared.settings.reserveTokens,
      credential,
      requestHeaders,
      abortSignal,
      extraInstructions,
      prepared.previousSummary,
      reasoningLevel,
      executeStream,
      requestEnvironment,
      retryPolicy,
      retryCallbacks,
    );
    summary = generated.text;
    usage = generated.usage;
  }

  const files = computeFileLists(prepared.fileOps);
  summary += formatFileOperations(files.readFiles, files.modifiedFiles);
  if (prepared.firstKeptEntryId === "") {
    throw new Error(MISSING_RETAINED_ENTRY_ID);
  }
  return {
    summary,
    firstKeptEntryId: prepared.firstKeptEntryId,
    tokensBefore: prepared.tokensBefore,
    usage,
    details: files,
  };
}
