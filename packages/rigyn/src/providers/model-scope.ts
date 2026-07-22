import type { ModelReasoningEffort } from "./registry.js";
import { parseModelReasoningReference } from "./registry.js";

export const SCOPED_MODELS_NONE = "!none";

export interface ScopedModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: ModelReasoningEffort;
}

export interface ModelScopeReasoningDiagnostic {
  pattern: string;
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  supportedReasoningEfforts: ModelReasoningEffort[];
}

export interface ModelScopeResolution<T extends ScopedModelSelection> {
  models: Array<T & { reasoningEffort?: ModelReasoningEffort }>;
  diagnostics: ModelScopeReasoningDiagnostic[];
  omittedCount: number;
}

interface CompiledScopePattern {
  full: RegExp;
  shorthand?: RegExp;
  reasoningEffort?: ModelReasoningEffort;
}

function glob(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      while (pattern[index + 1] === "*") index += 1;
      source += ".*";
      continue;
    }
    if (character === "?") {
      source += ".";
      continue;
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) {
        let content = pattern.slice(index + 1, closing);
        const negated = content.startsWith("!");
        if (negated) content = content.slice(1);
        if (content !== "") {
          source += `[${negated ? "^" : ""}${content.replaceAll("\\", "\\\\").replaceAll("^", "\\^")}]`;
          index = closing;
          continue;
        }
      }
    }
    source += /[|\\{}()[\]^$+?.]/u.test(character) ? `\\${character}` : character;
  }
  try {
    return new RegExp(`${source}$`, "iu");
  } catch {
    throw new Error(`Invalid model scope pattern: ${JSON.stringify(pattern)}`);
  }
}

function compileScopePattern(pattern: string): CompiledScopePattern {
  if (pattern === "" || Buffer.byteLength(pattern, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(pattern)) {
    throw new Error("Model scope patterns must contain 1 to 256 bytes without control characters");
  }
  const parsed = parseModelReasoningReference(pattern);
  return {
    full: glob(pattern),
    ...(parsed.reasoningEffort === undefined
      ? {}
      : {
          shorthand: glob(parsed.reference),
          reasoningEffort: parsed.reasoningEffort,
        }),
  };
}

function matches(pattern: RegExp, provider: string, model: string): boolean {
  return pattern.test(`${provider}/${model}`) || pattern.test(model);
}

function localScopeMatch(
  provider: string,
  model: string,
  pattern: CompiledScopePattern,
): { kind?: "literal" | "thinking"; reasoningEffort?: ModelReasoningEffort } {
  if (matches(pattern.full, provider, model)) return { kind: "literal" };
  if (pattern.shorthand === undefined || pattern.reasoningEffort === undefined) return {};
  return matches(pattern.shorthand, provider, model)
    ? { kind: "thinking", reasoningEffort: pattern.reasoningEffort }
    : {};
}

/** Candidate-local predicate. Use orderModelsForScope when literal-vs-thinking collisions require catalog context. */
export function modelMatchesScope(provider: string, model: string, patterns: readonly string[]): boolean {
  if (patterns.length > 100) throw new Error("Model scope cannot contain more than 100 patterns");
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => pattern !== SCOPED_MODELS_NONE
    && localScopeMatch(provider, model, compileScopePattern(pattern)).kind !== undefined);
}

export function orderModelsForScope<T extends ScopedModelSelection>(
  models: readonly T[],
  patterns: readonly string[],
): Array<T & { reasoningEffort?: ModelReasoningEffort }> {
  return resolveModelsForScope(models, patterns).models;
}

export function resolveModelsForScope<T extends ScopedModelSelection>(
  models: readonly T[],
  patterns: readonly string[],
  reasoningEfforts?: (model: T) => readonly ModelReasoningEffort[] | undefined,
): ModelScopeResolution<T> {
  if (patterns.length > 100) throw new Error("Model scope cannot contain more than 100 patterns");
  const unique = new Map<string, T>();
  for (const model of models) {
    const key = `${model.provider}\u0000${model.model}`;
    if (!unique.has(key)) unique.set(key, model);
  }
  const available = [...unique.values()].sort((left, right) => {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
    if (left.model === right.model) return 0;
    return left.model < right.model ? -1 : 1;
  });
  if (patterns.length === 0) return { models: available, diagnostics: [], omittedCount: 0 };
  const ordered: Array<T & { reasoningEffort?: ModelReasoningEffort }> = [];
  const diagnostics: ModelScopeReasoningDiagnostic[] = [];
  let omittedCount = 0;
  const added = new Set<string>();
  for (const pattern of patterns) {
    if (pattern === SCOPED_MODELS_NONE) continue;
    const compiled = compileScopePattern(pattern);
    const literalMatches = available.filter((model) => matches(compiled.full, model.provider, model.model));
    const matchesForPattern = literalMatches.length > 0
      ? literalMatches.map((model) => ({ model, matched: { kind: "literal" as const } }))
      : compiled.shorthand === undefined || compiled.reasoningEffort === undefined
        ? []
        : available
            .filter((model) => matches(compiled.shorthand!, model.provider, model.model))
            .map((model) => ({
              model,
              matched: { kind: "thinking" as const, reasoningEffort: compiled.reasoningEffort },
            }));
    for (const { model, matched } of matchesForPattern) {
      const key = `${model.provider}\u0000${model.model}`;
      if (added.has(key)) continue;
      if (matched.kind === "thinking" && matched.reasoningEffort !== undefined) {
        const supported = reasoningEfforts?.(model);
        if (supported !== undefined && !supported.includes(matched.reasoningEffort)) {
          omittedCount += 1;
          if (diagnostics.length < 20) diagnostics.push({
            pattern,
            provider: model.provider,
            model: model.model,
            reasoningEffort: matched.reasoningEffort,
            supportedReasoningEfforts: [...supported],
          });
          continue;
        }
      }
      added.add(key);
      ordered.push({
        ...model,
        ...(matched.kind !== "thinking" || matched.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: matched.reasoningEffort }),
      });
    }
  }
  return { models: ordered, diagnostics, omittedCount };
}

export function parseModelScope(value: string): string[] {
  const trimmed = value.trim();
  const patterns = trimmed === "" || trimmed === "clear" || trimmed === "all"
    ? []
    : trimmed === "none"
      ? [SCOPED_MODELS_NONE]
      : value.split(",").map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
  if (patterns.length > 100 || patterns.some((pattern) => Buffer.byteLength(pattern) > 256)) {
    throw new Error("Model scope must contain at most 100 patterns no larger than 256 bytes");
  }
  return patterns;
}
