import type { Message } from "@rigyn/models";

import type {
  AgentMessage,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "./types.js";

function messageTime(value: number | string): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function bashExecutionToText(message: BashExecutionMessage): string {
  const lines = [`$ ${message.command}`, message.output];
  if (message.cancelled) lines.push("[Command cancelled]");
  else if (message.timedOut === true) lines.push("[Command timed out]");
  else if (message.signal !== undefined) lines.push(`[Command stopped after signal ${message.signal}]`);
  else if (message.exitCode !== undefined && message.exitCode !== 0) lines.push(`Command returned status ${message.exitCode}`);
  else if (message.isError === true) lines.push("[Command failed]");
  if (message.truncated) {
    lines.push(message.fullOutputPath === undefined
      ? "[Output shortened]"
      : `[Output shortened. Complete transcript: ${message.fullOutputPath}]`);
  }
  return lines.filter((line, index) => line !== "" || index === 1).join("\n");
}

function summaryText(message: BranchSummaryMessage | CompactionSummaryMessage): string {
  return message.summary;
}

function customText(message: CustomMessage): CustomMessage["content"] {
  return message.content;
}

export function convertToLlm(messages: readonly AgentMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      converted.push(message);
      continue;
    }
    if (message.role === "bashExecution") {
      if (message.excludeFromContext === true) continue;
      converted.push({ role: "user", content: bashExecutionToText(message), timestamp: message.timestamp });
      continue;
    }
    if (message.role === "custom") {
      converted.push({ role: "user", content: customText(message), timestamp: message.timestamp });
      continue;
    }
    converted.push({ role: "user", content: summaryText(message), timestamp: message.timestamp });
  }
  return converted;
}

export const agentMessagesToModelMessages = convertToLlm;

export function createCustomMessage<T>(
  customType: string,
  content: CustomMessage<T>["content"],
  display: boolean,
  details?: T,
  timestamp: number | string = Date.now(),
): CustomMessage<T> {
  return {
    role: "custom",
    customType,
    content,
    display,
    ...(details === undefined ? {} : { details }),
    timestamp: messageTime(timestamp),
  };
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: number | string = Date.now()): BranchSummaryMessage {
  return { role: "branchSummary", summary, fromId, timestamp: messageTime(timestamp) };
}

export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: number | string = Date.now(),
): CompactionSummaryMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp: messageTime(timestamp) };
}

export interface SystemPromptSections {
  base?: string;
  context?: readonly string[];
  skills?: string;
  suffix?: string;
}

export function assembleSystemPrompt(sections: SystemPromptSections): string {
  return [sections.base, ...(sections.context ?? []), sections.skills, sections.suffix]
    .filter((section): section is string => typeof section === "string" && section.trim() !== "")
    .join("\n\n");
}
