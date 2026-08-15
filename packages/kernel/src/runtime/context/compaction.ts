import { HarnessError } from "../core/errors.js";
import type { MessageId } from "../core/ids.js";
import type { CanonicalMessage, ContentBlock, ProviderId, ToolCallBlock } from "../core/types.js";
import {
  buildContextProjection,
  estimateContextTokens,
  estimateMessageTokens,
  type ContextGroup,
  type ContextProjection,
  type ContextUsageBaseline,
  type ProviderProjectionOptions,
} from "./projection.js";
import {
  deriveContextBudget,
} from "./budget.js";
import { isNormalizedUsage } from "../core/usage.js";
import { toolResultText } from "../providers/tool-results.js";

export interface CompactionOptions {
  provider: ProviderId;
  /** Hard model context window. */
  maxTokens: number;
  /** Published provider input-token ceiling, independent of maxTokens. */
  maxInputTokens?: number;
  /** Exact proactive threshold override. */
  triggerTokens?: number;
  /** Percentage-based proactive threshold used when triggerTokens is absent. */
  triggerPercent?: number;
  /** Explicit output requested for this call. */
  requestedMaxOutputTokens?: number;
  /** Tokens of recent history retained verbatim after compaction. */
  recentTokens?: number;
  /** Tokens reserved for the next model response and compaction summary. */
  reserveTokens?: number;
  retainRecentTurns?: number;
  maxSummaryTokens?: number;
  /** Legacy-named override for the summary-only tool-result text cap. */
  oldToolResultBytes?: number;
  model?: string;
  api?: ProviderProjectionOptions["api"];
  usageBaseline?: ContextUsageBaseline;
  additionalTokens?: number;
  outboundImages?: ProviderProjectionOptions["outboundImages"];
  supportsImages?: boolean;
}

export type CompactionReason = "threshold" | "overflow" | "manual";
export type CompactionBlockedReason =
  | "system_overflow"
  | "protected_recent_turns"
  | "pending_tools"
  | "unsplittable_turn"
  | "insufficient_reduction"
  | "nothing_to_compact";

export interface CompactionPlan {
  kind: "compact";
  provider: ProviderId;
  maxTokens: number;
  maxInputTokens: number;
  targetTokens: number;
  maxSummaryTokens: number;
  recentTokens: number;
  reserveTokens: number;
  additionalTokens: number;
  summaryToolResultCharacters: number;
  estimatedTokensBefore: number;
  estimatedTokensAfterUpperBound: number;
  reason: CompactionReason;
  splitTurn: boolean;
  leadingMessages: CanonicalMessage[];
  sourceMessages: CanonicalMessage[];
  trailingMessages: CanonicalMessage[];
  sourceMessageIds: MessageId[];
  previousSummary?: CanonicalMessage;
}

export type CompactionSelection =
  | {
      kind: "not_needed";
      projection: ContextProjection;
      reason: "within_threshold";
    }
  | {
      kind: "deferred";
      projection: ContextProjection;
      reason: CompactionBlockedReason;
      overflow: false;
    }
  | {
      kind: "cannot_compact";
      projection: ContextProjection;
      reason: CompactionBlockedReason;
      overflow: boolean;
    }
  | CompactionPlan;

export interface CompactionSummary {
  sourceMessageIds: MessageId[];
  message: CanonicalMessage;
  usage?: CanonicalMessage["usage"];
}

export interface ContextSummarizer {
  summarize(
    request: {
      provider: ProviderId;
      messages: readonly CanonicalMessage[];
      sourceMessageIds: readonly MessageId[];
      previousSummary?: CanonicalMessage;
      maxTokens: number;
    },
    signal: AbortSignal,
  ): Promise<CompactionSummary>;
}

interface PlannerSettings {
  maxTokens: number;
  maxInputTokens: number;
  targetTokens: number;
  maxSummaryTokens: number;
  recentTokens: number;
  reserveTokens: number;
  retainRecentTurns: number;
  summaryToolResultCharacters: number;
  additionalTokens: number;
}

