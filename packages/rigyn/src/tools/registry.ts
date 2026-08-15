import type { ProviderToolDefinition } from "../core/types.js";
import {
  resolveToolRecovery,
  type HarnessTool,
  type ToolRecoveryContract,
} from "./types.js";

export class ToolRegistry {
  readonly #tools = new Map<string, HarnessTool>();
  readonly #recoveries = new Map<string, ToolRecoveryContract>();

  constructor(tools: Iterable<HarnessTool> = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: HarnessTool): void {
    const name = tool.definition.name;
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(name)) throw new Error(`Invalid tool name: ${name}`);
    if (tool.definition.loading !== undefined && tool.definition.loading !== "eager" && tool.definition.loading !== "deferred") {
      throw new Error(`Invalid tool loading mode: ${tool.definition.loading}`);
    }
    if (this.#tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    const recovery = resolveToolRecovery(tool.recovery);
    this.#tools.set(name, tool);
    this.#recoveries.set(name, recovery);
  }

  get(name: string): HarnessTool | undefined {
    return this.#tools.get(name);
  }

  recovery(name: string): ToolRecoveryContract | undefined {
    return this.#recoveries.get(name);
  }

  definitions(names?: readonly string[]): ProviderToolDefinition[] {
    const tools = names === undefined
      ? [...this.#tools.values()].sort((left, right) => left.definition.name.localeCompare(right.definition.name))
      : names.map((name) => this.#tools.get(name)).filter((tool): tool is HarnessTool => tool !== undefined);
    return tools.map((tool) => structuredClone(tool.definition));
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }
}
