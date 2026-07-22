import { clampThinkingLevel } from "../models.js";
import { estimateContextTokens } from "../utils/estimate.js";
import type { Api, Context, Model, ModelThinkingLevel, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";

const CONTEXT_SAFETY_TOKENS = 4_096;

export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
  if (model.contextWindow <= 0) return Math.max(1, maxTokens);
  const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
  return Math.min(maxTokens, Math.max(1, available));
}

export function buildBaseOptions(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  apiKey?: string,
): StreamOptions {
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options ?? {})) if (value !== undefined) output[name] = value;
  output.maxTokens = clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens);
  const resolvedApiKey = apiKey ?? options?.apiKey;
  if (resolvedApiKey !== undefined) output.apiKey = resolvedApiKey;
  return output as StreamOptions;
}

export function clampReasoning(level: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
  return level === "xhigh" || level === "max" ? "high" : level;
}

export function adjustMaxTokensForThinking(
  explicitMaximum: number | undefined,
  modelMaximum: number,
  level: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaults: Required<Pick<ThinkingBudgets, "minimal" | "low" | "medium" | "high">> = {
    minimal: 1_024,
    low: 2_048,
    medium: 8_192,
    high: 16_384,
  };
  const budgets = { ...defaults, ...customBudgets };
  const normalized = clampReasoning(level) ?? "high";
  let thinkingBudget = budgets[normalized] ?? defaults.high;
  const maxTokens = explicitMaximum === undefined ? modelMaximum : Math.min(explicitMaximum + thinkingBudget, modelMaximum);
  if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - 1_024);
  return { maxTokens, thinkingBudget };
}

export function resolveSimpleReasoning<TApi extends Api>(model: Model<TApi>, requested: ModelThinkingLevel | undefined): ThinkingLevel | undefined {
  if (requested === undefined || requested === "off") return undefined;
  const resolved: ModelThinkingLevel = clampThinkingLevel(model, requested);
  return resolved === "off" ? undefined : resolved;
}