function tokenSum(...values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function boundedTokenSum(...values: readonly number[]): number {
  return tokenSum(...values) ?? Number.MAX_SAFE_INTEGER;
}

function flatten(groups: readonly ContextGroup[]): CanonicalMessage[] {
  return groups.flatMap((group) => group.messages);
}

function protectedSystemMessages(groups: readonly ContextGroup[]): CanonicalMessage[] {
  const messages = flatten(groups.filter((group) => group.kind === "system"));
  const latestInstructionId = messages.findLast((message) => message.purpose === "instructions")?.id;
  return messages.filter((message) =>
    message.purpose !== "instructions" || message.id === latestInstructionId);
}

function settings(options: CompactionOptions): PlannerSettings {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new RangeError("maxTokens must be a positive safe integer");
  }
  const budget = deriveContextBudget({
    contextTokens: options.maxTokens,
    ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
  }, {
    ...(options.requestedMaxOutputTokens === undefined
      ? {}
      : { requestedMaxOutputTokens: options.requestedMaxOutputTokens }),
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(options.triggerPercent === undefined ? {} : { triggerPercent: options.triggerPercent }),
  });
  if (budget === undefined) throw new RangeError("maxTokens must resolve to a context budget");
  const requestedTargetTokens = options.triggerTokens ?? budget.compactAtTokens;
  if (
    !Number.isSafeInteger(requestedTargetTokens) ||
    requestedTargetTokens < 1 ||
    requestedTargetTokens > options.maxTokens
  ) {
    throw new RangeError("triggerTokens must be a positive safe integer no greater than maxTokens");
  }
  const targetTokens = Math.min(requestedTargetTokens, budget.maxInputTokens);
  const retainRecentTurns = options.retainRecentTurns ?? 2;
  if (!Number.isSafeInteger(retainRecentTurns) || retainRecentTurns < 1) {
    throw new RangeError("retainRecentTurns must be a positive safe integer");
  }
  if (options.recentTokens !== undefined && (!Number.isSafeInteger(options.recentTokens) || options.recentTokens < 1)) {
    throw new RangeError("recentTokens must be a positive safe integer");
  }
  const reserveTokens = budget.reservedOutputTokens;
  const recentTokens = options.recentTokens ?? Math.max(1, Math.floor(targetTokens * 0.2));
  const defaultSummary = Math.min(
    8_192,
    Math.max(1_024, Math.floor(options.maxTokens * 0.05)),
    Math.max(1, targetTokens - recentTokens - 1),
  );
  const maxSummaryTokens = options.maxSummaryTokens ?? defaultSummary;
  if (!Number.isSafeInteger(maxSummaryTokens) || maxSummaryTokens < 1) {
    throw new RangeError("maxSummaryTokens must be a positive safe integer");
  }
  const summaryToolResultCharacters = options.oldToolResultBytes ?? 2_000;
  if (!Number.isSafeInteger(summaryToolResultCharacters) || summaryToolResultCharacters < 64) {
    throw new RangeError("oldToolResultBytes must be an integer of at least 64");
  }
  const additionalTokens = options.additionalTokens ?? 0;
  if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 0) {
    throw new RangeError("additionalTokens must be a non-negative safe integer");
  }
  return {
    maxTokens: options.maxTokens,
    maxInputTokens: budget.maxInputTokens,
    targetTokens,
    maxSummaryTokens,
    recentTokens,
    reserveTokens,
    retainRecentTurns,
    summaryToolResultCharacters,
    additionalTokens,
  };
}

