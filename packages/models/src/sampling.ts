import type { GrammarConstraint, Tool } from "./contracts.js";

export interface GrammarInputBuffer {
  value: string;
  emitted?: number;
  opened?: boolean;
  closed?: boolean;
}

function constraint(tool: Tool): GrammarConstraint | undefined {
  const sampling = tool.constrainedSampling || undefined;
  if (sampling?.type !== "grammar") return undefined;
  const selected = sampling.variants.openai_lark !== undefined
    ? { format: "lark" as const, definition: sampling.variants.openai_lark }
    : sampling.variants.openai_regex !== undefined
      ? { format: "regex" as const, definition: sampling.variants.openai_regex }
      : undefined;
  if (!selected) return undefined;
  const schema = tool.parameters as unknown as {
    required?: unknown;
    properties?: Record<string, { type?: unknown }>;
  };
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const property = required.find((name) => schema.properties?.[name]?.type === "string") ?? required[0] ?? "input";
  return { ...selected, property };
}

function unsupported(tool: Tool, supported: boolean): void {
  const sampling = tool.constrainedSampling || undefined;
  if (!supported && sampling?.type === "json_schema" && sampling.strict === "require") {
    throw new Error(`Tool ${tool.name} requires strict JSON-schema sampling, but the model does not support it`);
  }
}

export function strictToolValue(tool: Tool, supported: boolean): boolean | undefined {
  unsupported(tool, supported);
  if (!supported || !tool.constrainedSampling || tool.constrainedSampling.type !== "json_schema") return undefined;
  return true;
}

export function grammarSampling(tool: Tool, supported: boolean): GrammarConstraint | undefined {
  return supported ? constraint(tool) : undefined;
}

export function grammarToolProperties(
  tools: readonly Tool[],
  supported: boolean,
): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const tool of tools) {
    const grammar = grammarSampling(tool, supported);
    if (grammar) properties.set(tool.name, grammar.property ?? "input");
  }
  return properties;
}

export function grammarInput(toolName: string, arguments_: Record<string, unknown>, property: string): string {
  const value = arguments_[property];
  if (typeof value !== "string") throw new TypeError(`Grammar tool ${toolName} requires string property ${property}`);
  return value;
}

export function appendGrammarInputDelta(
  buffer: GrammarInputBuffer,
  property: string,
  nextInput: string,
  done: boolean,
): string {
  buffer.value = nextInput;
  const prefix = `{"${property}":`;
  const encoded = JSON.stringify(nextInput);
  const complete = `${prefix}${encoded}}`;
  const emitted = buffer.emitted ?? 0;
  const visibleEnd = done ? complete.length : Math.max(prefix.length + 1, complete.length - 2);
  const fragment = complete.slice(emitted, visibleEnd);
  buffer.emitted = visibleEnd;
  buffer.opened = true;
  buffer.closed = done;
  return fragment;
}
