import type { AgentSessionStats } from "../service/agent-session.js";
import type { SessionContext, SessionInfo } from "../storage/types.js";

export function formatSessionUsageReport(stats: AgentSessionStats): string {
  const input = stats.tokens.input ?? stats.tokens.inputReported;
  const output = stats.tokens.output ?? stats.tokens.outputReported;
  const promptValues = [
    input,
    stats.tokens.cacheRead ?? stats.tokens.cacheReadReported,
    stats.tokens.cacheWrite ?? stats.tokens.cacheWriteReported,
  ];
  const promptTokens = promptValues.some((value) => value !== undefined)
    ? promptValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
  const promptPartial = stats.tokens.input === undefined
    || stats.tokens.cacheRead === undefined
    || stats.tokens.cacheWrite === undefined;
  const promptText = promptTokens === undefined
    ? "prompt unavailable"
    : `${promptPartial ? "at least " : ""}${promptTokens.toLocaleString("en-US")} prompt`;
  const outputText = output === undefined
    ? "output unavailable"
    : `${output.toLocaleString("en-US")} output${stats.tokens.output === undefined ? " reported (partial)" : ""}`;
  const totalText = stats.tokens.total !== undefined
    ? `${stats.tokens.total.toLocaleString("en-US")} total`
    : stats.tokens.totalReported !== undefined
      ? `${stats.tokens.totalReported.toLocaleString("en-US")} total reported (partial)`
      : "exact total unavailable";
  const lines = [
    "Usage scope: complete journal (all branches and summary requests)",
    `Messages: ${stats.totalMessages} total · ${stats.userMessages} user · ${stats.assistantMessages} assistant`,
    `Tools: ${stats.toolCalls} calls · ${stats.toolResults} results`,
    `Tokens: ${promptText} · ${outputText} · ${totalText}`,
  ];
  const cacheRead = stats.tokens.cacheRead;
  const cacheWrite = stats.tokens.cacheWrite;
  const cacheReadReported = stats.tokens.cacheReadReported;
  const cacheWriteReported = stats.tokens.cacheWriteReported;
  if (
    cacheRead === undefined && cacheWrite === undefined &&
    cacheReadReported === undefined && cacheWriteReported === undefined
  ) {
    lines.push("Prompt cache: not reported");
  } else {
    const reads = cacheRead === undefined
      ? cacheReadReported === undefined
        ? "reads not reported"
        : `${cacheReadReported.toLocaleString("en-US")} read reported (partial)`
      : `${cacheRead.toLocaleString("en-US")} read`;
    const writes = cacheWrite === undefined
      ? cacheWriteReported === undefined
        ? "writes not reported"
        : `${cacheWriteReported.toLocaleString("en-US")} written reported (partial)`
      : `${cacheWrite.toLocaleString("en-US")} written`;
    lines.push(`Prompt cache: ${reads} · ${writes}`);
  }
  lines.push(stats.cacheHitPercent === undefined
    ? "Whole-journal cache hit: unavailable (complete prompt-cache telemetry required)"
    : `Whole-journal cache hit: ${stats.cacheHitPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}% of reported prompt tokens`);
  if (stats.cost !== undefined) lines.push(`Cost: $${stats.cost.toFixed(3)}`);
  else if (stats.costReported !== undefined) lines.push(`Cost: $${stats.costReported.toFixed(3)} reported (partial)`);
  const waste = stats.cacheWaste;
  if (waste !== undefined && waste.missedTokens > 0) {
    const requests = waste.missCount === 1 ? "1 request" : `${waste.missCount} requests`;
    const cost = waste.missedCost >= 0.0001 ? ` · estimated added cost $${waste.missedCost.toFixed(3)}` : "";
    lines.push(`Active-branch cache non-reuse estimate: up to ${waste.missedTokens.toLocaleString("en-US")} prior-prompt tokens · ${requests}${cost}`);
  }
  return lines.join("\n");
}

export function formatSessionReport(input: {
  session: SessionInfo;
  context?: Pick<SessionContext, "model"> & Partial<Omit<SessionContext, "model">>;
  stats?: AgentSessionStats;
}): string {
  const { session } = input;
  return [
    `Session: ${session.name ?? session.id}`,
    `ID: ${session.id}`,
    `File: ${session.path}`,
    `Workspace: ${session.cwd}`,
    ...(input.stats === undefined ? [`Messages: ${session.messageCount}`] : []),
    `Created: ${session.created.toISOString()}`,
    `Updated: ${session.modified.toISOString()}`,
    ...(input.context?.model === null || input.context?.model === undefined
      ? []
      : [`Model: ${input.context.model.provider}/${input.context.model.modelId}`]),
    ...(input.stats === undefined ? [] : [formatSessionUsageReport(input.stats)]),
  ].join("\n");
}
