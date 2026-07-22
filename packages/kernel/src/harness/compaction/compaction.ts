import {
  contentText,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type RetryCallbacks,
  type RetryPolicy,
  retryAssistantCall,
  type SimpleStreamOptions,
  type Usage,
} from "@rigyn/models";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { convertToLlm, createBranchSummaryMessage, createCustomMessage } from "../messages.js";
import { buildSessionContext } from "../session/session.js";
import type { CompactionEntry, Result, SessionTreeEntry } from "../types.js";
import { CompactionError, err, ok } from "../types.js";
import { computeFileLists, createFileOps, extractFileOpsFromMessage, formatFileOperations, serializeConversation, type FileOperations } from "./utils.js";

export interface CompactionDetails { readFiles: string[]; modifiedFiles: string[]; }
export interface CompactionResult<T = unknown> { summary: string; firstKeptEntryId?: string; tokensBefore: number; usage?: Usage; retainedTail?: AgentMessage[]; details?: T; }
export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; }
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
export const calculateContextTokens = (usage: Usage): number => usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
function usageOf(message: AgentMessage): Usage | undefined { return message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error" && calculateContextTokens(message.usage) > 0 ? message.usage : undefined; }
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined { for (let index = entries.length - 1; index >= 0; index--) { const entry = entries[index]!; if (entry.type === "message") { const usage = usageOf(entry.message); if (usage) return usage; } } return undefined; }
export interface ContextUsageEstimate { tokens: number; usageTokens: number; trailingTokens: number; lastUsageIndex: number | null; }
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate { let last = -1; let usage: Usage | undefined; for (let index = messages.length - 1; index >= 0; index--) { usage = usageOf(messages[index]!); if (usage) { last = index; break; } } const usageTokens = usage ? calculateContextTokens(usage) : 0; const trailingTokens = messages.slice(last + 1).reduce((sum, message) => sum + estimateTokens(message), 0); return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: last < 0 ? null : last }; }
export const shouldCompact = (tokens: number, window: number, settings: CompactionSettings): boolean => settings.enabled && tokens > window - settings.reserveTokens;
export function completeSimpleWithRetries(models: Models, model: Model, context: Context, options: SimpleStreamOptions, retry?: RetryPolicy, callbacks?: RetryCallbacks): Promise<AssistantMessage> { return retryAssistantCall(() => models.completeSimple(model, context, options), retry, options.signal, callbacks); }
function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h === undefined && second.cacheWrite1h === undefined ? {} : { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }),
    ...(first.reasoning === undefined && second.reasoning === undefined ? {} : { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }),
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
function safe(value: unknown): string { try { return JSON.stringify(value) ?? "undefined"; } catch { return "[unserializable]"; } }
export function estimateTokens(message: AgentMessage): number { let chars = 0; if (message.role === "user" || message.role === "toolResult" || message.role === "custom") { const content = message.content; chars = typeof content === "string" ? content.length : content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 4800), 0); } else if (message.role === "assistant") for (const part of message.content) chars += part.type === "text" ? part.text.length : part.type === "thinking" ? part.thinking.length : part.name.length + safe(part.arguments).length; else if (message.role === "bashExecution") chars = message.command.length + message.output.length; else chars = message.summary.length; return Math.ceil(chars / 4); }
function cutCandidates(entries: SessionTreeEntry[], start: number, end: number): number[] { const result: number[] = []; for (let index = start; index < end; index++) { const entry = entries[index]!; if (entry.type === "branch_summary" || entry.type === "custom_message") result.push(index); else if (entry.type === "message" && entry.message.role !== "toolResult") result.push(index); } return result; }
export function findTurnStartIndex(entries: SessionTreeEntry[], entryIndex: number, startIndex: number): number { for (let index = entryIndex; index >= startIndex; index--) { const entry = entries[index]!; if (entry.type === "branch_summary" || entry.type === "custom_message" || entry.type === "message" && (entry.message.role === "user" || entry.message.role === "bashExecution")) return index; } return -1; }
export interface CutPointResult { firstKeptEntryIndex: number; turnStartIndex: number; isSplitTurn: boolean; }
export function findCutPoint(entries: SessionTreeEntry[], start: number, end: number, keep: number): CutPointResult { const candidates = cutCandidates(entries, start, end); if (!candidates.length) return { firstKeptEntryIndex: start, turnStartIndex: -1, isSplitTurn: false }; let chosen = candidates[0]!; let accumulated = 0; for (let index = end - 1; index >= start; index--) { const entry = entries[index]!; if (entry.type !== "message") continue; accumulated += estimateTokens(entry.message); if (accumulated >= keep) { chosen = candidates.find((candidate) => candidate >= index) ?? chosen; break; } } while (chosen > start && entries[chosen - 1]?.type !== "compaction" && entries[chosen - 1]?.type !== "message") chosen--; const entry = entries[chosen]!; const user = entry.type === "message" && entry.message.role === "user"; const turnStart = user ? -1 : findTurnStartIndex(entries, chosen, start); return { firstKeptEntryIndex: chosen, turnStartIndex: turnStart, isSplitTurn: !user && turnStart !== -1 }; }
export const SUMMARIZATION_SYSTEM_PROMPT = "Summarize the supplied conversation into a concise continuation checkpoint. Do not answer or continue the conversation.";
async function summarizeWithUsage(messages: AgentMessage[], models: Models, model: Model, reserveTokens: number, signal?: AbortSignal, instructions?: string, previous?: string, thinking?: ThinkingLevel, retry?: RetryPolicy, callbacks?: RetryCallbacks, fraction = 0.8): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
  const maxTokens = Math.min(Math.floor(fraction * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Infinity);
  const prompt = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${instructions ?? "Create a structured checkpoint with goal, constraints, completed work, current work, decisions, next steps, and critical context."}`;
  const completionOptions = { maxTokens, ...(signal === undefined ? {} : { signal }), ...(model.reasoning && thinking && thinking !== "off" ? { reasoning: thinking } : {}) };
  const response = await completeSimpleWithRetries(models, model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, completionOptions, retry, callbacks);
  if (response.stopReason === "aborted") return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
  if (response.stopReason === "error") return err(new CompactionError("summarization_failed", `Summarization failed: ${response.errorMessage || "Unknown error"}`));
  return ok({ text: contentText(response.content), usage: response.usage });
}
export function generateSummaryWithUsage(messages: AgentMessage[], models: Models, model: Model, reserveTokens: number, signal?: AbortSignal, customInstructions?: string, previousSummary?: string, thinkingLevel?: ThinkingLevel, retry?: RetryPolicy, callbacks?: RetryCallbacks): Promise<Result<{ text: string; usage: Usage }, CompactionError>> { return summarizeWithUsage(messages, models, model, reserveTokens, signal, customInstructions, previousSummary, thinkingLevel, retry, callbacks); }
export async function generateSummary(messages: AgentMessage[], models: Models, model: Model, reserveTokens: number, signal?: AbortSignal, customInstructions?: string, previousSummary?: string, thinkingLevel?: ThinkingLevel, retry?: RetryPolicy, callbacks?: RetryCallbacks): Promise<Result<string, CompactionError>> { const result = await generateSummaryWithUsage(messages, models, model, reserveTokens, signal, customInstructions, previousSummary, thinkingLevel, retry, callbacks); return result.ok ? ok(result.value.text) : err(result.error); }
function messageFrom(entry: SessionTreeEntry): AgentMessage | undefined { if (entry.type === "message") return entry.message; if (entry.type === "custom_message") return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp); if (entry.type === "branch_summary") return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp); return undefined; }
export interface CompactionPreparation { firstKeptEntryId: string; messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[]; retainedTail: AgentMessage[]; isSplitTurn: boolean; tokensBefore: number; previousSummary?: string; fileOps: FileOperations; settings: CompactionSettings; }
export function prepareCompaction(entries: SessionTreeEntry[], settings: CompactionSettings): Result<CompactionPreparation | undefined, CompactionError> {
  if (!entries.length || entries.at(-1)?.type === "compaction") return ok(undefined);
  let previousIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index]?.type === "compaction") { previousIndex = index; break; }
  const previous = previousIndex >= 0 ? entries[previousIndex] as CompactionEntry : undefined;
  let candidates = entries;
  let start = 0;
  if (previous?.retainedTail !== undefined) {
    const retainedEntries: SessionTreeEntry[] = previous.retainedTail.map((message) => ({ type: "message", id: previous.id, parentId: previous.parentId, timestamp: previous.timestamp, message }));
    candidates = [...retainedEntries, ...entries.slice(previousIndex + 1)];
  } else if (previous) {
    const foundBoundary = previous.firstKeptEntryId ? entries.findIndex((entry) => entry.id === previous.firstKeptEntryId) : -1;
    start = foundBoundary >= 0 ? foundBoundary : previousIndex + 1;
  }
  const cut = findCutPoint(candidates, start, candidates.length, settings.keepRecentTokens);
  const kept = candidates[cut.firstKeptEntryIndex];
  if (!kept?.id) return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize = candidates.slice(start, historyEnd).flatMap((entry) => { const message = messageFrom(entry); return message ? [message] : []; });
  const turnPrefixMessages = cut.isSplitTurn ? candidates.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).flatMap((entry) => { const message = messageFrom(entry); return message ? [message] : []; }) : [];
  const retainedTail = candidates.slice(cut.firstKeptEntryIndex).flatMap((entry) => { const message = messageFrom(entry); return message ? [message] : []; });
  const fileOps = createFileOps();
  if (previous && !previous.fromHook && previous.details) {
    const details = previous.details as CompactionDetails;
    for (const path of details.readFiles ?? []) fileOps.read.add(path);
    for (const path of details.modifiedFiles ?? []) fileOps.edited.add(path);
  }
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) extractFileOpsFromMessage(message, fileOps);
  return ok({ firstKeptEntryId: kept.id, messagesToSummarize, turnPrefixMessages, retainedTail, isSplitTurn: cut.isSplitTurn, tokensBefore: estimateContextTokens(buildSessionContext(entries).messages).tokens, ...(previous ? { previousSummary: previous.summary } : {}), fileOps, settings });
}
export async function compact(preparation: CompactionPreparation, models: Models, model: Model, customInstructions?: string, signal?: AbortSignal, thinkingLevel?: ThinkingLevel, retry?: RetryPolicy, callbacks?: RetryCallbacks): Promise<Result<CompactionResult, CompactionError>> {
  if (!preparation.firstKeptEntryId) return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
  let summary: string;
  let usage: Usage;
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length) {
    let historyText = "No prior history.";
    let historyUsage: Usage | undefined;
    if (preparation.messagesToSummarize.length) {
      const history = await generateSummaryWithUsage(preparation.messagesToSummarize, models, model, preparation.settings.reserveTokens, signal, customInstructions, preparation.previousSummary, thinkingLevel, retry, callbacks);
      if (!history.ok) return history;
      historyText = history.value.text;
      historyUsage = history.value.usage;
    }
    const prefix = await summarizeWithUsage(preparation.turnPrefixMessages, models, model, preparation.settings.reserveTokens, signal, "Summarize the retained turn prefix so its later suffix remains understandable.", undefined, thinkingLevel, retry, callbacks, 0.5);
    if (!prefix.ok) return prefix;
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.value.text}`;
    usage = historyUsage ? combineUsage(historyUsage, prefix.value.usage) : prefix.value.usage;
  } else {
    const generated = await generateSummaryWithUsage(preparation.messagesToSummarize, models, model, preparation.settings.reserveTokens, signal, customInstructions, preparation.previousSummary, thinkingLevel, retry, callbacks);
    if (!generated.ok) return generated;
    summary = generated.value.text;
    usage = generated.value.usage;
  }
  const files = computeFileLists(preparation.fileOps);
  summary += formatFileOperations(files.readFiles, files.modifiedFiles);
  return ok({ summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, usage, retainedTail: preparation.retainedTail, details: files });
}
export { serializeConversation } from "./utils.js";
