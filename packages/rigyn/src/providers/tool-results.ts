import type { ToolResultBlock } from "../core/types.js";

export function toolResultText(value: string | ToolResultBlock): string {
  if (typeof value === "string") return value === "" ? "[Tool completed with no text output]" : value;
  const content = value.content === "" ? "[Tool completed with no text output]" : value.content;
  if (value.status === undefined && value.summary === undefined && value.nextActions === undefined) return content;
  const status = value.status ?? (value.isError ? "error" : "success");
  const summary = value.summary?.trim() || content.trim().split("\n", 1)[0] || "Tool completed";
  const details = content.trim() === summary ? "" : `\nDetails:\n${content}`;
  const next = value.nextActions === undefined || value.nextActions.length === 0
    ? ""
    : `\nNext actions:\n${value.nextActions.map((action) => `- ${action}`).join("\n")}`;
  return `Status: ${status}\nSummary: ${summary}${details}${next}`;
}
