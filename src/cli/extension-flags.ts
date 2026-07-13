import type { RuntimeExtensionHost, RuntimeFlagDescription } from "../extensions/index.js";
import { parseArguments, type ParsedArguments } from "./args.js";

export interface ResolvedRuntimeExtensionFlags {
  arguments: ParsedArguments;
  values: Map<string, boolean | string>;
}

export function resolveRuntimeExtensionFlags(
  source: readonly string[],
  flags: readonly RuntimeFlagDescription[],
): ResolvedRuntimeExtensionFlags {
  const parsed = parseArguments([...source], {
    additionalFlags: flags.map(({ name, type }) => ({ name, type })),
  });
  const values = new Map<string, boolean | string>();
  for (const flag of flags) {
    const value = parsed.flags.get(flag.name);
    if (value === undefined) continue;
    if (Array.isArray(value) || typeof value !== flag.type) {
      throw new Error(`Extension flag --${flag.name} requires a ${flag.type} value`);
    }
    values.set(flag.name, value);
  }
  return { arguments: parsed, values };
}

export function applyRuntimeExtensionFlags(
  current: ParsedArguments,
  host: RuntimeExtensionHost,
): ParsedArguments {
  const resolved = resolveRuntimeExtensionFlags(current.source, host.flags());
  host.setFlagValues(resolved.values);
  return resolved.arguments;
}
