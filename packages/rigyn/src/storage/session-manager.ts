import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SESSION_V4_VERSION,
  SESSION_V4_MAX_FILE_BYTES,
  SESSION_V4_MAX_RECORD_BYTES,
  SESSION_V4_PRIMARY_BRANCH_ID,
  SessionV4SyncWriter,
  applySessionV4CommitOwned,
  cloneSessionV4State,
  createSessionV4State,
  parseSessionV4Bytes,
  parseSessionV4Header,
  readSessionV4File,
  readSessionV4FileSync,
  type SessionV4Changes,
  type SessionV4Commit,
  type SessionV4ConversationNode,
  type SessionV4Header,
  type SessionV4Json,
  type SessionV4Parent,
  type SessionV4State,
  type SessionV4ThinkingLevel,
} from "@rigyn/kernel/session-v4";
import { getAgentDir, getSessionsDir } from "../config/paths.js";
import type { CanonicalMessage, ImageBlock, NormalizedUsage, TextBlock } from "../core/types.js";
import {
  addCompleteNormalizedUsage,
  addNormalizedUsage,
  isNormalizedUsage,
} from "../core/usage.js";
import { filesystemPathIdentity, sameFilesystemPath } from "../utils/paths.js";
import {
  CURRENT_SESSION_VERSION,
  type BashExecutionMessage,
  type BranchSummaryEntry,
  type BranchSummaryMessage,
  type CompactionEntry,
  type CompactionSummaryMessage,
  type CustomEntry,
  type CustomMessage,
  type CustomMessageEntry,
  type ModelChangeEntry,
  type NewSessionOptions,
  type PersistedSessionMessage,
  type SessionBranchQuery,
  type SessionContext,
  type SessionContextMessage,
  type SessionEntry,
  type SessionFileIssue,
  type SessionHeader,
  type SessionInfo,
  type SessionListProgress,
  type SessionMessageEntry,
  type SessionScanResult,
  type SessionTreeNode,
  type ThinkingLevelChangeEntry,
} from "./types.js";
import {
  selectSessionBranchEntries,
  validateSessionBranchQuery,
} from "./session-branch-query.js";
import {
  acquireSessionWriterLeaseSync,
  type SessionWriterLease,
} from "./session-writer-lease.js";

const INFO_READ_CONCURRENCY = 10;
const SESSION_READ_NONBLOCK = constants.O_NONBLOCK ?? 0;
const SESSION_READ_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SESSION_DIRECTORY_SLUG_LENGTH = 80;
const CUSTOM_ENTRY_EXTENSION = "rigyn.session.custom";
const CUSTOM_MESSAGE_EXTENSION = "rigyn.session.custom-message";
const MESSAGE_CUSTOM_EXTENSION = "rigyn.session.message-custom";
const BRANCH_SUMMARY_EXTENSION = "rigyn.session.branch-summary";
const TOOLS_CHANGE_CUSTOM_TYPE = "rigyn.session.tools-change";
const PRIVATE_SESSION_DIRECTORY_MODE = 0o700;
const activeSessionWriters = new Set<string>();

export interface ActiveBranchUsage {
  usage: NormalizedUsage;
  /** Per-field reported lower bounds when one or more observations omit telemetry. */
  reportedUsage?: NormalizedUsage;
  /** False only when the branch has no request or metered-summary observations. Missing request telemetry still counts. */
  hasUsageObservations?: boolean;
  latestAssistantUsage?: NormalizedUsage;
}

/** @internal Lightweight metadata for one-to-many extension session projection. */
export interface SessionEntryProjectionMetadata {
  id: string;
  parentId: string | null;
  projectedEntryCount: number;
}

export const MAX_SESSION_RECORD_BYTES = SESSION_V4_MAX_RECORD_BYTES;
export const MAX_SESSION_FILE_BYTES = SESSION_V4_MAX_FILE_BYTES;
export const MAX_SESSION_ENTRY_COUNT = 100_000;

