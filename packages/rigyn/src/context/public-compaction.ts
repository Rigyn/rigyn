import {
  convertToLlm as projectMessagesForProvider,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  type AgentMessage,
  type StreamFn,
  type ThinkingLevel,
} from "@rigyn/kernel";
import {
  contentText,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@rigyn/models";
import { completeSimple } from "@rigyn/models/compat";

import type {
  ReadonlyExtensionSessionManager,
  SessionEntry,
} from "../extensions/session-contract.js";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
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
  messages: AgentMessage[];
  fileOps: FileOperations;
  totalTokens: number;
}

export interface CollectEntriesResult {
  entries: SessionEntry[];
  commonAncestorId: string | null;
}

export interface BranchSummaryResult {
  summary?: string;
  usage?: Usage;
  readFiles?: string[];
  modifiedFiles?: string[];
  aborted?: boolean;
  error?: string;
}

export interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface GenerateBranchSummaryOptions {
  model: Model;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  signal: AbortSignal;
  customInstructions?: string;
  replaceInstructions?: boolean;
  reserveTokens?: number;
  streamFn?: StreamFn;
}

export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string | undefined;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: Usage;
  details?: T;
}

export type ReadonlyCompactionSessionManager = Pick<
  ReadonlyExtensionSessionManager,
  "getBranch" | "getEntry"
>;

const ESTIMATED_IMAGE_CHARS = 4_800;
const TOOL_RESULT_MAX_CHARS = 2_000;

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
  if (entry.type === "message") {
    const message = entry.message as AgentMessage & { content?: unknown };
    if (
      (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
      && message.content == null
    ) {
      return [{ ...message, content: [] } as AgentMessage];
    }
    return [message];
  }
  if (entry.type === "custom_message") {
    return [createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)];
  }
  if (entry.type === "branch_summary" && entry.summary !== "") {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  }
  if (entry.type === "compaction") {
    return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
  }
  return [];
}

function compactionMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "compaction") return undefined;
  return entryMessages(entry)[0];
}

function branchMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "branch_summary") {
    return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
  }
  return entryMessages(entry)[0];
}

interface BranchCandidate {
  entry: SessionEntry;
  message: AgentMessage;
  tokens: number;
  bytes: number;
}

function completeToolPairCandidates(entries: SessionEntry[]): BranchCandidate[] {
  const raw = entries.flatMap((entry) => {
    const message = branchMessage(entry);
    return message === undefined ? [] : [{ entry, message }];
  });
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const { message } of raw) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.add(block.id);
      }
    } else if (message.role === "toolResult") results.add(message.toolCallId);
  }
  const complete = new Set([...calls].filter((id) => results.has(id)));
  return raw.flatMap(({ entry, message }) => {
    let selected = message;
    if (message.role === "assistant") {
      const content = message.content.filter((block) => block.type !== "toolCall" || complete.has(block.id));
      if (content.length === 0) return [];
      selected = content.length === message.content.length ? message : { ...message, content };
    } else if (message.role === "toolResult" && !complete.has(message.toolCallId)) return [];
    const text = serializeConversation(convertToLlm([selected]));
    return [{
      entry,
      message: selected,
      tokens: estimateTokens(selected),
      bytes: Buffer.byteLength(text, "utf8"),
    }];
  });
}

function toolSafeStarts(candidates: readonly BranchCandidate[]): boolean[] {
  const ranges = new Map<string, { first: number; last: number }>();
  candidates.forEach((candidate, index) => {
    const message = candidate.message;
    const ids = message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : message.role === "toolResult" ? [message.toolCallId] : [];
    for (const id of ids) {
      const prior = ranges.get(id);
      ranges.set(id, {
        first: Math.min(prior?.first ?? index, index),
        last: Math.max(prior?.last ?? index, index),
      });
    }
  });
  const changes = Array.from({ length: candidates.length + 2 }, () => 0);
  for (const range of ranges.values()) {
    if (range.first === range.last) continue;
    changes[range.first + 1] = (changes[range.first + 1] ?? 0) + 1;
    changes[range.last + 1] = (changes[range.last + 1] ?? 0) - 1;
  }
  const safe = Array.from({ length: candidates.length + 1 }, () => true);
  let open = 0;
  for (let index = 0; index <= candidates.length; index += 1) {
    open += changes[index] ?? 0;
    safe[index] = open === 0;
  }
  return safe;
}

function estimateContentChars(content: string | readonly { type: string; text?: string }[]): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

function serializedLength(value: unknown): number {
  return (JSON.stringify(value) ?? "").length;
}

