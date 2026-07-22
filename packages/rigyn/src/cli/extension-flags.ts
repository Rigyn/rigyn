import type { RuntimeExtensionHost, RuntimeFlagDescription } from "../extensions/runtime.js";
import type { Args, CliDiagnostic } from "./args.js";

export interface ResolvedRuntimeExtensionFlags {
  values: Map<string, boolean | string>;
  diagnostics: CliDiagnostic[];
}

export function resolveRuntimeExtensionFlags(
  requested: ReadonlyMap<string, boolean | string>,
  flags: readonly RuntimeFlagDescription[],
): ResolvedRuntimeExtensionFlags {
  const registered = new Map(flags.map((flag) => [flag.name, flag]));
  const values = new Map<string, boolean | string>();
  const diagnostics: CliDiagnostic[] = [];
  const unknown: string[] = [];

  for (const [name, value] of requested) {
    const flag = registered.get(name);
    if (flag === undefined) {
      unknown.push(name);
      continue;
    }
    if (flag.type === "boolean") values.set(name, true);
    else if (typeof value === "string") values.set(name, value);
    else diagnostics.push({ type: "error", message: `Extension flag "--${name}" requires a value` });
  }
  if (unknown.length > 0) {
    diagnostics.push({
      type: "error",
      message: `Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((name) => `--${name}`).join(", ")}`,
    });
  }
  return { values, diagnostics };
}

export function applyRuntimeExtensionFlags(args: Args, host: RuntimeExtensionHost): Args {
  const resolved = resolveRuntimeExtensionFlags(args.unknownFlags, host.flags());
  host.setFlagValues(resolved.values);
  args.diagnostics.push(...resolved.diagnostics);
  return args;
}