function openPersistentSession(file: string): {
  writer: SessionV4SyncWriter;
  lease: SessionWriterLease;
  logicalFileBytes: number;
} {
  if (activeSessionWriters.has(file)) {
    throw new Error(`Session file already has an active writer: ${file}`);
  }
  const lease = acquireSessionWriterLeaseSync(file);
  let writer: SessionV4SyncWriter | undefined;
  try {
    writer = SessionV4SyncWriter.open(file);
    lease.bindToFile();
    const count = writer.inspectState((state) => state.nodes.size);
    if (count > MAX_SESSION_ENTRY_COUNT) {
      throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${file}`);
    }
    return { writer, lease, logicalFileBytes: statSync(file).size };
  } catch (error) {
    try {
      writer?.close();
    } finally {
      lease.release();
    }
    throw error;
  }
}

function expandedPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function absolutePath(path: string): string {
  return resolve(expandedPath(path));
}

function agentDirectory(): string {
  return getAgentDir();
}

function preparePrivateSessionDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_SESSION_DIRECTORY_MODE });
  if (process.platform !== "win32") chmodSync(path, PRIVATE_SESSION_DIRECTORY_MODE);
}

function sessionsDirectory(): string {
  return getSessionsDir();
}

function uuidV7(): string {
  const time = BigInt(Date.now()).toString(16).padStart(12, "0").slice(-12);
  const random = randomBytes(10).toString("hex");
  const variant = (8 | (Number.parseInt(random[3] ?? "0", 16) & 3)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

function newSessionId(): string {
  return uuidV7();
}

export function assertValidSessionId(id: string): void {
  if (
    id.length > 256
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(id)
  ) {
    throw new Error(
      "Session id must use at most 256 letters, numbers, dots, underscores, and hyphens, with a letter or number at each end",
    );
  }
}

function shortEntryId(index: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID().slice(0, 8);
    if (!index.has(candidate)) return candidate;
  }
  return randomUUID();
}

function commitId(): string {
  return `commit-${randomUUID()}`;
}

function asJson(value: unknown): SessionV4Json {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Session value must be JSON-serializable");
  return JSON.parse(serialized) as SessionV4Json;
}

function asRecord(value: SessionV4Json): Record<string, SessionV4Json> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, SessionV4Json>
    : undefined;
}

function stringField(value: SessionV4Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanField(value: SessionV4Json | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberField(value: SessionV4Json | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function thinkingLevel(value: string): SessionV4ThinkingLevel {
  const levels: readonly SessionV4ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!levels.includes(value as SessionV4ThinkingLevel)) {
    throw new Error(`Invalid thinking level: ${value}`);
  }
  return value as SessionV4ThinkingLevel;
}

function messageRole(message: PersistedSessionMessage): string {
  return (message as { role?: unknown }).role as string;
}

function projectedMessageEntryCount(value: SessionV4Json, fallbackRole?: string): number {
  const stored = asRecord(value);
  const role = stringField(stored?.role) ?? fallbackRole;
  const content = stored?.content ?? (Array.isArray(value) ? value : undefined);
  if (role !== "tool" || !Array.isArray(content)) return 1;
  const count = content.filter((block) => stringField(asRecord(block)?.type) === "tool_result").length;
  return Math.max(1, count);
}

function projectedSessionEntryCount(node: SessionV4ConversationNode): number {
  if (node.nodeType === "message") return projectedMessageEntryCount(node.content, node.role);
  if (node.nodeType === "extension_context" && node.extensionId === MESSAGE_CUSTOM_EXTENSION) {
    return projectedMessageEntryCount(node.context);
  }
  return 1;
}

function isCanonicalRole(role: string): role is CanonicalMessage["role"] {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

export function sessionEntryToV4Node(
  entry: SessionEntry,
  cwd: string,
  operationId?: string,
): SessionV4ConversationNode {
  const base = {
    id: entry.id,
    parentId: entry.parentId,
    createdAt: entry.timestamp,
    ...(operationId === undefined ? {} : { operationId }),
  };
  switch (entry.type) {
    case "message": {
      const role = messageRole(entry.message);
      if (isCanonicalRole(role)) {
        return {
          ...base,
          nodeType: "message",
          role,
          content: asJson(entry.message),
        };
      }
      if (role === "bashExecution") {
        const execution = entry.message as BashExecutionMessage;
        return {
          ...base,
          nodeType: "shell",
          command: execution.command === "" ? "<empty>" : execution.command,
          cwd,
          result: asJson(execution),
        };
      }
      return {
        ...base,
        nodeType: "extension_context",
        extensionId: MESSAGE_CUSTOM_EXTENSION,
        context: asJson(entry.message),
      };
    }
    case "thinking_level_change":
      return {
        ...base,
        nodeType: "thinking_change",
        level: thinkingLevel(entry.thinkingLevel),
      };
    case "model_change":
      return {
        ...base,
        nodeType: "model_change",
        provider: entry.provider,
        model: entry.modelId,
      };
    case "compaction":
      return {
        ...base,
        nodeType: "compaction",
        summary: asJson({
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          ...(entry.details === undefined ? {} : { details: entry.details }),
          ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
          ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        }),
        retainedNodeIds: [entry.firstKeptEntryId],
      };
    case "branch_summary":
      return {
        ...base,
        nodeType: "extension_context",
        extensionId: BRANCH_SUMMARY_EXTENSION,
        context: asJson({
          fromId: entry.fromId,
          summary: entry.summary,
          ...(entry.details === undefined ? {} : { details: entry.details }),
          ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
          ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        }),
      };
    case "custom":
      if (entry.customType === TOOLS_CHANGE_CUSTOM_TYPE) {
        const data = entry.data === undefined ? undefined : asRecord(asJson(entry.data));
        const tools = data?.tools;
        const toolsetFingerprint = stringField(data?.toolsetFingerprint);
        if (
          !Array.isArray(tools)
          || tools.some((tool) => typeof tool !== "string")
          || toolsetFingerprint === undefined
        ) {
          throw new Error("A projected tools change must contain tool names and a toolset fingerprint");
        }
        return {
          ...base,
          nodeType: "tools_change",
          tools: [...tools] as string[],
          toolsetFingerprint,
        };
      }
      return {
        ...base,
        nodeType: "extension_state",
        extensionId: CUSTOM_ENTRY_EXTENSION,
        state: asJson({
          customType: entry.customType,
          ...(entry.data === undefined ? {} : { data: entry.data }),
        }),
      };
    case "custom_message":
      return {
        ...base,
        nodeType: "extension_context",
        extensionId: CUSTOM_MESSAGE_EXTENSION,
        context: asJson({
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          ...(entry.details === undefined ? {} : { details: entry.details }),
        }),
      };
    case "label":
    case "session_info":
      throw new Error(`${entry.type} is session state, not a conversation node`);
  }
}

function fallbackCanonicalMessage(node: Extract<SessionV4ConversationNode, { nodeType: "message" }>): CanonicalMessage {
  const content = Array.isArray(node.content)
    ? node.content
    : [{ type: "text", text: typeof node.content === "string" ? node.content : JSON.stringify(node.content) }];
  return {
    id: node.id,
    role: node.role,
    content: content as CanonicalMessage["content"],
    createdAt: node.createdAt,
  };
}

function projectedEntry(node: SessionV4ConversationNode): SessionEntry {
  const base = {
    id: node.id,
    parentId: node.parentId,
    timestamp: node.createdAt,
  };
  switch (node.nodeType) {
    case "message": {
      const stored = asRecord(node.content);
      const storedRole = stored === undefined ? undefined : stringField(stored.role);
      const message = storedRole !== undefined
        ? node.content as unknown as PersistedSessionMessage
        : fallbackCanonicalMessage(node);
      return { ...base, type: "message", message };
    }
    case "model_change":
      return {
        ...base,
        type: "model_change",
        provider: node.provider,
        modelId: node.model,
      };
    case "thinking_change":
      return {
        ...base,
        type: "thinking_level_change",
        thinkingLevel: node.level,
      };
    case "tools_change":
      return {
        ...base,
        type: "custom",
        customType: TOOLS_CHANGE_CUSTOM_TYPE,
        data: {
          tools: structuredClone(node.tools),
          toolsetFingerprint: node.toolsetFingerprint,
        },
      };
    case "compaction": {
      const summary = asRecord(node.summary);
      const fromHook = booleanField(summary?.fromHook);
      return {
        ...base,
        type: "compaction",
        summary: stringField(summary?.summary)
          ?? (typeof node.summary === "string" ? node.summary : JSON.stringify(node.summary)),
        firstKeptEntryId: stringField(summary?.firstKeptEntryId)
          ?? node.retainedNodeIds[0]
          ?? node.parentId
          ?? node.id,
        tokensBefore: numberField(summary?.tokensBefore) ?? 0,
        ...(summary?.details === undefined ? {} : { details: structuredClone(summary.details) }),
        ...(fromHook === undefined ? {} : { fromHook }),
        ...(summary?.usage === undefined ? {} : { usage: structuredClone(summary.usage) as unknown as NormalizedUsage }),
      };
    }
    case "branch_summary": {
      const summary = asRecord(node.summary);
      const fromHook = booleanField(summary?.fromHook);
      return {
        ...base,
        type: "branch_summary",
        fromId: node.fromNodeId,
        summary: stringField(summary?.summary)
          ?? (typeof node.summary === "string" ? node.summary : JSON.stringify(node.summary)),
        ...(summary?.details === undefined ? {} : { details: structuredClone(summary.details) }),
        ...(fromHook === undefined ? {} : { fromHook }),
        ...(summary?.usage === undefined ? {} : { usage: structuredClone(summary.usage) as unknown as NormalizedUsage }),
      };
    }
    case "extension_context": {
      const value = asRecord(node.context);
      if (node.extensionId === CUSTOM_MESSAGE_EXTENSION && value !== undefined) {
        return {
          ...base,
          type: "custom_message",
          customType: stringField(value.customType) ?? node.extensionId,
          content: (value.content ?? "") as string | (TextBlock | ImageBlock)[],
          display: booleanField(value.display) ?? false,
          ...(value.details === undefined ? {} : { details: structuredClone(value.details) }),
        };
      }
      if (node.extensionId === BRANCH_SUMMARY_EXTENSION && value !== undefined) {
        const fromHook = booleanField(value.fromHook);
        return {
          ...base,
          type: "branch_summary",
          fromId: stringField(value.fromId) ?? node.parentId ?? "root",
          summary: stringField(value.summary) ?? "",
          ...(value.details === undefined ? {} : { details: structuredClone(value.details) }),
          ...(fromHook === undefined ? {} : { fromHook }),
          ...(value.usage === undefined ? {} : { usage: structuredClone(value.usage) as unknown as NormalizedUsage }),
        };
      }
      if (node.extensionId === MESSAGE_CUSTOM_EXTENSION && value !== undefined) {
        return {
          ...base,
          type: "message",
          message: structuredClone(value) as unknown as PersistedSessionMessage,
        };
      }
      return {
        ...base,
        type: "custom",
        customType: node.extensionId,
        data: structuredClone(node.context),
      };
    }
    case "extension_state": {
      const value = asRecord(node.state);
      if (node.extensionId === CUSTOM_ENTRY_EXTENSION && value !== undefined) {
        return {
          ...base,
          type: "custom",
          customType: stringField(value.customType) ?? node.extensionId,
          ...(value.data === undefined ? {} : { data: structuredClone(value.data) }),
        };
      }
      return {
        ...base,
        type: "custom",
        customType: node.extensionId,
        data: structuredClone(node.state),
      };
    }
    case "shell": {
      const value = asRecord(node.result);
      if (stringField(value?.role) === "bashExecution") {
        return {
          ...base,
          type: "message",
          message: structuredClone(value) as unknown as BashExecutionMessage,
        };
      }
      return {
        ...base,
        type: "custom",
        customType: "rigyn.session.shell",
        data: {
          command: node.command,
          cwd: node.cwd,
          result: structuredClone(node.result),
        },
      };
    }
  }
}

function boundedStoredUsage(value: unknown): NormalizedUsage | undefined {
  if (!isNormalizedUsage(value)) return undefined;
  const { raw: _raw, ...usage } = value;
  return structuredClone(usage);
}

function nodeUsage(node: SessionV4ConversationNode): {
  kind: "assistant" | "summary" | "tool";
  meteredWithoutUsage?: boolean;
  stopReason?: unknown;
  usage?: NormalizedUsage;
} | undefined {
  if (node.nodeType === "message") {
    const message = asRecord(node.content);
    const usage = boundedStoredUsage(message?.usage);
    const role = stringField(message?.role) ?? node.role;
    if (role !== "assistant" && (role !== "tool" || usage === undefined)) return undefined;
    return {
      kind: role,
      ...(message?.stopReason === undefined ? {} : { stopReason: message.stopReason }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (node.nodeType === "compaction" || node.nodeType === "branch_summary") {
    const summary = asRecord(node.summary);
    const usage = boundedStoredUsage(summary?.usage);
    return {
      kind: "summary",
      ...(summary?.fromHook === true && usage === undefined ? { meteredWithoutUsage: false } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (node.nodeType === "extension_context" && node.extensionId === BRANCH_SUMMARY_EXTENSION) {
    const summary = asRecord(node.context);
    const usage = boundedStoredUsage(summary?.usage);
    return {
      kind: "summary",
      ...(summary?.fromHook === true && usage === undefined ? { meteredWithoutUsage: false } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return undefined;
}

function messageText(message: PersistedSessionMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => block !== null && typeof block === "object" && block.type === "text" ? [block.text] : [])
    .join(" ");
}

function isConversationalMessage(message: PersistedSessionMessage): boolean {
  const role = messageRole(message);
  return role === "user" || role === "assistant";
}

function messageActivity(entry: SessionMessageEntry): number | undefined {
  if (!isConversationalMessage(entry.message)) return undefined;
  const numeric = (entry.message as { timestamp?: unknown }).timestamp;
  if (typeof numeric === "number") return numeric;
  const parsed = new Date(entry.timestamp).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isSystemMessageEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & { message: CanonicalMessage } {
  return entry.type === "message" && messageRole(entry.message) === "system";
}

function isInstructionMessageEntry(entry: SessionEntry): boolean {
  return isSystemMessageEntry(entry) && entry.message.purpose === "instructions";
}

function pathToLeaf(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionEntry[] {
  if (leafId === null) return [];
  const index = suppliedIndex ?? new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId === undefined ? entries.at(-1) : index.get(leafId);
  if (current === undefined) current = entries.at(-1);
  if (current === undefined) return [];

  const reversed: SessionEntry[] = [];
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : index.get(current.parentId);
  }
  return reversed.reverse();
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return entry;
  }
  return null;
}

export function buildContextEntries(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionEntry[] {
  const path = pathToLeaf(entries, leafId, suppliedIndex);
  const compaction = getLatestCompactionEntry(path);
  if (compaction === null) return path;
  const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
  if (compactionIndex < 0) return path;

  const beforeCompaction = path.slice(0, compactionIndex);
  const latestInstructionId = beforeCompaction.findLast(isInstructionMessageEntry)?.id;
  const systemEntries = beforeCompaction.filter((entry) =>
    isSystemMessageEntry(entry)
    && (!isInstructionMessageEntry(entry) || entry.id === latestInstructionId));
  const result: SessionEntry[] = [...systemEntries, compaction];
  let keep = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index] as SessionEntry;
    if (entry.id === compaction.firstKeptEntryId) keep = true;
    if (keep && entry.type !== "compaction" && !isSystemMessageEntry(entry)) result.push(entry);
  }
  result.push(...path.slice(compactionIndex + 1));
  return result;
}

function customContextMessage(entry: CustomMessageEntry): CustomMessage {
  const base: CustomMessage = {
    role: "custom",
    customType: entry.customType,
    content: entry.content ?? [],
    display: entry.display,
    timestamp: new Date(entry.timestamp).getTime(),
  };
  return entry.details === undefined ? base : { ...base, details: entry.details };
}

export function sessionEntryToContextMessages(entry: SessionEntry): SessionContextMessage[] {
  if (entry.type === "message") {
    const message = entry.message as PersistedSessionMessage & { content?: unknown };
    const role = messageRole(message);
    if (["user", "assistant", "tool", "toolResult"].includes(role) && message.content == null) {
      return [{ ...message, content: [] } as PersistedSessionMessage];
    }
    return [message];
  }
  if (entry.type === "custom_message") return [customContextMessage(entry)];
  if (entry.type === "branch_summary" && entry.summary !== "") {
    const message: BranchSummaryMessage = {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    };
    return [message];
  }
  if (entry.type === "compaction") {
    const message: CompactionSummaryMessage = {
      role: "compactionSummary",
      tokensBefore: entry.tokensBefore,
      summary: entry.summary,
      timestamp: new Date(entry.timestamp).getTime(),
      ...(entry.usage === undefined ? {} : { usage: structuredClone(entry.usage) }),
    };
    return [message];
  }
  return [];
}

function contextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
  let selectedThinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") selectedThinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
  }
  return { thinkingLevel: selectedThinkingLevel, model };
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionContext {
  const settings = contextSettings(pathToLeaf(entries, leafId, suppliedIndex));
  return {
    messages: buildContextEntries(entries, leafId, suppliedIndex).flatMap(sessionEntryToContextMessages),
    thinkingLevel: settings.thinkingLevel,
    model: settings.model,
  };
}

function defaultSessionDirPath(cwd: string, agentDir = agentDirectory()): string {
  const normalized = filesystemPathIdentity(cwd);
  const flattened = normalized
    .replace(/^[/\\]+/u, "")
    .replaceAll(/[/\\:]+/gu, "-")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const slug = (flattened || "workspace").slice(-SESSION_DIRECTORY_SLUG_LENGTH);
  const identity = createHash("sha256").update(normalized, "utf8").digest("hex");
  const safe = `--${slug}-${identity}--`;
  return join(absolutePath(agentDir), "sessions", safe);
}

export function getDefaultSessionDir(cwd: string, agentDir = agentDirectory()): string {
  const root = absolutePath(agentDir);
  preparePrivateSessionDirectory(root);
  const path = defaultSessionDirPath(cwd, root);
  preparePrivateSessionDirectory(dirname(path));
  preparePrivateSessionDirectory(path);
  return path;
}

function stateFromFile(
  path: string,
  followSymlinks = true,
): { state: SessionV4State; committedBytes: number } {
  const result = readSessionV4FileSync(path, { followSymlinks });
  if (result.state.nodes.size > MAX_SESSION_ENTRY_COUNT) {
    throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${path}`);
  }
  return { state: result.state, committedBytes: result.committedBytes };
}

