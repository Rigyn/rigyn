export const DEFAULT_CONTEXT_SAFETY_TOKENS = 0;
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_OUTPUT_HEADROOM_RATIO = 0.15;

const MIN_TRIGGER_PERCENT = 50;
const MAX_TRIGGER_PERCENT = 95;

export interface ModelContextMetadata {
  contextTokens?: number;
  /** Published provider ceiling for input tokens, independent of the total context window. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ContextBudgetOptions {
  requestedMaxOutputTokens?: number;
  reserveTokens?: number;
  safetyMarginTokens?: number;
  triggerPercent?: number;
}

export interface EffectiveContextBudgetOptions extends ContextBudgetOptions {
  /** Explicit total context window. Published input ceilings remain independently enforced. */
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
  const advertisedInput = model.maxInputTokens;
  if (advertisedInput !== undefined && !positiveSafeInteger(advertisedInput)) return undefined;
  const configuredReserve = options.reserveTokens;
  if (configuredReserve !== undefined && !positiveSafeInteger(configuredReserve)) {
    throw new RangeError("reserveTokens must be a positive safe integer");
  }
  const triggerPercent = options.triggerPercent;
  if (triggerPercent !== undefined && (
    !Number.isSafeInteger(triggerPercent) ||
    triggerPercent < MIN_TRIGGER_PERCENT ||
    triggerPercent > MAX_TRIGGER_PERCENT
  )) {
    throw new RangeError(`triggerPercent must be an integer from ${MIN_TRIGGER_PERCENT} through ${MAX_TRIGGER_PERCENT}`);
  }
  const requestedSafety = options.safetyMarginTokens ?? DEFAULT_CONTEXT_SAFETY_TOKENS;
  if (!Number.isSafeInteger(requestedSafety) || requestedSafety < 0) {
    throw new RangeError("safetyMarginTokens must be a non-negative safe integer");
  }

  if (
    requestedMaxOutput !== undefined &&
    model.contextTokens - requestedMaxOutput < 1
  ) {
    throw new RangeError("requestedMaxOutputTokens leaves no model context for input");
  }
  const proportionalReserve = Math.max(1, Math.ceil(model.contextTokens * DEFAULT_OUTPUT_HEADROOM_RATIO));
  const reservedOutputTokens = Math.min(
    Math.max(configuredReserve ?? proportionalReserve, requestedMaxOutput ?? 0),
    Math.max(0, model.contextTokens - 1),
  );
  const contextDerivedMaxInputTokens = Math.max(1, model.contextTokens - reservedOutputTokens);
  const maxInputTokens = Math.min(advertisedInput ?? contextDerivedMaxInputTokens, contextDerivedMaxInputTokens);
  const safetyMarginTokens = Math.min(requestedSafety, Math.max(0, maxInputTokens - 1));
  const hardTrigger = Math.max(1, maxInputTokens - safetyMarginTokens);
  const compactAtTokens = triggerPercent === undefined
    ? hardTrigger
    : Math.min(hardTrigger, Math.max(1, Math.floor(model.contextTokens * triggerPercent / 100)));
  return {
    contextWindowTokens: model.contextTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    maxInputTokens,
    compactAtTokens,
  };
}

/** Conservative budget for catalogs that do not publish an exact model limit. */
export function fallbackContextBudget(options: ContextBudgetOptions = {}): ContextBudget {
  const budget = deriveContextBudget({
    contextTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
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
    const resolved = deriveContextBudget({
      contextTokens: options.contextTokenBudget,
      ...(positiveSafeInteger(model?.maxInputTokens) ? { maxInputTokens: model.maxInputTokens } : {}),
      ...(positiveSafeInteger(model?.maxOutputTokens) ? { maxOutputTokens: model.maxOutputTokens } : {}),
    }, options);
    if (resolved === undefined) throw new Error("Explicit context budget invariant failed");
    return resolved;
  }
  if (model !== undefined) {
    try {
      const resolved = deriveContextBudget(model, options);
      if (resolved !== undefined) return resolved;
    } catch {
      // Malformed or incomplete catalog metadata must not disable compaction.
    }
  }
  const fallback = deriveContextBudget({
    contextTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
    ...(positiveSafeInteger(model?.maxInputTokens) ? { maxInputTokens: model.maxInputTokens } : {}),
  }, {
    ...(options.requestedMaxOutputTokens === undefined
      ? {}
      : { requestedMaxOutputTokens: options.requestedMaxOutputTokens }),
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(options.safetyMarginTokens === undefined
      ? {}
      : { safetyMarginTokens: options.safetyMarginTokens }),
    ...(options.triggerPercent === undefined ? {} : { triggerPercent: options.triggerPercent }),
  });
  if (fallback === undefined) throw new Error("Fallback context budget invariant failed");
  return fallback;
}