function truncateToolResultForSummary(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum)}\n\n[... ${text.length - maximum} more characters truncated]`;
}

/** Returns an isolated, bounded view used only by the summarization request. */
export function compactionSummaryInput(plan: CompactionPlan): CanonicalMessage[] {
  return plan.sourceMessages.map((message) => {
    let changed = false;
    const content = message.content.flatMap((block): ContentBlock[] => {
      if (
        block.type === "thinking" &&
        (block.visibility !== "summary" || block.redacted === true)
      ) {
        changed = true;
        return [];
      }
      if (block.type !== "tool_result") return [block];
      changed = true;
      return [{
        type: "tool_result",
        callId: block.callId,
        name: block.name,
        content: truncateToolResultForSummary(
          toolResultText(block),
          plan.summaryToolResultCharacters,
        ),
        isError: block.isError,
      }];
    });
    return changed ? { ...message, content } : message;
  });
}

function stripSummaryInput(messages: readonly CanonicalMessage[], previousSummary?: CanonicalMessage): CanonicalMessage[] {
  return messages
    .filter((message) => message !== previousSummary)
    .map((message) => ({
      ...message,
      content: message.content.filter((block) => block.type !== "provider_opaque"),
    }))
    .filter((message) => message.content.length > 0);
}

function makePlan(
  projection: ContextProjection,
  options: CompactionOptions,
  planner: PlannerSettings,
  reason: CompactionReason,
  leadingMessages: CanonicalMessage[],
  sourceMessages: CanonicalMessage[],
  trailingMessages: CanonicalMessage[],
  splitTurn: boolean,
): CompactionPlan | undefined {
  const retainedTokens = estimateContextTokens(
    [...leadingMessages, ...trailingMessages],
    { provider: options.provider, additionalTokens: planner.additionalTokens },
  );
  const estimatedTokensAfterUpperBound = tokenSum(retainedTokens, planner.maxSummaryTokens);
  if (estimatedTokensAfterUpperBound === undefined || estimatedTokensAfterUpperBound > planner.targetTokens) {
    return undefined;
  }
  const previousSummary = sourceMessages.findLast((message) => message.purpose === "compaction");
  return {
    kind: "compact",
    provider: options.provider,
    maxTokens: planner.maxTokens,
    maxInputTokens: planner.maxInputTokens,
    targetTokens: planner.targetTokens,
    maxSummaryTokens: planner.maxSummaryTokens,
    recentTokens: planner.recentTokens,
    reserveTokens: planner.reserveTokens,
    additionalTokens: planner.additionalTokens,
    summaryToolResultCharacters: planner.summaryToolResultCharacters,
    estimatedTokensBefore: projection.estimatedTokens,
    estimatedTokensAfterUpperBound,
    reason,
    splitTurn,
    leadingMessages,
    sourceMessages: stripSummaryInput(sourceMessages, previousSummary),
    trailingMessages,
    sourceMessageIds: sourceMessages.map((message) => message.id),
    ...(previousSummary === undefined ? {} : { previousSummary }),
  };
}

function safeToolBoundary(messages: readonly CanonicalMessage[], cut: number): boolean {
  const calls = new Map<string, { index: number; block: ToolCallBlock }>();
  const resultIndexes = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type === "tool_call") calls.set(block.callId, { index, block });
      else if (block.type === "tool_result") resultIndexes.set(block.callId, index);
    }
  });
  for (const [callId, call] of calls) {
    const resultIndex = resultIndexes.get(callId);
    if (resultIndex === undefined) {
      if (call.index < cut) return false;
    } else if ((call.index < cut) !== (resultIndex < cut)) {
      return false;
    }
  }
  return true;
}

interface RecentBoundary {
  sourceMessages: CanonicalMessage[];
  trailingMessages: CanonicalMessage[];
  splitTurn: boolean;
}

function validCutMessage(message: CanonicalMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

/**
 * Keep approximately the requested number of recent tokens while respecting
 * session-entry boundaries. A single oversized turn may be split before an
 * assistant message, but never between a tool call and its result.
 */
function recentBoundary(
  groups: readonly ContextGroup[],
  recentTokens: number,
  provider: ProviderId,
): RecentBoundary | undefined {
  let newerTokens = 0;
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = groups[groupIndex]!;
    const nextNewerTokens = boundedTokenSum(newerTokens, group.estimatedTokens);
    if (nextNewerTokens < recentTokens) {
      newerTokens = nextNewerTokens;
      continue;
    }

    const neededFromGroup = Math.max(1, recentTokens - newerTokens);
    const validCuts = group.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => validCutMessage(message) && safeToolBoundary(group.messages, index))
      .map(({ index }) => index);
    if (validCuts.length === 0) return undefined;

    let accumulated = 0;
    let cut = validCuts[0]!;
    for (let index = group.messages.length - 1; index >= 0; index -= 1) {
      accumulated = boundedTokenSum(accumulated, estimateMessageTokens(group.messages[index]!, provider));
      if (accumulated < neededFromGroup) continue;
      cut = validCuts.find((candidate) => candidate >= index) ?? validCuts.at(-1)!;
      break;
    }

    const earlier = flatten(groups.slice(0, groupIndex));
    const prefix = group.messages.slice(0, cut);
    const sourceMessages = [...earlier, ...prefix];
    if (sourceMessages.length === 0) return undefined;
    return {
      sourceMessages,
      trailingMessages: [
        ...group.messages.slice(cut),
        ...flatten(groups.slice(groupIndex + 1)),
      ],
      splitTurn: cut > 0,
    };
  }
  return undefined;
}

function turnBoundary(groups: readonly ContextGroup[], retainRecentTurns: number): RecentBoundary | undefined {
  const cut = groups.length - Math.min(groups.length, retainRecentTurns);
  if (cut <= 0) return undefined;
  return {
    sourceMessages: flatten(groups.slice(0, cut)),
    trailingMessages: flatten(groups.slice(cut)),
    splitTurn: false,
  };
}

function laterFittingBoundary(
  groups: readonly ContextGroup[],
  afterSourceMessages: number,
  options: CompactionOptions,
  planner: PlannerSettings,
  leadingMessages: readonly CanonicalMessage[],
): RecentBoundary | undefined {
  const messages = flatten(groups);
  const groupStarts = new Set<number>();
  const unsafeCutDelta = new Int32Array(messages.length + 1);
  let offset = 0;
  for (const group of groups) {
    groupStarts.add(offset);
    const calls = new Map<string, number>();
    const results = new Map<string, number>();
    group.messages.forEach((message, index) => {
      for (const block of message.content) {
        if (block.type === "tool_call") calls.set(block.callId, offset + index);
        else if (block.type === "tool_result") results.set(block.callId, offset + index);
      }
    });
    for (const [callId, callIndex] of calls) {
      const resultIndex = results.get(callId);
      const firstUnsafe = Math.min(callIndex, resultIndex ?? callIndex) + 1;
      const afterUnsafe = resultIndex === undefined
        ? messages.length
        : Math.max(callIndex, resultIndex) + 1;
      unsafeCutDelta[firstUnsafe] = (unsafeCutDelta[firstUnsafe] ?? 0) + 1;
      unsafeCutDelta[afterUnsafe] = (unsafeCutDelta[afterUnsafe] ?? 0) - 1;
    }
    offset += group.messages.length;
  }
  const suffixTokens = new Array<number>(messages.length + 1).fill(0);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] = boundedTokenSum(
      suffixTokens[index + 1]!,
      estimateMessageTokens(messages[index]!, options.provider),
    );
  }
  const leadingTokens = estimateContextTokens(leadingMessages, {
    provider: options.provider,
    additionalTokens: planner.additionalTokens,
  });
  let unsafeCuts = 0;
  const firstCandidate = Math.max(1, afterSourceMessages + 1);
  for (let cut = 1; cut < messages.length; cut += 1) {
    unsafeCuts += unsafeCutDelta[cut] ?? 0;
    if (cut < firstCandidate) continue;
    const firstKept = messages[cut];
    const estimatedTokensAfterUpperBound = tokenSum(
      leadingTokens,
      suffixTokens[cut]!,
      planner.maxSummaryTokens,
    );
    if (
      unsafeCuts !== 0 ||
      firstKept === undefined ||
      !validCutMessage(firstKept) ||
      estimatedTokensAfterUpperBound === undefined ||
      estimatedTokensAfterUpperBound > planner.targetTokens
    ) continue;
    return {
      sourceMessages: messages.slice(0, cut),
      trailingMessages: messages.slice(cut),
      splitTurn: !groupStarts.has(cut),
    };
  }
  return undefined;
}

function selectInternal(
  messages: readonly CanonicalMessage[],
  options: CompactionOptions,
  mode: "automatic" | "manual" | "overflow",
): CompactionSelection {
  const manual = mode === "manual";
  const forcedOverflow = mode === "overflow";
  const planner = settings(options);
  const projectionOptions = {
    ...(options.outboundImages === undefined ? {} : { outboundImages: options.outboundImages }),
    ...(options.supportsImages === undefined ? {} : { supportsImages: options.supportsImages }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.api === undefined ? {} : { api: options.api }),
    ...(options.usageBaseline === undefined ? {} : { usageBaseline: options.usageBaseline }),
    ...(planner.additionalTokens === 0 ? {} : { additionalTokens: planner.additionalTokens }),
  };
  const original = buildContextProjection(messages, options.provider, projectionOptions);
  if (mode === "automatic" && original.estimatedTokens <= planner.targetTokens) {
    return {
      kind: "not_needed",
      projection: original,
      reason: "within_threshold",
    };
  }

  const projection = original;

  const overflow = forcedOverflow || projection.estimatedTokens > planner.maxInputTokens;
  const reason: CompactionReason = manual ? "manual" : overflow ? "overflow" : "threshold";
  const leadingMessages = protectedSystemMessages(projection.groups);
  const turnGroups = projection.groups.filter((group) => group.kind !== "system");
  if (turnGroups.length === 0) {
    if (!overflow && !manual) {
      return { kind: "deferred", projection, reason: "nothing_to_compact", overflow: false };
    }
    return {
      kind: "cannot_compact",
      projection,
      reason: overflow ? "system_overflow" : "nothing_to_compact",
      overflow,
    };
  }

  const boundary = recentBoundary(turnGroups, planner.recentTokens, options.provider)
    ?? turnBoundary(turnGroups, planner.retainRecentTurns);
  if (boundary !== undefined) {
    const plan = makePlan(
      projection,
      options,
      planner,
      reason,
      leadingMessages,
      boundary.sourceMessages,
      boundary.trailingMessages,
      boundary.splitTurn,
    );
    if (plan !== undefined) return plan;
  }
  const laterBoundary = overflow
    ? laterFittingBoundary(
        turnGroups,
        boundary?.sourceMessages.length ?? 0,
        options,
        planner,
        leadingMessages,
      )
    : undefined;
  if (laterBoundary !== undefined) {
    const plan = makePlan(
      projection,
      options,
      planner,
      reason,
      leadingMessages,
      laterBoundary.sourceMessages,
      laterBoundary.trailingMessages,
      laterBoundary.splitTurn,
    );
    if (plan !== undefined) return plan;
  }

  const blockedReason: CompactionBlockedReason = boundary === undefined && laterBoundary === undefined
    ? (overflow ? "unsplittable_turn" : "nothing_to_compact")
    : "insufficient_reduction";

  if (!overflow && !manual) {
    return { kind: "deferred", projection, reason: blockedReason, overflow: false };
  }
  return {
    kind: "cannot_compact",
    projection,
    reason: manual && boundary === undefined ? "nothing_to_compact" : blockedReason,
    overflow,
  };
}

export function selectCompaction(
  messages: readonly CanonicalMessage[],
  options: CompactionOptions,
): CompactionSelection {
  return selectInternal(messages, options, "automatic");
}

export function selectManualCompaction(
  messages: readonly CanonicalMessage[],
  options: CompactionOptions,
): CompactionSelection {
  return selectInternal(messages, options, "manual");
}

export function selectOverflowCompaction(
  messages: readonly CanonicalMessage[],
  options: CompactionOptions,
): CompactionSelection {
  return selectInternal(messages, options, "overflow");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function applyCompaction(plan: CompactionPlan, summary: CompactionSummary): ContextProjection {
  if (!sameIds(plan.sourceMessageIds, summary.sourceMessageIds)) {
    throw new HarnessError("CONTEXT_SUMMARY_SOURCE", "Summary source IDs do not match the compaction plan");
  }
  if (
    summary.message.role !== "user" ||
    summary.message.content.length === 0 ||
    summary.message.content.some((block) => block.type !== "text")
  ) {
    throw new HarnessError("CONTEXT_SUMMARY_SHAPE", "Compaction summary must be a non-empty user text message");
  }
  if (
    plan.sourceMessageIds.includes(summary.message.id) ||
    [...plan.leadingMessages, ...plan.trailingMessages].some((message) => message.id === summary.message.id)
  ) {
    throw new HarnessError("CONTEXT_SUMMARY_ID", "Compaction summary message ID must be new");
  }
  if (summary.usage !== undefined && !isNormalizedUsage(summary.usage)) {
    throw new HarnessError("CONTEXT_SUMMARY_USAGE", "Compaction summary usage is invalid");
  }
  if (summary.message.usage !== undefined && !isNormalizedUsage(summary.message.usage)) {
    throw new HarnessError("CONTEXT_SUMMARY_USAGE", "Compaction summary message usage is invalid");
  }
  const summaryMessage = summary.usage === undefined
    ? summary.message
    : { ...summary.message, usage: structuredClone(summary.usage) };
  if (estimateMessageTokens(summaryMessage, plan.provider) > plan.maxSummaryTokens) {
    throw new HarnessError("CONTEXT_SUMMARY_LIMIT", "Compaction summary exceeds its token contract");
  }
  const projection = buildContextProjection(
    [...plan.leadingMessages, summaryMessage, ...plan.trailingMessages],
    plan.provider,
    plan.additionalTokens === 0 ? {} : { additionalTokens: plan.additionalTokens },
  );
  if (projection.estimatedTokens > plan.targetTokens) {
    throw new HarnessError("CONTEXT_SUMMARY_LIMIT", "Compacted context still exceeds its safety target");
  }
  return projection;
}

/** Rebuilds a validated plan around an extension-selected first retained message. */
export function rebaseCompactionPlan(plan: CompactionPlan, firstKeptMessageId: MessageId): CompactionPlan {
  const summarized = new Map<string, CanonicalMessage>();
  for (const message of plan.sourceMessages) summarized.set(message.id, message);
  if (plan.previousSummary !== undefined) summarized.set(plan.previousSummary.id, plan.previousSummary);
  const originalSource = plan.sourceMessageIds.map((id) => summarized.get(id));
  if (originalSource.some((message) => message === undefined)) {
    throw new HarnessError("CONTEXT_COMPACTION_BOUNDARY", "Compaction source messages cannot be reconstructed");
  }
  const compactable = [...(originalSource as CanonicalMessage[]), ...plan.trailingMessages];
  const cut = compactable.findIndex((message) => message.id === firstKeptMessageId);
  if (cut <= 0) {
    throw new HarnessError(
      "CONTEXT_COMPACTION_BOUNDARY",
      cut < 0 ? "Compaction retained message is not in the active context" : "Compaction must summarize at least one message",
    );
  }
  if (!safeToolBoundary(compactable, cut)) {
    throw new HarnessError("CONTEXT_COMPACTION_BOUNDARY", "Compaction cannot split a tool call from its result");
  }
  const source = compactable.slice(0, cut);
  const trailingMessages = compactable.slice(cut);
  const previousSummary = source.findLast((message) => message.purpose === "compaction");
  const retainedTokens = estimateContextTokens(
    [...plan.leadingMessages, ...trailingMessages],
    { provider: plan.provider, additionalTokens: plan.additionalTokens },
  );
  const estimatedTokensAfterUpperBound = tokenSum(retainedTokens, plan.maxSummaryTokens);
  if (estimatedTokensAfterUpperBound === undefined || estimatedTokensAfterUpperBound > plan.targetTokens) {
    throw new HarnessError(
      "CONTEXT_COMPACTION_BOUNDARY",
      "Rebased compaction context exceeds its safety target",
    );
  }
  const { previousSummary: _previousSummary, ...base } = plan;
  return {
    ...base,
    estimatedTokensAfterUpperBound,
    splitTurn: plan.splitTurn || firstKeptMessageId !== plan.trailingMessages[0]?.id,
    sourceMessages: stripSummaryInput(source, previousSummary),
    trailingMessages,
    sourceMessageIds: source.map((message) => message.id),
    ...(previousSummary === undefined ? {} : { previousSummary }),
  };
}

export async function compactWithSummarizer(
  plan: CompactionPlan,
  summarizer: ContextSummarizer,
  signal: AbortSignal,
): Promise<ContextProjection> {
  const summary = await summarizer.summarize(
    {
      provider: plan.provider,
      messages: compactionSummaryInput(plan),
      sourceMessageIds: plan.sourceMessageIds,
      ...(plan.previousSummary === undefined ? {} : { previousSummary: plan.previousSummary }),
      maxTokens: plan.maxSummaryTokens,
    },
    signal,
  );
  return applyCompaction(plan, summary);
}
