import { HarnessError } from "../core/errors.js";
import type { MessageId } from "../core/ids.js";
import type { CanonicalMessage, ProviderId, ToolCallBlock } from "../core/types.js";
import {
  buildContextProjection,
  elideOldToolResults,
  estimateContextTokens,
  estimateMessageTokens,
  type ContextGroup,
  type ContextProjection,
  type ContextUsageBaseline,
  type ProviderProjectionOptions,
} from "./projection.js";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_OUTPUT_RESERVE_TOKENS } from "./budget.js";

export interface CompactionOptions {
  provider: ProviderId;
  /** Hard input ceiling after reserving output tokens. */
  maxTokens: number;
  /** Proactive compaction threshold. Defaults to the hard ceiling. */
  triggerTokens?: number;
  /** Tokens of recent history retained verbatim after compaction. */
  keepRecentTokens?: number;
  /** Tokens reserved for the next model response and compaction summary. */
  reserveTokens?: number;
  retainRecentTurns?: number;
  maxSummaryTokens?: number;
  oldToolResultBytes?: number;
  model?: string;
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
  targetTokens: number;
  maxSummaryTokens: number;
  keepRecentTokens: number;
  reserveTokens: number;
  additionalTokens: number;
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
      reason: "within_threshold" | "tool_results_elided";
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
  targetTokens: number;
  maxSummaryTokens: number;
  keepRecentTokens: number;
  reserveTokens: number;
  retainRecentTurns: number;
  oldToolResultBytes: number;
  additionalTokens: number;
}

function flatten(groups: readonly ContextGroup[]): CanonicalMessage[] {
  return groups.flatMap((group) => group.messages);
}

function settings(options: CompactionOptions): PlannerSettings {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new RangeError("maxTokens must be a positive safe integer");
  }
  const targetTokens = options.triggerTokens ?? options.maxTokens;
  if (!Number.isSafeInteger(targetTokens) || targetTokens < 1 || targetTokens > options.maxTokens) {
    throw new RangeError("triggerTokens must be a positive safe integer no greater than maxTokens");
  }
  const retainRecentTurns = options.retainRecentTurns ?? 2;
  if (!Number.isSafeInteger(retainRecentTurns) || retainRecentTurns < 0) {
    throw new RangeError("retainRecentTurns must be a non-negative safe integer");
  }
  const reserveTokens = options.reserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 1) {
    throw new RangeError("reserveTokens must be a positive safe integer");
  }
  const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1) {
    throw new RangeError("keepRecentTokens must be a positive safe integer");
  }
  const defaultSummary = Math.min(
    Math.floor(reserveTokens * 0.8),
    Math.max(1, targetTokens - 1),
  );
  const maxSummaryTokens = options.maxSummaryTokens ?? defaultSummary;
  if (!Number.isSafeInteger(maxSummaryTokens) || maxSummaryTokens < 1) {
    throw new RangeError("maxSummaryTokens must be a positive safe integer");
  }
  const oldToolResultBytes = options.oldToolResultBytes ?? 4 * 1_024;
  if (!Number.isSafeInteger(oldToolResultBytes) || oldToolResultBytes < 64) {
    throw new RangeError("oldToolResultBytes must be an integer of at least 64");
  }
  const additionalTokens = options.additionalTokens ?? 0;
  if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 0) {
    throw new RangeError("additionalTokens must be a non-negative safe integer");
  }
  return {
    maxTokens: options.maxTokens,
    targetTokens,
    maxSummaryTokens,
    keepRecentTokens,
    reserveTokens,
    retainRecentTurns,
    oldToolResultBytes,
    additionalTokens,
  };
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
  const estimatedTokensAfterUpperBound = retainedTokens + planner.maxSummaryTokens;
  if (estimatedTokensAfterUpperBound > planner.targetTokens) return undefined;
  const previousSummary = sourceMessages.findLast((message) => message.purpose === "compaction");
  return {
    kind: "compact",
    provider: options.provider,
    maxTokens: planner.maxTokens,
    targetTokens: planner.targetTokens,
    maxSummaryTokens: planner.maxSummaryTokens,
    keepRecentTokens: planner.keepRecentTokens,
    reserveTokens: planner.reserveTokens,
    additionalTokens: planner.additionalTokens,
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
  keepRecentTokens: number,
  provider: ProviderId,
): RecentBoundary | undefined {
  let newerTokens = 0;
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = groups[groupIndex]!;
    if (newerTokens + group.estimatedTokens < keepRecentTokens) {
      newerTokens += group.estimatedTokens;
      continue;
    }

    const neededFromGroup = Math.max(1, keepRecentTokens - newerTokens);
    const validCuts = group.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => validCutMessage(message) && safeToolBoundary(group.messages, index))
      .map(({ index }) => index);
    if (validCuts.length === 0) return undefined;

    let accumulated = 0;
    let cut = validCuts[0]!;
    for (let index = group.messages.length - 1; index >= 0; index -= 1) {
      accumulated += estimateMessageTokens(group.messages[index]!, provider);
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
    ...(options.usageBaseline === undefined ? {} : { usageBaseline: options.usageBaseline }),
    ...(planner.additionalTokens === 0 ? {} : { additionalTokens: planner.additionalTokens }),
  };
  const derivedMessages = elideOldToolResults(messages, {
    retainRecentTurns: planner.retainRecentTurns,
    maxResultBytes: planner.oldToolResultBytes,
  });
  const original = buildContextProjection(derivedMessages, options.provider, projectionOptions);
  if (mode === "automatic" && original.estimatedTokens <= planner.targetTokens) {
    return { kind: "not_needed", projection: original, reason: "within_threshold" };
  }

  const projection = original;

  const overflow = forcedOverflow || projection.estimatedTokens > planner.maxTokens;
  const reason: CompactionReason = manual ? "manual" : overflow ? "overflow" : "threshold";
  let firstTurn = 0;
  while (firstTurn < projection.groups.length && projection.groups[firstTurn]?.kind === "system") firstTurn += 1;
  const leadingMessages = flatten(projection.groups.slice(0, firstTurn));
  if (firstTurn === projection.groups.length) {
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

  const turnGroups = projection.groups.slice(firstTurn).filter((group) => group.kind !== "system");
  const boundary = recentBoundary(turnGroups, planner.keepRecentTokens, options.provider)
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

  const blockedReason: CompactionBlockedReason = boundary === undefined
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
  if (estimateMessageTokens(summary.message, plan.provider) > plan.maxSummaryTokens) {
    throw new HarnessError("CONTEXT_SUMMARY_LIMIT", "Compaction summary exceeds its token contract");
  }
  const projection = buildContextProjection(
    [...plan.leadingMessages, summary.message, ...plan.trailingMessages],
    plan.provider,
    plan.additionalTokens === 0 ? {} : { additionalTokens: plan.additionalTokens },
  );
  if (projection.estimatedTokens > plan.targetTokens) {
    throw new HarnessError("CONTEXT_SUMMARY_LIMIT", "Compacted context still exceeds its safety target");
  }
  return projection;
}

export async function compactWithSummarizer(
  plan: CompactionPlan,
  summarizer: ContextSummarizer,
  signal: AbortSignal,
): Promise<ContextProjection> {
  const summary = await summarizer.summarize(
    {
      provider: plan.provider,
      messages: plan.sourceMessages,
      sourceMessageIds: plan.sourceMessageIds,
      ...(plan.previousSummary === undefined ? {} : { previousSummary: plan.previousSummary }),
      maxTokens: plan.maxSummaryTokens,
    },
    signal,
  );
  return applyCompaction(plan, summary);
}
