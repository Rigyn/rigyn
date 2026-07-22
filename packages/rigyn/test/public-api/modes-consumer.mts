import {
  runPrintMode,
  type PrintModeOptions,
} from "rigyn/modes";
import type { AgentSessionRuntime } from "rigyn";

declare const runtime: AgentSessionRuntime;
const options = {
  initialMessage: "inspect",
  messages: ["verify"],
  mode: "json",
} satisfies PrintModeOptions;
const result: Promise<number> = runPrintMode(runtime, options);
void result;