export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
    chars = estimateContentChars(message.content);
  } else if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "thinking") chars += block.thinking.length;
      else chars += block.name.length + serializedLength(block.arguments);
    }
  } else if (message.role === "bashExecution") {
    chars = message.command.length + message.output.length;
  } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
    chars = message.summary.length;
  }
  return Math.ceil(chars / 4);
}

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function assistantUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  return calculateContextTokens(message.usage) > 0 ? message.usage : undefined;
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
  const usageTokens = usage === undefined ? 0 : calculateContextTokens(usage);
  const trailingStart = lastUsageIndex + 1;
  const trailingTokens = messages
    .slice(trailingStart)
    .reduce((total, message) => total + estimateTokens(message), 0);
  return {
    tokens: usageTokens + trailingTokens,
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
  return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
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

function validCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
  const points: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.type !== "compaction" && entryMessages(entry).some(isCutPointMessage)) {
      points.push(index);
    }
  }
  return points;
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
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = validCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let firstKeptEntryIndex = cutPoints[0]!;
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const tokens = entryMessages(entry).reduce((total, message) => total + estimateTokens(message), 0);
    if (tokens === 0) continue;
    accumulatedTokens += tokens;
    if (accumulatedTokens < keepRecentTokens) continue;
    firstKeptEntryIndex = cutPoints.find((candidate) => candidate >= index) ?? firstKeptEntryIndex;
    break;
  }

  while (firstKeptEntryIndex > startIndex) {
    const previous = entries[firstKeptEntryIndex - 1];
    if (previous === undefined || previous.type === "compaction" || entryMessages(previous).length > 0) break;
    firstKeptEntryIndex -= 1;
  }

  const selected = entries[firstKeptEntryIndex];
  const startsTurn = selected !== undefined && isTurnStartEntry(selected);
  const turnStartIndex = startsTurn
    ? -1
    : findTurnStartIndex(entries, firstKeptEntryIndex, startIndex);
  return {
    firstKeptEntryIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") return;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const path = typeof block.arguments.path === "string" ? block.arguments.path : undefined;
    if (path === undefined || path === "") continue;
    if (block.name === "read") fileOps.read.add(path);
    else if (block.name === "write") fileOps.written.add(path);
    else if (block.name === "edit") fileOps.edited.add(path);
  }
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
      calls.set(block.id, { name: block.name, path: block.arguments.path });
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
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

export function prepareBranchEntries(entries: SessionEntry[], tokenBudget?: number): BranchPreparation {
  const requestedTokenBudget = tokenBudget === undefined ? undefined : Math.floor(tokenBudget);
  if (requestedTokenBudget !== undefined && (!Number.isFinite(requestedTokenBudget) || requestedTokenBudget <= 0)) {
    return { messages: [], fileOps: createFileOps(), totalTokens: 0 };
  }
  const candidates = completeToolPairCandidates(entries);
  const safeStarts = toolSafeStarts(candidates);
  const effectiveTokenBudget = Math.min(
    BRANCH_PREPARATION_LIMITS.maxContextTokens,
    requestedTokenBudget ?? BRANCH_PREPARATION_LIMITS.maxContextTokens,
  );
  let selectedStart = candidates.length;
  let totalBytes = 0;
  let totalTokens = 0;
  let selectedCount = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const separatorBytes = selectedCount === 0 ? 0 : 2;
    if (
      totalTokens + candidate.tokens > effectiveTokenBudget ||
      totalBytes + separatorBytes + candidate.bytes > BRANCH_PREPARATION_LIMITS.maxContextBytes
    ) break;
    totalTokens += candidate.tokens;
    totalBytes += separatorBytes + candidate.bytes;
    selectedCount += 1;
    if (safeStarts[index] === true) selectedStart = index;
  }
  if (candidates.length > 0 && selectedStart === candidates.length) {
    throw new Error("The newest complete message or tool pair cannot fit the branch summary context bounds");
  }
  const selected = candidates.slice(selectedStart);
  const messages = selected.map((candidate) => candidate.message);
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
  totalTokens = selected.reduce((total, candidate) => total + candidate.tokens, 0);
  return { messages, fileOps, totalTokens };
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