function headerFromFile(path: string): { header: SessionV4Header; modified: number } {
  const fd = openSync(
    path,
    constants.O_RDONLY | SESSION_READ_NONBLOCK | SESSION_READ_NOFOLLOW,
  );
  try {
    const details = fstatSync(fd);
    if (!details.isFile()) throw new Error(`Session path is not a regular file: ${path}`);
    if (details.size > MAX_SESSION_FILE_BYTES) {
      throw new Error(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}: ${path}`);
    }
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= MAX_SESSION_RECORD_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(4_096, MAX_SESSION_RECORD_BYTES + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (count === 0) throw new Error(`Session header is not LF-terminated: ${path}`);
      const selected = chunk.subarray(0, count);
      const newline = selected.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(selected.subarray(0, newline));
        const line = Buffer.concat(chunks).toString("utf8");
        return { header: parseSessionV4Header(JSON.parse(line) as unknown), modified: details.mtimeMs };
      }
      chunks.push(selected);
      length += count;
    }
    throw new Error(`Session header exceeds the limit of ${MAX_SESSION_RECORD_BYTES}: ${path}`);
  } finally {
    closeSync(fd);
  }
}

function projectedHeader(header: SessionV4Header): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: header.sessionId,
    timestamp: header.createdAt,
    cwd: header.cwd,
    ...(header.parent === undefined ? {} : { parentSession: header.parent.sessionId }),
  };
}

function parentFromReference(reference: string | undefined, childId: string, purpose: string): SessionV4Parent | undefined {
  if (reference === undefined) return undefined;
  let sessionId = reference;
  const candidate = absolutePath(reference);
  if (existsSync(candidate)) sessionId = stateFromFile(candidate).state.header.sessionId;
  if (sessionId === childId) throw new Error("A session cannot be its own parent");
  return { sessionId, purpose };
}

function createHeader(
  id: string,
  timestamp: string,
  cwd: string,
  parent: SessionV4Parent | undefined,
): SessionV4Header {
  return {
    record: "session",
    version: SESSION_V4_VERSION,
    sessionId: id,
    createdAt: timestamp,
    workspace: cwd,
    cwd,
    ...(parent === undefined ? {} : { parent }),
  };
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCwd(candidate: string | undefined, cwd: string): boolean {
  return candidate !== undefined && candidate !== "" && sameFilesystemPath(candidate, cwd);
}

export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
  for (const candidate of recentSessionCandidates(sessionDir, cwd)) {
    try {
      stateFromFile(candidate.path, false);
      return candidate.path;
    } catch {}
  }
  return null;
}

function recentSessionCandidates(sessionDir: string, cwd?: string): Array<{ path: string; modified: number }> {
  const directory = absolutePath(sessionDir);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name))
      .flatMap((path) => {
        try {
          const { header, modified } = headerFromFile(path);
          if (cwd !== undefined && !sameCwd(header.cwd, cwd)) return [];
          return [{ path, modified }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.modified - left.modified || comparePath(left.path, right.path));
  } catch {
    return [];
  }
}

async function readSessionInfo(path: string, followSymlinks = true): Promise<SessionInfo> {
  const [details, loaded] = await Promise.all([
    stat(path),
    readSessionV4File(path, { followSymlinks }),
  ]);
  const state = loaded.state;
  if (state.nodes.size > MAX_SESSION_ENTRY_COUNT) {
    throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${path}`);
  }
  const entries = [...state.nodes.values()].map(projectedEntry);
  let first = "";
  let lastActivity: number | undefined;
  const searchable: string[] = [];
  let messageCount = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    messageCount += 1;
    const activity = messageActivity(entry);
    if (activity !== undefined) lastActivity = Math.max(lastActivity ?? 0, activity);
    if (!isConversationalMessage(entry.message)) continue;
    const text = messageText(entry.message);
    if (text === "") continue;
    searchable.push(text);
    if (first === "" && messageRole(entry.message) === "user") first = text;
  }

  const headerTime = new Date(state.header.createdAt).getTime();
  const modified = lastActivity !== undefined && lastActivity > 0
    ? new Date(lastActivity)
    : Number.isNaN(headerTime) ? details.mtime : new Date(headerTime);
  return {
    path,
    id: state.header.sessionId,
    cwd: state.header.cwd,
    created: new Date(state.header.createdAt),
    modified,
    messageCount,
    firstMessage: first || "(no messages)",
    allMessagesText: searchable.join(" "),
    ...(state.name === null ? {} : { name: state.name }),
    ...(state.header.parent === undefined ? {} : { parentSessionPath: state.header.parent.sessionId }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSessionInfos(files: string[], onLoaded: () => void): Promise<SessionScanResult> {
  const results: Array<SessionInfo | SessionFileIssue | undefined> = Array.from({ length: files.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(INFO_READ_CONCURRENCY, files.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      if (file === undefined) return;
      try {
        results[index] = await readSessionInfo(file, false);
      } catch (error) {
        results[index] = { path: file, error: errorText(error) };
      } finally {
        onLoaded();
      }
    }
  });
  await Promise.all(workers);
  return {
    sessions: results.filter((result): result is SessionInfo => result !== undefined && !("error" in result)),
    invalid: results.filter((result): result is SessionFileIssue => result !== undefined && "error" in result),
  };
}

async function scanDirectory(directory: string, progress?: SessionListProgress): Promise<SessionScanResult> {
  if (!existsSync(directory)) return { sessions: [], invalid: [] };
  try {
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(directory, name));
    let loaded = 0;
    return await loadSessionInfos(files, () => {
      loaded += 1;
      progress?.(loaded, files.length);
    });
  } catch (error) {
    return { sessions: [], invalid: [{ path: directory, error: errorText(error) }] };
  }
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.sort((left, right) =>
    right.modified.getTime() - left.modified.getTime() || comparePath(left.path, right.path));
}

async function scanAllSessions(
  customDirectory: string | undefined,
  progress?: SessionListProgress,
): Promise<SessionScanResult> {
  if (customDirectory !== undefined) return await scanDirectory(customDirectory, progress);
  const root = sessionsDirectory();
  if (!existsSync(root)) return { sessions: [], invalid: [] };

  let directories: string[];
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort(comparePath);
  } catch (error) {
    return { sessions: [], invalid: [{ path: root, error: errorText(error) }] };
  }

  const files: string[] = [];
  const invalid: SessionFileIssue[] = [];
  for (const directory of directories) {
    try {
      files.push(...(await readdir(directory))
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(directory, name)));
    } catch (error) {
      invalid.push({ path: directory, error: errorText(error) });
    }
  }

  let loaded = 0;
  const scanned = await loadSessionInfos(files, () => {
    loaded += 1;
    progress?.(loaded, files.length);
  });
  return { sessions: scanned.sessions, invalid: [...invalid, ...scanned.invalid] };
}

