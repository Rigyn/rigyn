import type { ImageContent, Message, TextContent } from "@rigyn/models";
import type { AgentMessage } from "../types.js";

export const COMPACTION_SUMMARY_PREFIX = "The earlier conversation was condensed into this summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
export const BRANCH_SUMMARY_PREFIX = "This summarizes a branch that was left before returning here:\n\n<summary>\n";
export const BRANCH_SUMMARY_SUFFIX = "</summary>";

export interface BashExecutionMessage { role: "bashExecution"; command: string; output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string; timestamp: number; excludeFromContext?: boolean; }
export interface CustomMessage<T = unknown> { role: "custom"; customType: string; content: string | Array<TextContent | ImageContent>; display: boolean; details?: T; timestamp: number; }
export interface BranchSummaryMessage { role: "branchSummary"; summary: string; fromId: string; timestamp: number; }
export interface CompactionSummaryMessage { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number; }

declare module "../types.js" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage;
    custom: CustomMessage;
    branchSummary: BranchSummaryMessage;
    compactionSummary: CompactionSummaryMessage;
  }
}

export function bashExecutionToText(message: BashExecutionMessage): string {
  let text = `Ran \`${message.command}\`\n${message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)"}`;
  if (message.cancelled) text += "\n\n(command cancelled)";
  else if (message.exitCode !== undefined && message.exitCode !== 0) text += `\n\nCommand exited with code ${message.exitCode}`;
  if (message.truncated && message.fullOutputPath) text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
  return { role: "branchSummary", summary, fromId, timestamp: Date.parse(timestamp) };
}
export function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string): CompactionSummaryMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp: Date.parse(timestamp) };
}
export function createCustomMessage<T>(customType: string, content: string | Array<TextContent | ImageContent>, display: boolean, details: T | undefined, timestamp: string): CustomMessage<T> {
  return { role: "custom", customType, content, display, ...(details === undefined ? {} : { details }), timestamp: Date.parse(timestamp) };
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") return [message];
    if (message.role === "bashExecution") return message.excludeFromContext ? [] : [{ role: "user", content: [{ type: "text", text: bashExecutionToText(message) }], timestamp: message.timestamp }];
    if (message.role === "custom") return [{ role: "user", content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content, timestamp: message.timestamp }];
    if (message.role === "branchSummary") return [{ role: "user", content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX }], timestamp: message.timestamp }];
    if (message.role === "compactionSummary") return [{ role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX }], timestamp: message.timestamp }];
    return [];
  });
}