function truncateForSummary(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const omitted = text.length - TOOL_RESULT_MAX_CHARS;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${omitted} more characters truncated]`;
}

export function serializeConversation(messages: Message[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentText(message.content, "");
      if (text !== "") sections.push(`[User]: ${text}`);
      continue;
    }
    if (message.role === "toolResult") {
      const text = contentText(message.content, "");
      if (text !== "") sections.push(`[Tool result]: ${truncateForSummary(text)}`);
      continue;
    }

    const thinking: string[] = [];
    const calls: string[] = [];
    for (const block of message.content) {
      if (block.type === "thinking") thinking.push(block.thinking);
      else if (block.type === "toolCall") {
        const argumentsText = Object.entries(block.arguments)
          .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
          .join(", ");
        calls.push(`${block.name}(${argumentsText})`);
      }
    }
    if (thinking.length > 0) sections.push(`[Assistant thinking]: ${thinking.join("\n")}`);
    if (message.content.some((block) => block.type === "text")) {
      sections.push(`[Assistant]: ${contentText(message.content)}`);
    }
    if (calls.length > 0) sections.push(`[Assistant tool calls]: ${calls.join("; ")}`);
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
  model: Model,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
  return {
    maxTokens,
    apiKey,
    headers,
    env,
    signal,
    ...(model.reasoning && thinkingLevel !== undefined && thinkingLevel !== "off"
      ? { reasoning: thinkingLevel }
      : {}),
  } as SimpleStreamOptions;
}

async function completeSummarization(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  if (streamFn === undefined) return await completeSimple(model, context, options);
  const stream = await streamFn(model, context, options);
  return await stream.result();
}

export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  env?: Record<string, string>,
): Promise<string> {
  return (await generateSummaryWithUsage(
    currentMessages,
    model,
    reserveTokens,
    apiKey,
    headers,
    signal,
    customInstructions,
    previousSummary,
    thinkingLevel,
    streamFn,
    env,
  )).text;
}

export async function generateSummaryWithUsage(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  env?: Record<string, string>,
): Promise<{ text: string; usage: Usage }> {
  const maxTokens = Math.min(
    Math.floor(reserveTokens * 0.8),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let instructions = previousSummary
    ? UPDATED_SUMMARY_INSTRUCTIONS
    : NEW_SUMMARY_INSTRUCTIONS;
  if (customInstructions) {
    instructions += `\n\nAdditional focus: ${customInstructions}`;
  }
  const conversation = serializeConversation(convertToLlm(currentMessages));
  const previous = previousSummary
    ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
    : "";
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\n${previous}${instructions}`;
  const response = await completeSummarization(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    },
    requestOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel),
    streamFn,
  );
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return { text: contentText(response.content), usage: response.usage };
}

export async function generateBranchSummary(
  entries: SessionEntry[],
  options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
  const contextWindow = Math.floor(options.model.contextWindow);
  const outputTokens = Math.min(2_048, Math.floor(options.model.maxTokens));
  const reserveTokens = Math.max(0, Math.floor(options.reserveTokens ?? 16_384));
  const inputTokenBudget = contextWindow - outputTokens - reserveTokens;
  if (
    !Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(reserveTokens) || !Number.isSafeInteger(inputTokenBudget) ||
    contextWindow <= 0 || outputTokens <= 0 || inputTokenBudget <= 0
  ) {
    return { error: "The selected model does not leave a positive input budget for branch summarization" };
  }
  const prepared = prepareBranchEntries(entries, inputTokenBudget);
  if (prepared.messages.length === 0) return { summary: "No content to summarize" };

  let instructions = BRANCH_SUMMARY_INSTRUCTIONS;
  if (options.replaceInstructions && options.customInstructions) instructions = options.customInstructions;
  else if (options.customInstructions) instructions += `\n\nAdditional focus: ${options.customInstructions}`;
  const prompt = `<conversation>\n${serializeConversation(convertToLlm(prepared.messages))}\n</conversation>\n\n${instructions}`;
  const request = {
    apiKey: options.apiKey,
    headers: options.headers,
    env: options.env,
    signal: options.signal,
    maxTokens: outputTokens,
  } as SimpleStreamOptions;
  const response = await completeSummarization(
    options.model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    },
    request,
    options.streamFn,
  );
  if (response.stopReason === "aborted") return { aborted: true };
  if (response.stopReason === "error") {
    return { error: response.errorMessage || "Summarization failed" };
  }

  const files = computeFileLists(prepared.fileOps);
  const generated = contentText(response.content);
  const summary = `A prior conversation branch was explored and then left.\nContinuation context from that branch:\n\n${generated}`
    + formatFileOperations(files.readFiles, files.modifiedFiles);
  return {
    summary: summary || "No summary generated",
    usage: response.usage,
    ...files,
  };
}

function buildCompactionContext(entries: SessionEntry[]): AgentMessage[] {
  let latestCompactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      latestCompactionIndex = index;
      break;
    }
  }
  if (latestCompactionIndex < 0) return entries.flatMap(entryMessages);
  const compaction = entries[latestCompactionIndex];
  if (compaction?.type !== "compaction") return entries.flatMap(entryMessages);
  const firstKeptIndex = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const kept = firstKeptIndex >= 0 && firstKeptIndex < latestCompactionIndex
    ? entries.slice(firstKeptIndex, latestCompactionIndex)
    : [];
  return [compaction, ...kept, ...entries.slice(latestCompactionIndex + 1)].flatMap(entryMessages);
}

