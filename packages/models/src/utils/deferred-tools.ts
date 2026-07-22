import type { Context, Tool } from "../types.js";

export function splitDeferredTools(
  context: Context,
  enabled: boolean,
  normalizeName: (name: string) => string = (name) => name,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
  const tools = new Map<string, Tool>();
  for (const tool of context.tools ?? []) tools.set(normalizeName(tool.name), tool);
  if (!enabled) return { immediate: [...tools.values()], deferred: new Map() };
  const requested = new Set<string>();
  const used = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") used.add(normalizeName(block.name));
    if (message.role === "toolResult") for (const name of message.addedToolNames ?? []) if (!used.has(normalizeName(name))) requested.add(normalizeName(name));
  }
  const immediate: Tool[] = [];
  const deferred = new Map<string, Tool>();
  for (const [name, tool] of tools) if (requested.has(name)) deferred.set(name, tool); else immediate.push(tool);
  return { immediate, deferred };
}
