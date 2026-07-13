import { randomUUID } from "node:crypto";

export type ThreadId = string;
export type RunId = string;
export type EventId = string;
export type MessageId = string;
export type ToolCallId = string;
export type ArtifactId = string;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