interface SessionManagerInitialization {
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  persist: boolean;
  newSessionOptions?: NewSessionOptions;
  snapshotState?: SessionV4State;
  snapshotBytes?: number;
  freshSession?: { header: SessionV4Header; path?: string };
  openedSession?: {
    file: string;
    writer: SessionV4SyncWriter;
    lease: SessionWriterLease;
    logicalFileBytes: number;
  };
}

interface SessionV4RecoverySnapshot {
  openOperation: SessionV4State["operations"] extends Map<string, infer T> ? T | null : never;
  queue: Array<SessionV4State["queue"] extends Map<string, infer T> ? T : never>;
  toolEffects: Array<SessionV4State["toolEffects"] extends Map<string, infer T> ? T : never>;
}

function primaryBranch(state: SessionV4State): SessionV4State["branches"] extends Map<string, infer T> ? T : never {
  const branch = state.branches.get(state.primaryBranchId);
  if (branch === undefined) throw new Error(`Session branch ${state.primaryBranchId} is missing`);
  return branch;
}

function labelTimestamps(state: SessionV4State): Map<string, string> {
  const timestamps = new Map<string, string>();
  for (const commit of state.commits.values()) {
    for (const change of commit.changes) {
      if (change.type !== "node_label") continue;
      if (change.label === null) timestamps.delete(change.nodeId);
      else timestamps.set(change.nodeId, commit.committedAt);
    }
  }
  return timestamps;
}

function absoluteNodeDepth(
  state: SessionV4State,
  id: string,
  known: Map<string, number>,
): number {
  const cached = known.get(id);
  if (cached !== undefined) return cached;
  const path: string[] = [];
  const encountered = new Set<string>();
  let cursor = state.nodes.get(id);
  let depth = 0;
  while (cursor !== undefined && !encountered.has(cursor.id)) {
    const parentDepth = known.get(cursor.id);
    if (parentDepth !== undefined) {
      depth = parentDepth;
      break;
    }
    encountered.add(cursor.id);
    path.push(cursor.id);
    if (cursor.parentId === null) {
      depth = -1;
      break;
    }
    cursor = state.nodes.get(cursor.parentId);
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    depth += 1;
    known.set(path[index]!, depth);
  }
  return known.get(id) ?? 0;
}

export class SessionManager {
  private sessionId = "";
  private sessionFile: string | undefined;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private readonly persist: boolean;
  private readonly snapshotOnly: boolean;
  private writer: SessionV4SyncWriter | undefined;
  private writerLease: SessionWriterLease | undefined;
  private memoryState: SessionV4State | undefined;
  private logicalFileBytes = 0;
  private entryOrderCache: { ids: string[]; sequence: Map<string, number> } | undefined;
  private readonly appendListeners = new Set<(entry: Readonly<SessionEntry>) => void>();

