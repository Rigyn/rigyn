import type { EventEnvelope } from "../core/events.js";
import type { NormalizedUsage } from "../core/types.js";
import { analyzeCacheEffectiveness } from "../core/cache-diagnostics.js";
import type { RunRecord, ThreadRecord } from "../storage/types.js";

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof NormalizedUsage)[];

function addUsage(left: NormalizedUsage | undefined, right: NormalizedUsage): NormalizedUsage {
  const result: NormalizedUsage = {};
  for (const field of USAGE_FIELDS) {
    const first = left?.[field];
    const second = right[field];
    if (first !== undefined || second !== undefined) result[field] = (first ?? 0) + (second ?? 0);
  }
  const firstCost = left?.cost === undefined ? undefined : Number(left.cost);
  const secondCost = right.cost === undefined ? undefined : Number(right.cost);
  if ((firstCost !== undefined && Number.isFinite(firstCost)) || (secondCost !== undefined && Number.isFinite(secondCost))) {
    result.cost = String((Number.isFinite(firstCost) ? firstCost! : 0) + (Number.isFinite(secondCost) ? secondCost! : 0));
  }
  return result;
}

function sessionUsages(events: readonly EventEnvelope[]): NormalizedUsage[] {
  const byRun = new Map<string, NormalizedUsage>();
  for (const envelope of events) {
    if (envelope.event.type !== "usage") continue;
    const key = envelope.runId ?? `${envelope.threadId}:unscoped`;
    const prior = byRun.get(key);
    byRun.set(key, envelope.event.semantics === "incremental"
      ? addUsage(prior, envelope.event.usage)
      : { ...envelope.event.usage });
  }
  return [...byRun.values()];
}

function sessionUsage(usages: readonly NormalizedUsage[]): NormalizedUsage {
  return usages.reduce<NormalizedUsage>((total, usage) => addUsage(total, usage), {});
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function usageLine(usage: NormalizedUsage): string | undefined {
  const parts = [
    usage.inputTokens === undefined ? undefined : `${count(usage.inputTokens)} input`,
    usage.outputTokens === undefined ? undefined : `${count(usage.outputTokens)} output`,
    usage.totalTokens === undefined ? undefined : `${count(usage.totalTokens)} total`,
    usage.cacheReadTokens === undefined ? undefined : `${count(usage.cacheReadTokens)} cache read`,
    usage.cacheWriteTokens === undefined ? undefined : `${count(usage.cacheWriteTokens)} cache write`,
    usage.reasoningTokens === undefined ? undefined : `${count(usage.reasoningTokens)} reasoning`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function costLine(cost: string | undefined): string | undefined {
  if (cost === undefined) return undefined;
  const numeric = Number(cost);
  if (!Number.isFinite(numeric)) return cost;
  return `$${numeric.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

function cacheLines(usages: readonly NormalizedUsage[]): string[] {
  const cache = analyzeCacheEffectiveness(usages);
  if (cache.status === "unavailable") return [];
  const ratio = cache.reuseRatio === undefined ? undefined : `${(cache.reuseRatio * 100).toFixed(1)}% reuse`;
  const detail = [
    ratio,
    `${count(cache.cacheReadTokens)} read`,
    `${count(cache.cacheWriteTokens)} write`,
    `${count(cache.samples)} response${cache.samples === 1 ? "" : "s"}`,
  ].filter((value): value is string => value !== undefined).join(" · ");
  return [
    `  Cache: ${cache.status.replaceAll("_", " ")} · ${detail}`,
    ...(cache.guidance === undefined ? [] : [`  Cache guidance: ${cache.guidance}`]),
  ];
}

export function formatSessionReport(input: {
  thread: ThreadRecord;
  branch: string;
  databasePath: string;
  events: readonly EventEnvelope[];
  runs: readonly RunRecord[];
  provider?: string;
  model?: string;
}): string {
  const messages = { user: 0, assistant: 0, tool: 0 };
  for (const envelope of input.events) {
    if (envelope.event.type !== "message_appended") continue;
    const role = envelope.event.message.role;
    if (role === "user" || role === "assistant" || role === "tool") messages[role] += 1;
  }
  const branchRuns = input.runs.filter((run) => run.branch === input.branch);
  const completedRuns = branchRuns.filter((run) => run.state === "completed").length;
  const usages = sessionUsages(input.events);
  const usage = sessionUsage(usages);
  const response = input.events.findLast((envelope) => envelope.event.type === "provider_response_started")?.event;
  const tokens = usageLine(usage);
  const cost = costLine(usage.cost);
  const model = input.provider === undefined
    ? "not selected"
    : input.model === undefined
      ? input.provider
      : `${input.provider}/${input.model}`;
  return [
    "Session",
    `  ID: ${input.thread.threadId}`,
    ...(input.thread.name === undefined ? [] : [`  Name: ${input.thread.name}`]),
    `  Store: ${input.databasePath}`,
    ...(input.thread.workspaceRoot === undefined ? [] : [`  Workspace: ${input.thread.workspaceRoot}`]),
    `  Branch: ${input.branch} · ${input.thread.branches.length} total`,
    `  Model: ${model}`,
    ...(response?.type !== "provider_response_started" ? [] : [
      `  Last response model: ${response.model}`,
      ...(response.responseId === undefined ? [] : [`  Last response ID: ${response.responseId}`]),
      ...(response.requestId === undefined ? [] : [`  Last request ID: ${response.requestId}`]),
    ]),
    `  Messages: ${count(messages.user)} user · ${count(messages.assistant)} assistant · ${count(messages.tool)} tool`,
    `  Runs: ${count(branchRuns.length)} total · ${count(completedRuns)} completed`,
    ...(tokens === undefined ? [] : [`  Tokens: ${tokens}`]),
    ...cacheLines(usages),
    ...(cost === undefined ? [] : [`  Cost: ${cost}`]),
    `  Created: ${input.thread.createdAt}`,
    `  Updated: ${input.thread.updatedAt}`,
  ].join("\n");
}