function previousFileOperations(entries: SessionEntry[], previousCompactionIndex: number): FileOperations {
  const operations = createFileOps();
  if (previousCompactionIndex < 0) return operations;
  const previous = entries[previousCompactionIndex];
  if (previous?.type !== "compaction" || previous.fromHook || previous.details === undefined) return operations;
  const details = previous.details as Partial<CompactionDetails>;
  if (Array.isArray(details.readFiles)) {
    for (const path of details.readFiles) operations.read.add(path);
  }
  if (Array.isArray(details.modifiedFiles)) {
    for (const path of details.modifiedFiles) operations.edited.add(path);
  }
  return operations;
}

export function prepareCompaction(
  entries: SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  if (entries.at(-1)?.type === "compaction") return undefined;

  let previousCompactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      previousCompactionIndex = index;
      break;
    }
  }
  const previous = previousCompactionIndex < 0 ? undefined : entries[previousCompactionIndex];
  const previousCompaction = previous?.type === "compaction" ? previous : undefined;
  const previousBoundary = previousCompaction === undefined
    ? -1
    : entries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId);
  const startIndex = previousCompaction === undefined
    ? 0
    : previousBoundary >= 0 ? previousBoundary : previousCompactionIndex + 1;
  const cut = findCutPoint(entries, startIndex, entries.length, settings.keepRecentTokens);
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (firstKept?.id === undefined) return undefined;

  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize = entries
    .slice(startIndex, historyEnd)
    .flatMap((entry) => {
      const message = compactionMessage(entry);
      return message === undefined ? [] : [message];
    });
  const turnPrefixMessages = cut.isSplitTurn
    ? entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).flatMap((entry) => {
        const message = compactionMessage(entry);
        return message === undefined ? [] : [message];
      })
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

  const fileOps = previousFileOperations(entries, previousCompactionIndex);
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
    extractFileOpsFromMessage(message, fileOps);
  }
  return {
    firstKeptEntryId: firstKept.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cut.isSplitTurn,
    tokensBefore: estimateContextTokens(buildCompactionContext(entries)).tokens,
    previousSummary: previousCompaction?.summary,
    fileOps,
    settings,
  };
}

function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h === undefined && second.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }),
    ...(first.reasoning === undefined && second.reasoning === undefined
      ? {}
      : { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  streamFn: StreamFn | undefined,
): Promise<{ text: string; usage: Usage }> {
  const maxTokens = Math.min(
    Math.floor(reserveTokens * 0.5),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const prompt = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${TURN_PREFIX_INSTRUCTIONS}`;
  const response = await completeSummarization(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    },
    requestOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel),
    streamFn,
  );
  if (response.stopReason === "error") {
    throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return { text: contentText(response.content), usage: response.usage };
}

export async function compact(
  preparation: CompactionPreparation,
  model: Model,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  env?: Record<string, string>,
): Promise<CompactionResult> {
  let summary: string;
  let usage: Usage;
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    let historyText = "No prior history.";
    let historyUsage: Usage | undefined;
    if (preparation.messagesToSummarize.length > 0) {
      const generated = await generateSummaryWithUsage(
        preparation.messagesToSummarize,
        model,
        preparation.settings.reserveTokens,
        apiKey,
        headers,
        signal,
        customInstructions,
        preparation.previousSummary,
        thinkingLevel,
        streamFn,
        env,
      );
      historyText = generated.text;
      historyUsage = generated.usage;
    }
    const prefix = await generateTurnPrefixSummary(
      preparation.turnPrefixMessages,
      model,
      preparation.settings.reserveTokens,
      apiKey,
      headers,
      env,
      signal,
      thinkingLevel,
      streamFn,
    );
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = historyUsage === undefined ? prefix.usage : combineUsage(historyUsage, prefix.usage);
  } else {
    const generated = await generateSummaryWithUsage(
      preparation.messagesToSummarize,
      model,
      preparation.settings.reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      preparation.previousSummary,
      thinkingLevel,
      streamFn,
      env,
    );
    summary = generated.text;
    usage = generated.usage;
  }

  const files = computeFileLists(preparation.fileOps);
  summary += formatFileOperations(files.readFiles, files.modifiedFiles);
  if (preparation.firstKeptEntryId === "") {
    throw new Error("First kept entry has no UUID - session may need migration");
  }
  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage,
    details: files,
  };
}