  private constructor(initialization: SessionManagerInitialization) {
    this.cwd = absolutePath(initialization.cwd);
    this.sessionDir = initialization.sessionDir === "" ? "" : absolutePath(initialization.sessionDir);
    this.persist = initialization.persist;
    this.snapshotOnly = initialization.snapshotState !== undefined;
    if (this.persist && !existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true, mode: PRIVATE_SESSION_DIRECTORY_MODE });
    }
    if (initialization.snapshotState !== undefined) {
      this.sessionFile = initialization.sessionFile;
      this.sessionId = initialization.snapshotState.header.sessionId;
      this.memoryState = cloneSessionV4State(initialization.snapshotState);
      this.logicalFileBytes = initialization.snapshotBytes ?? 0;
      return;
    }
    if (initialization.openedSession !== undefined) {
      const opened = initialization.openedSession;
      this.sessionFile = opened.file;
      this.writer = opened.writer;
      this.writerLease = opened.lease;
      this.sessionId = opened.writer.inspectState((state) => state.header.sessionId);
      this.logicalFileBytes = opened.logicalFileBytes;
      activeSessionWriters.add(opened.file);
      return;
    }
    if (initialization.freshSession !== undefined) {
      this.installFresh(initialization.freshSession.header, initialization.freshSession.path);
      return;
    }
    if (initialization.sessionFile === undefined) this.newSession(initialization.newSessionOptions);
    else this.setFile(initialization.sessionFile);
  }

  /** Runs a synchronous trusted read without exposing the owned state publicly. */
  private inspectState<T>(inspect: (state: SessionV4State) => T): T {
    if (this.writer !== undefined) return this.writer.inspectState(inspect);
    if (this.memoryState !== undefined) return inspect(this.memoryState);
    throw new Error("Session store is not initialized");
  }

  private releaseOwnedWriter(
    writer: SessionV4SyncWriter | undefined,
    lease: SessionWriterLease | undefined,
  ): void {
    if (writer !== undefined) activeSessionWriters.delete(writer.path);
    try {
      writer?.close();
    } finally {
      lease?.release();
    }
  }

  private releaseWriter(): void {
    const writer = this.writer;
    const lease = this.writerLease;
    this.writer = undefined;
    this.writerLease = undefined;
    this.entryOrderCache = undefined;
    this.releaseOwnedWriter(writer, lease);
  }

  private adoptCandidate(candidate: SessionManager): void {
    const previousWriter = this.writer;
    const previousLease = this.writerLease;
    this.sessionId = candidate.sessionId;
    this.sessionFile = candidate.sessionFile;
    this.writer = candidate.writer;
    this.writerLease = candidate.writerLease;
    this.memoryState = candidate.memoryState;
    this.logicalFileBytes = candidate.logicalFileBytes;
    this.entryOrderCache = candidate.entryOrderCache;
    candidate.writer = undefined;
    candidate.writerLease = undefined;
    candidate.memoryState = undefined;
    candidate.entryOrderCache = undefined;
    this.releaseOwnedWriter(previousWriter, previousLease);
  }

  private freshCandidate(header: SessionV4Header, path: string | undefined): SessionManager {
    return new SessionManager({
      cwd: this.cwd,
      sessionDir: this.sessionDir,
      persist: this.persist,
      freshSession: { header, ...(path === undefined ? {} : { path }) },
    });
  }

  private installFresh(header: SessionV4Header, path: string | undefined): void {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    if (this.persist) {
      if (path === undefined) throw new Error("Persistent sessions require a file path");
      const file = absolutePath(path);
      if (activeSessionWriters.has(file)) {
        throw new Error(`Session file already has an active writer: ${file}`);
      }
      const lease = acquireSessionWriterLeaseSync(file);
      let writer: SessionV4SyncWriter;
      try {
        writer = SessionV4SyncWriter.create(file, header);
        try {
          lease.bindToFile();
        } catch (error) {
          writer.close();
          throw error;
        }
      } catch (error) {
        lease.release();
        throw error;
      }
      const previousWriter = this.writer;
      const previousLease = this.writerLease;
      this.sessionId = header.sessionId;
      this.sessionFile = file;
      this.writer = writer;
      this.writerLease = lease;
      this.memoryState = undefined;
      this.logicalFileBytes = Buffer.byteLength(`${JSON.stringify(header)}\n`, "utf8");
      this.entryOrderCache = undefined;
      activeSessionWriters.add(file);
      this.releaseOwnedWriter(previousWriter, previousLease);
      return;
    }
    const state = createSessionV4State(header);
    const previousWriter = this.writer;
    const previousLease = this.writerLease;
    this.sessionId = header.sessionId;
    this.sessionFile = undefined;
    this.writer = undefined;
    this.writerLease = undefined;
    this.memoryState = state;
    this.logicalFileBytes = Buffer.byteLength(`${JSON.stringify(header)}\n`, "utf8");
    this.entryOrderCache = undefined;
    this.releaseOwnedWriter(previousWriter, previousLease);
  }

  private setFile(path: string): void {
    const file = absolutePath(path);
    if (this.writer?.path === file) return;
    if (!existsSync(file)) {
      const id = newSessionId();
      const timestamp = new Date().toISOString();
      this.installFresh(createHeader(id, timestamp, this.cwd, undefined), file);
      return;
    }
    const opened = openPersistentSession(file);
    const sessionId = opened.writer.inspectState((state) => state.header.sessionId);
    const previousWriter = this.writer;
    const previousLease = this.writerLease;
    this.sessionFile = file;
    this.writer = opened.writer;
    this.writerLease = opened.lease;
    activeSessionWriters.add(file);
    this.memoryState = undefined;
    this.sessionId = sessionId;
    this.logicalFileBytes = opened.logicalFileBytes;
    this.entryOrderCache = undefined;
    this.releaseOwnedWriter(previousWriter, previousLease);
  }

  setSessionFile(path: string): void {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    this.setFile(path);
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    if (options?.id !== undefined) assertValidSessionId(options.id);
    const id = options?.id ?? newSessionId();
    const timestamp = new Date().toISOString();
    const header = createHeader(
      id,
      timestamp,
      this.cwd,
      parentFromReference(options?.parentSession, id, "linked"),
    );
    const path = this.persist
      ? join(this.sessionDir, `${timestamp.replace(/[:.]/gu, "-")}_${id}.jsonl`)
      : undefined;
    this.installFresh(header, path);
    return this.sessionFile;
  }

  /** @internal Commits one validated atomic session transition. */
  commitChanges(
    changes: SessionV4Changes,
    id = commitId(),
    committedAt = new Date().toISOString(),
  ): SessionV4Commit {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    const newNodeIds = new Set(
      changes.flatMap((change) => change.type === "conversation_node" ? [change.node.id] : []),
    );
    const before = this.inspectState((state) => {
      let addedNodes = 0;
      for (const nodeId of newNodeIds) if (!state.nodes.has(nodeId)) addedNodes += 1;
      return {
        sequence: state.sequence,
        existing: state.commits.get(id),
        nodeCount: state.nodes.size,
        addedNodes,
      };
    });
    const existing = before.existing;
    if (
      existing !== undefined
      && existing.committedAt === committedAt
      && isDeepStrictEqual(existing.changes, changes)
    ) {
      return structuredClone(existing);
    }
    const candidate: SessionV4Commit = {
      record: "commit",
      sequence: before.sequence + 1,
      commitId: id,
      committedAt,
      changes: structuredClone(changes),
    };
    const recordBytes = Buffer.byteLength(`${JSON.stringify(candidate)}\n`, "utf8");
    if (this.writer === undefined && recordBytes - 1 > MAX_SESSION_RECORD_BYTES) {
      throw new Error(`Session record exceeds the limit of ${MAX_SESSION_RECORD_BYTES}`);
    }
    if (before.nodeCount + before.addedNodes > MAX_SESSION_ENTRY_COUNT) {
      throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}`);
    }
    if (this.writer === undefined && this.logicalFileBytes + recordBytes > MAX_SESSION_FILE_BYTES) {
      throw new Error(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}`);
    }

    let commit: SessionV4Commit;
    let applied: boolean;
    if (this.writer === undefined) {
      if (this.memoryState === undefined) throw new Error("Session store is not initialized");
      applied = applySessionV4CommitOwned(this.memoryState, candidate);
      commit = candidate;
    } else {
      commit = this.writer.append({ commitId: id, committedAt, changes: structuredClone(changes) });
      applied = this.inspectState((state) => state.sequence !== before.sequence);
    }
    if (applied) {
      this.logicalFileBytes += recordBytes;
      for (const change of changes) {
        if (change.type !== "conversation_node") continue;
        const entry = projectedEntry(change.node);
        for (const listener of [...this.appendListeners]) {
          try {
            listener(structuredClone(entry));
          } catch {
            // The commit is durable before observers run.
          }
        }
      }
    }
    return structuredClone(commit);
  }

  /** @internal Returns a detached snapshot for the owning AgentSession. */
  getV4State(): SessionV4State {
    return this.inspectState(cloneSessionV4State);
  }

  /** @internal Returns only work that may require recovery after reopening. */
  getV4RecoverySnapshot(): SessionV4RecoverySnapshot {
    return this.inspectState((state) => {
      const branch = primaryBranch(state);
      const openOperation = branch.openOperationId === null
        ? null
        : structuredClone(state.operations.get(branch.openOperationId) ?? null);
      return {
        openOperation,
        queue: [...state.queue.values()]
          .filter((entry) => entry.status === "queued" || entry.status === "claimed")
          .map((entry) => structuredClone(entry)),
        toolEffects: [...state.toolEffects.values()]
          .filter((effect) => openOperation !== null && effect.operationId === openOperation.id)
          .map((effect) => structuredClone(effect)),
      };
    });
  }

  /** @internal Releases the durable writer owned by this manager. */
  closeV4Store(): void {
    this.releaseWriter();
  }

  /** Observes successfully committed conversation entries without exposing mutable storage state. */
  onAppend(listener: (entry: Readonly<SessionEntry>) => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  private entries(): SessionEntry[] {
    return this.inspectState((state) => [...state.nodes.values()].map(projectedEntry));
  }

  private entryBase<T extends SessionEntry["type"]>(
    type: T,
    options: { nodeId?: string; parentId?: string | null } = {},
  ): { type: T; id: string; parentId: string | null; timestamp: string } {
    return this.inspectState((state) => ({
      type,
      id: options.nodeId ?? shortEntryId(state.nodes),
      parentId: options.parentId === undefined ? primaryBranch(state).headNodeId : options.parentId,
      timestamp: new Date().toISOString(),
    }));
  }

  private appendEntry(entry: SessionEntry, operationId?: string): string {
    const node = sessionEntryToV4Node(entry, this.cwd, operationId);
    this.commitChanges([
      { type: "conversation_node", node },
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
    ]);
    return node.id;
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  usesDefaultSessionDir(): boolean {
    return sameFilesystemPath(this.sessionDir, defaultSessionDirPath(this.cwd));
  }

  appendMessage(
    message: PersistedSessionMessage,
    options: { nodeId?: string; operationId?: string; parentId?: string | null } = {},
  ): string {
    return this.appendEntry({
      ...this.entryBase("message", options),
      message: structuredClone(message),
    }, options.operationId);
  }

  appendThinkingLevelChange(selectedThinkingLevel: string, operationId?: string): string {
    const entry: ThinkingLevelChangeEntry = {
      ...this.entryBase("thinking_level_change"),
      thinkingLevel: selectedThinkingLevel,
    };
    return this.appendEntry(entry, operationId);
  }

  appendModelChange(provider: string, modelId: string, operationId?: string): string {
    const entry: ModelChangeEntry = { ...this.entryBase("model_change"), provider, modelId };
    return this.appendEntry(entry, operationId);
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: NormalizedUsage,
    operationId?: string,
  ): string {
    if (!this.inspectState((state) => state.nodes.has(firstKeptEntryId))) {
      throw new Error(`Entry ${firstKeptEntryId} not found`);
    }
    const entry: CompactionEntry<T> = {
      ...this.entryBase("compaction"),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(usage === undefined ? {} : { usage: structuredClone(usage) }),
      ...(details === undefined ? {} : { details }),
      ...(fromHook === undefined ? {} : { fromHook }),
    };
    return this.appendEntry(entry, operationId);
  }

  appendCustomEntry<T = unknown>(customType: string, data?: T, operationId?: string): string {
    const entry: CustomEntry<T> = {
      ...this.entryBase("custom"),
      customType,
      ...(data === undefined ? {} : { data }),
    };
    return this.appendEntry(entry, operationId);
  }

  appendSessionInfo(name: string): string {
    const normalized = name.replace(/[\r\n]+/gu, " ").trim();
    return this.commitChanges([{ type: "session_name", name: normalized === "" ? null : normalized }]).commitId;
  }

  getSessionName(): string | undefined {
    return this.inspectState((state) => state.name ?? undefined);
  }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextBlock | ImageBlock)[],
    display: boolean,
    details?: T,
    options: { nodeId?: string; operationId?: string; parentId?: string | null } = {},
  ): string {
    const entry: CustomMessageEntry<T> = {
      ...this.entryBase("custom_message", options),
      customType,
      content: structuredClone(content),
      display,
      ...(details === undefined ? {} : { details }),
    };
    return this.appendEntry(entry, options.operationId);
  }

  getLeafId(): string | null {
    return this.inspectState((state) => primaryBranch(state).headNodeId);
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.inspectState((state) => {
      const leaf = primaryBranch(state).headNodeId;
      const node = leaf === null ? undefined : state.nodes.get(leaf);
      return node === undefined ? undefined : structuredClone(projectedEntry(node));
    });
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.inspectState((state) => {
      const node = state.nodes.get(id);
      return node === undefined ? undefined : structuredClone(projectedEntry(node));
    });
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.inspectState((state) =>
      [...state.nodes.values()]
        .filter((node) => node.parentId === parentId)
        .map((node) => structuredClone(projectedEntry(node))));
  }

  getLabel(id: string): string | undefined {
    return this.inspectState((state) => state.labels.get(id));
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.inspectState((state) => state.nodes.has(targetId))) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const normalized = label?.trim();
    return this.commitChanges([{
      type: "node_label",
      nodeId: targetId,
      label: normalized === undefined || normalized === "" ? null : normalized,
    }]).commitId;
  }

  getBranch(fromId?: string): SessionEntry[] {
    return this.inspectState((state) => {
      const start = fromId ?? primaryBranch(state).headNodeId;
      const newestFirst: SessionEntry[] = [];
      const encountered = new Set<string>();
      for (
        let cursor = start === null ? undefined : state.nodes.get(start);
        cursor !== undefined && !encountered.has(cursor.id);
        cursor = cursor.parentId === null ? undefined : state.nodes.get(cursor.parentId)
      ) {
        encountered.add(cursor.id);
        newestFirst.push(projectedEntry(cursor));
      }
      return structuredClone(newestFirst.toReversed());
    });
  }

  findEntriesOnBranch(query: SessionBranchQuery = {}): SessionEntry[] {
    validateSessionBranchQuery(query);
    const start = query.start === undefined ? this.getLeafId() : query.start;
    if (start === null) return [];
    const path = this.getBranch(start);
    if (path.length === 0) throw new Error(`Entry ${start} not found`);
    return selectSessionBranchEntries(path, query);
  }

  findEntryOnBranch(query: SessionBranchQuery = {}): SessionEntry | undefined {
    return this.findEntriesOnBranch({ ...query, limit: 1 })[0];
  }

  /** Usage on the active lineage without cloning stored message or tool payloads. */
  getActiveBranchUsage(): ActiveBranchUsage {
    return this.inspectState((state) => {
      let aggregate: NormalizedUsage | undefined;
      let reported: NormalizedUsage | undefined;
      let latestAssistantUsage: NormalizedUsage | undefined;
      let latestAssistantObserved = false;
      let hasUsageObservations = false;
      const encountered = new Set<string>();
      const headId = primaryBranch(state).headNodeId;
      for (
        let cursor = headId === null ? undefined : state.nodes.get(headId);
        cursor !== undefined && !encountered.has(cursor.id);
        cursor = cursor.parentId === null ? undefined : state.nodes.get(cursor.parentId)
      ) {
        encountered.add(cursor.id);
        const observed = nodeUsage(cursor);
        if (observed === undefined) continue;
        const successfulAssistant = observed.kind === "assistant"
          && observed.stopReason !== "cancelled"
          && observed.stopReason !== "aborted"
          && observed.stopReason !== "error";
        if (
          observed.usage !== undefined
          || successfulAssistant
          || (observed.kind === "summary" && observed.meteredWithoutUsage !== false)
        ) {
          hasUsageObservations = true;
          aggregate = addCompleteNormalizedUsage(aggregate, observed.usage ?? {});
          reported = addNormalizedUsage(reported, observed.usage ?? {});
        }
        if (
          !latestAssistantObserved
          && successfulAssistant
        ) {
          latestAssistantObserved = true;
          latestAssistantUsage = observed.usage;
        }
      }
      const usage = aggregate ?? {};
      const reportedUsage = reported ?? {};
      const reportedFields = [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "cacheWrite1hTokens",
        "reasoningTokens",
        "serverToolCalls",
        "durationMs",
      ] as const;
      const hasReportedFallback = reportedFields.some(
        (field) => usage[field] === undefined && reportedUsage[field] !== undefined,
      ) || (usage.cost === undefined && reportedUsage.cost !== undefined);
      return {
        usage,
        ...(hasReportedFallback ? { reportedUsage } : {}),
        hasUsageObservations,
        ...(latestAssistantUsage === undefined ? {} : { latestAssistantUsage }),
      };
    });
  }

  buildContextEntries(): SessionEntry[] {
    const entries = this.entries();
    return structuredClone(buildContextEntries(entries, this.getLeafId(), new Map(entries.map((entry) => [entry.id, entry]))));
  }

  buildSessionContext(): SessionContext {
    const entries = this.entries();
    return structuredClone(buildSessionContext(entries, this.getLeafId(), new Map(entries.map((entry) => [entry.id, entry]))));
  }

  getHeader(): SessionHeader {
    return this.inspectState((state) => projectedHeader(state.header));
  }

  getEntries(): SessionEntry[] {
    return structuredClone(this.entries());
  }

  getEntryCount(): number {
    return this.inspectState((state) => state.nodes.size);
  }

  private entryOrder(state: SessionV4State): { ids: string[]; sequence: Map<string, number> } {
    if (this.entryOrderCache?.ids.length === state.nodes.size) return this.entryOrderCache;
    const ids = [...state.nodes.keys()];
    const sequence = new Map(ids.map((id, index) => [id, index]));
    this.entryOrderCache = { ids, sequence };
    return this.entryOrderCache;
  }

  getEntrySequence(id: string): number | undefined {
    return this.inspectState((state) => this.entryOrder(state).sequence.get(id));
  }

  getEntriesPage(offset: number, limit: number): SessionEntry[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => structuredClone(
      this.entryOrder(state).ids
        .slice(offset, offset + limit)
        .map((id) => projectedEntry(state.nodes.get(id)!)),
    ));
  }

  /** @internal Returns page-index metadata without materializing stored entry payloads. */
  getEntryProjectionMetadataPage(offset: number, limit: number): SessionEntryProjectionMetadata[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => this.entryOrder(state).ids
      .slice(offset, offset + limit)
      .map((id) => {
        const node = state.nodes.get(id)!;
        return {
          id,
          parentId: node.parentId,
          projectedEntryCount: projectedSessionEntryCount(node),
        };
      }));
  }

  getTreeEntryPage(offset: number, limit: number): SessionTreeNode[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => {
      const timestamps = labelTimestamps(state);
      const depths = new Map<string, number>();
      return structuredClone(this.entryOrder(state).ids
        .slice(offset, offset + limit)
        .map((id) => {
          const entry = projectedEntry(state.nodes.get(id)!);
          const label = state.labels.get(id);
          const labelTimestamp = timestamps.get(id);
          return {
            entry,
            children: [],
            depth: absoluteNodeDepth(state, id, depths),
            ...(label === undefined ? {} : { label }),
            ...(labelTimestamp === undefined ? {} : { labelTimestamp }),
          };
        }));
    });
  }

  /** @internal Returns a cheap cursor revision for paged tree metadata. */
  getTreeRevision(): number {
    return this.inspectState((state) => state.sequence);
  }

  getTreePage(offset: number, limit: number): SessionTreeNode[] {
    const page = this.getTreeEntryPage(offset, limit);
    const nodes = new Map(page.map((node) => [node.entry.id, node]));
    const roots: SessionTreeNode[] = [];
    for (const node of page) {
      const parent = node.entry.parentId === null ? undefined : nodes.get(node.entry.parentId);
      if (parent === undefined || parent === node) roots.push(node);
      else parent.children.push(node);
    }
    return roots;
  }

  getActiveBranchEntryIdsInPage(offset: number, limit: number): string[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => {
      const pageIds = this.entryOrder(state).ids.slice(offset, offset + limit);
      const page = new Set(pageIds);
      const active = new Set<string>();
      const encountered = new Set<string>();
      const head = primaryBranch(state).headNodeId;
      for (
        let cursor = head === null ? undefined : state.nodes.get(head);
        cursor !== undefined && !encountered.has(cursor.id);
        cursor = cursor.parentId === null ? undefined : state.nodes.get(cursor.parentId)
      ) {
        encountered.add(cursor.id);
        if (page.has(cursor.id)) active.add(cursor.id);
      }
      return pageIds.filter((id) => active.has(id));
    });
  }

  getContextMessagePage(offset: number, limit: number): {
    messages: SessionContextMessage[];
    totalMessages: number;
  } {
    const messages = this.buildSessionContext().messages;
    return {
      messages: offset < 0 || limit < 1 ? [] : messages.slice(offset, offset + limit),
      totalMessages: messages.length,
    };
  }

  getTree(): SessionTreeNode[] {
    return this.inspectState((state) => {
      const nodes = new Map<string, SessionTreeNode>();
      const roots: SessionTreeNode[] = [];
      const timestamps = labelTimestamps(state);
      for (const raw of state.nodes.values()) {
        const entry = projectedEntry(raw);
        const label = state.labels.get(entry.id);
        const labelTimestamp = timestamps.get(entry.id);
        nodes.set(entry.id, {
          entry,
          children: [],
          ...(label === undefined ? {} : { label }),
          ...(labelTimestamp === undefined ? {} : { labelTimestamp }),
        });
      }
      for (const raw of state.nodes.values()) {
        const node = nodes.get(raw.id) as SessionTreeNode;
        const parent = raw.parentId === null ? undefined : nodes.get(raw.parentId);
        if (parent === undefined || parent === node) roots.push(node);
        else parent.children.push(node);
      }
      return structuredClone(roots);
    });
  }

  branch(branchFromId: string): void {
    if (!this.inspectState((state) => state.nodes.has(branchFromId))) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.commitChanges([{ type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: branchFromId }]);
  }

  resetLeaf(): void {
    this.commitChanges([{ type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: null }]);
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: NormalizedUsage,
  ): string {
    if (branchFromId !== null && !this.inspectState((state) => state.nodes.has(branchFromId))) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      ...this.entryBase("branch_summary"),
      parentId: branchFromId,
      fromId: branchFromId ?? "root",
      summary,
      ...(usage === undefined ? {} : { usage: structuredClone(usage) }),
      ...(details === undefined ? {} : { details }),
      ...(fromHook === undefined ? {} : { fromHook }),
    };
    const previousHead = this.getLeafId();
    // A root cursor has no node that can satisfy the native range references.
    const node: SessionV4ConversationNode = branchFromId === null || previousHead === null
      ? sessionEntryToV4Node(entry, this.cwd)
      : {
          id: entry.id,
          parentId: branchFromId,
          createdAt: entry.timestamp,
          nodeType: "branch_summary",
          fromNodeId: branchFromId,
          toNodeId: previousHead,
          summary: asJson({
            summary,
            ...(details === undefined ? {} : { details }),
            ...(fromHook === undefined ? {} : { fromHook }),
            ...(usage === undefined ? {} : { usage }),
          }),
        };
    this.commitChanges([
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: branchFromId },
      { type: "conversation_node", node },
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
    ]);
    return node.id;
  }

  createBranchedSession(leafId: string): string | undefined {
    const branch = this.getBranch(leafId);
    if (branch.length === 0) throw new Error(`Entry ${leafId} not found`);
    const source = this.inspectState((state) => ({
      labels: new Map(
        branch.flatMap((entry) => {
          const label = state.labels.get(entry.id);
          return label === undefined ? [] : [[entry.id, label] as const];
        }),
      ),
      name: state.name,
      sessionId: state.header.sessionId,
    }));
    const timestamp = new Date().toISOString();
    const id = newSessionId();
    const target = this.persist
      ? join(this.sessionDir, `${timestamp.replace(/[:.]/gu, "-")}_${id}.jsonl`)
      : undefined;
    const candidate = this.freshCandidate(
      createHeader(id, timestamp, this.cwd, { sessionId: source.sessionId, purpose: "branch" }),
      target,
    );
    try {
      let parentId: string | null = null;
      for (const sourceEntry of branch) {
        const entry = { ...structuredClone(sourceEntry), parentId } as SessionEntry;
        const node = sessionEntryToV4Node(entry, this.cwd);
        candidate.commitChanges([
          { type: "conversation_node", node },
          { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
        ]);
        parentId = node.id;
      }
      if (source.name !== null) candidate.commitChanges([{ type: "session_name", name: source.name }]);
      for (const [nodeId, label] of source.labels) {
        candidate.commitChanges([{ type: "node_label", nodeId, label }]);
      }
      this.adoptCandidate(candidate);
      return this.sessionFile;
    } catch (error) {
      candidate.closeV4Store();
      if (target !== undefined) {
        try {
          unlinkSync(target);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new AggregateError([error, cleanupError], "Branched session creation failed and cleanup was incomplete");
          }
        }
      }
      throw error;
    }
  }

  static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    if (sessionDir !== undefined) preparePrivateSessionDirectory(directory);
    return new SessionManager({
      cwd,
      sessionDir: directory,
      persist: true,
      ...(options === undefined ? {} : { newSessionOptions: options }),
    });
  }

  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
    const file = absolutePath(path);
    if (sessionDir !== undefined) preparePrivateSessionDirectory(absolutePath(sessionDir));
    if (!existsSync(file)) {
      const cwd = cwdOverride ?? process.cwd();
      const directory = sessionDir === undefined ? dirname(file) : absolutePath(sessionDir);
      return new SessionManager({ cwd, sessionDir: directory, sessionFile: file, persist: true });
    }
    const opened = openPersistentSession(file);
    try {
      const cwd = cwdOverride ?? opened.writer.inspectState((state) => state.header.cwd);
      const directory = sessionDir === undefined ? dirname(file) : absolutePath(sessionDir);
      return new SessionManager({
        cwd,
        sessionDir: directory,
        sessionFile: file,
        persist: true,
        openedSession: { file, ...opened },
      });
    } catch (error) {
      try {
        opened.writer.close();
      } finally {
        opened.lease.release();
      }
      throw error;
    }
  }

  /** @internal Opens an immutable projection without acquiring the file's writer slot. */
  static openSnapshot(path: string, cwdOverride?: string): SessionManager {
    const file = absolutePath(path);
    const loaded = stateFromFile(file);
    return new SessionManager({
      cwd: cwdOverride ?? loaded.state.header.cwd,
      sessionDir: dirname(file),
      sessionFile: file,
      persist: true,
      snapshotState: loaded.state,
      snapshotBytes: loaded.committedBytes,
    });
  }

  /** @internal Opens an immutable projection from an already bounded file snapshot. */
  static openSnapshotBytes(path: string, bytes: Uint8Array, cwdOverride?: string): SessionManager {
    const file = absolutePath(path);
    const loaded = parseSessionV4Bytes(bytes);
    if (loaded.state.nodes.size > MAX_SESSION_ENTRY_COUNT) {
      throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${file}`);
    }
    return new SessionManager({
      cwd: cwdOverride ?? loaded.state.header.cwd,
      sessionDir: dirname(file),
      sessionFile: file,
      persist: true,
      snapshotState: loaded.state,
      snapshotBytes: loaded.committedBytes,
    });
  }

  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    if (sessionDir !== undefined) preparePrivateSessionDirectory(directory);
    for (const candidate of recentSessionCandidates(directory, cwd)) {
      try {
        return SessionManager.open(candidate.path, directory, cwd);
      } catch {}
    }
    return SessionManager.create(cwd, directory);
  }

  static inMemory(cwd = process.cwd(), options?: NewSessionOptions): SessionManager {
    return new SessionManager({
      cwd,
      sessionDir: "",
      persist: false,
      ...(options === undefined ? {} : { newSessionOptions: options }),
    });
  }

  cloneInMemory(): SessionManager {
    if (this.persist) throw new Error("Only in-memory sessions can be cloned in memory");
    const clone = SessionManager.inMemory(this.cwd);
    clone.sessionId = this.sessionId;
    clone.memoryState = this.inspectState(cloneSessionV4State);
    clone.logicalFileBytes = this.logicalFileBytes;
    return clone;
  }

  static forkFrom(
    sourcePath: string,
    targetCwd: string,
    sessionDir?: string,
    options?: NewSessionOptions,
  ): SessionManager {
    const source = absolutePath(sourcePath);
    const sourceState = stateFromFile(source).state;
    const cwd = absolutePath(targetCwd);
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    const target = SessionManager.create(cwd, directory, {
      ...(options?.id === undefined ? {} : { id: options.id }),
      parentSession: source,
    });
    const createdFile = target.getSessionFile();
    const createdDetails = createdFile === undefined ? undefined : statSync(createdFile);
    try {
      for (const node of sourceState.nodes.values()) {
        const copied = structuredClone(node);
        delete copied.operationId;
        target.commitChanges([
          { type: "conversation_node", node: copied },
          { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: copied.id },
        ]);
      }
      const sourceHead = primaryBranch(sourceState).headNodeId;
      if (sourceHead !== target.getLeafId()) {
        target.commitChanges([{
          type: "head",
          branchId: SESSION_V4_PRIMARY_BRANCH_ID,
          nodeId: sourceHead,
        }]);
      }
      if (sourceState.name !== null) target.commitChanges([{ type: "session_name", name: sourceState.name }]);
      for (const [nodeId, label] of sourceState.labels) {
        target.commitChanges([{ type: "node_label", nodeId, label }]);
      }
      return target;
    } catch (error) {
      const failures = [error];
      try {
        target.closeV4Store();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (createdFile !== undefined && createdDetails !== undefined) {
        try {
          const currentDetails = statSync(createdFile);
          if (currentDetails.dev === createdDetails.dev && currentDetails.ino === createdDetails.ino) {
            unlinkSync(createdFile);
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanupError);
        }
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, "Session fork failed and its candidate could not be removed cleanly");
    }
  }

  static async list(cwd: string, sessionDir?: string, progress?: SessionListProgress): Promise<SessionInfo[]> {
    return (await SessionManager.inspect(cwd, sessionDir, false, progress)).sessions;
  }

  static async inspectFile(path: string): Promise<SessionInfo> {
    return await readSessionInfo(absolutePath(path));
  }

  static async inspect(
    cwd: string,
    sessionDir?: string,
    allWorkspaces = false,
    progress?: SessionListProgress,
  ): Promise<SessionScanResult> {
    if (allWorkspaces) {
      const customDirectory = sessionDir === undefined ? undefined : absolutePath(sessionDir);
      const scanned = await scanAllSessions(customDirectory, progress);
      sortSessions(scanned.sessions);
      scanned.invalid.sort((left, right) => comparePath(left.path, right.path));
      return scanned;
    }

    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    const scanned = await scanDirectory(directory, progress);
    scanned.sessions = sortSessions(scanned.sessions
      .filter((session) => sameCwd(session.cwd, cwd)));
    scanned.invalid.sort((left, right) => comparePath(left.path, right.path));
    return scanned;
  }

  static async listAll(progress?: SessionListProgress): Promise<SessionInfo[]>;
  static async listAll(sessionDir?: string, progress?: SessionListProgress): Promise<SessionInfo[]>;
  static async listAll(
    sessionDirOrProgress?: string | SessionListProgress,
    progressArgument?: SessionListProgress,
  ): Promise<SessionInfo[]> {
    const customDirectory = typeof sessionDirOrProgress === "string" ? absolutePath(sessionDirOrProgress) : undefined;
    const progress = typeof sessionDirOrProgress === "function" ? sessionDirOrProgress : progressArgument;
    const scanned = await scanAllSessions(customDirectory, progress);
    return sortSessions(scanned.sessions);
  }
}

type SessionIdentityReader =
  | "isPersisted"
  | "getSessionId"
  | "getSessionFile"
  | "getCwd"
  | "getSessionDir";

type SessionHistoryReader =
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getBranch"
  | "findEntriesOnBranch"
  | "findEntryOnBranch"
  | "getActiveBranchUsage"
  | "getEntries"
  | "getTree"
  | "buildContextEntries";

type SessionMetadataReader = "getLabel" | "getHeader" | "getSessionName";

export type ReadonlySessionManager = Pick<
  SessionManager,
  SessionIdentityReader | SessionHistoryReader | SessionMetadataReader
>;
