import type { ObservabilityMode } from "../core/observability.js";
import { parseArgs } from "./args.js";
import { findLeadingManagementCommand } from "./management-args.js";

export interface CliTtyState {
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
}

export interface AgentCliModeInput extends CliTtyState {
  mode?: "text" | "json" | "rpc";
  print?: boolean;
}

/** Resolve the agent CLI mode once, before runtime and crash reporting diverge. */
export function resolveAgentCliMode(input: AgentCliModeInput): ObservabilityMode {
  if (input.mode === "rpc") return "rpc";
  if (input.mode === "json") return "json";
  if (input.mode === "text" || input.print === true) return "print";
  return input.stdinIsTTY === true && input.stdoutIsTTY === true ? "interactive" : "print";
}

/** Resolve the process mode from raw argv for failures that happen before argument parsing. */
export function resolveCliInvocationMode(
  invocation: readonly string[],
  tty: CliTtyState,
): ObservabilityMode {
  if (findLeadingManagementCommand(invocation) === "serve") return "serve";
  const parsed = parseArgs(invocation);
  return resolveAgentCliMode({
    ...tty,
    ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
    print: parsed.print === true,
  });
}
