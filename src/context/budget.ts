export const DEFAULT_CONTEXT_SAFETY_TOKENS = 0;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
export const FALLBACK_OUTPUT_RESERVE_TOKENS = 16_384;

export interface ModelContextMetadata {
  contextTokens?: number;
  maxOutputTokens?: number;
}

export interface ContextBudgetOptions {
  requestedMaxOutputTokens?: number;
  reserveTokens?: number;
  safetyMarginTokens?: number;
}

export interface EffectiveContextBudgetOptions extends ContextBudgetOptions {
  /** Explicit harness input ceiling. When set, it is the displayed and enforced window. */
  contextTokenBudget?: number;
}

export interface ContextBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  maxInputTokens: number;
  compactAtTokens: number;
}

function positiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

export function deriveContextBudget(
  model: ModelContextMetadata,
  options: ContextBudgetOptions = {},
): ContextBudget | undefined {
  if (!positiveSafeInteger(model.contextTokens)) return undefined;
  const requestedMaxOutput = options.requestedMaxOutputTokens;
  if (requestedMaxOutput !== undefined && !positiveSafeInteger(requestedMaxOutput)) {
    throw new RangeError("requestedMaxOutputTokens must be a positive safe integer");
  }
  const advertised = model.maxOutputTokens;
  if (advertised !== undefined && !positiveSafeInteger(advertised)) return undefined;
  const reserve = options.reserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  if (!positiveSafeInteger(reserve)) {
    throw new RangeError("reserveTokens must be a positive safe integer");
  }
  const requestedSafety = options.safetyMarginTokens ?? DEFAULT_CONTEXT_SAFETY_TOKENS;
  if (!Number.isSafeInteger(requestedSafety) || requestedSafety < 0) {
    throw new RangeError("safetyMarginTokens must be a non-negative safe integer");
  }

  const reservedOutputTokens = Math.min(reserve, Math.max(0, model.contextTokens - 1));
  const maxInputTokens = model.contextTokens;
  const safetyMarginTokens = Math.min(requestedSafety, Math.max(0, maxInputTokens - reservedOutputTokens - 1));
  return {
    contextWindowTokens: model.contextTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    maxInputTokens,
    compactAtTokens: Math.max(1, maxInputTokens - reservedOutputTokens - safetyMarginTokens),
  };
}

/** Conservative budget for catalogs that do not publish an exact model limit. */
export function fallbackContextBudget(options: Pick<ContextBudgetOptions, "requestedMaxOutputTokens"> = {}): ContextBudget {
  const budget = deriveContextBudget({
    contextTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: FALLBACK_OUTPUT_RESERVE_TOKENS,
  }, options);
  if (budget === undefined) throw new Error("Fallback context budget invariant failed");
  return budget;
}

/** Resolves the exact budget contract shared by execution and user interfaces. */
export function resolveEffectiveContextBudget(
  model: ModelContextMetadata | undefined,
  options: EffectiveContextBudgetOptions = {},
): ContextBudget {
  if (options.requestedMaxOutputTokens !== undefined && !positiveSafeInteger(options.requestedMaxOutputTokens)) {
    throw new RangeError("requestedMaxOutputTokens must be a positive safe integer");
  }
  if (options.contextTokenBudget !== undefined) {
    if (!positiveSafeInteger(options.contextTokenBudget)) {
      throw new RangeError("contextTokenBudget must be a positive safe integer");
    }
    return {
      contextWindowTokens: options.contextTokenBudget,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
      maxInputTokens: options.contextTokenBudget,
      compactAtTokens: options.contextTokenBudget,
    };
  }
  if (model !== undefined) {
    try {
      const resolved = deriveContextBudget(model, options);
      if (resolved !== undefined) return resolved;
    } catch {
      // Malformed or incomplete catalog metadata must not disable compaction.
    }
  }
  return fallbackContextBudget(
    options.requestedMaxOutputTokens === undefined
      ? {}
      : { requestedMaxOutputTokens: options.requestedMaxOutputTokens },
  );
}
