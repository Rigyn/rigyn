import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  parseSessionV4Bytes,
  SESSION_V4_PRIMARY_BRANCH_ID,
  SESSION_V4_VERSION,
  type SessionV4Change,
  type SessionV4Changes,
  type SessionV4Commit,
  type SessionV4Header,
} from "@rigyn/kernel/session-v4";
import { errorMessage } from "../core/errors.js";
import type { JsonValue } from "../core/json.js";
import type { NormalizedUsage, ProviderToolDefinition, UsageCost } from "../core/types.js";
import { addCompleteNormalizedUsage } from "../core/usage.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  immutableRuntimeToolRenderView,
  projectRuntimeToolRenderResult,
  type RuntimeToolRendererBinding,
  type RuntimeToolRendererFailure,
  type RuntimeUiBlock,
  type RuntimeUiSpan,
} from "../tui/components.js";
import {
  DIRECT_TOOL_RENDER_RESULT,
  projectRuntimeDirectToolRenderContent,
} from "../tui/tool-render-view.js";
import { SESSION_EXPORT_CLIENT } from "./session-export-client.js";
import { SESSION_EXPORT_STYLE } from "./session-export-style.js";
import { MAX_SESSION_FILE_BYTES, SessionManager, sessionEntryToV4Node } from "./session-manager.js";
import {
  CURRENT_SESSION_VERSION,
  type SessionEntry,
  type SessionHeader,
} from "./types.js";

const EXPORT_RENDER_WIDTH = 100;
const MAX_RENDERED_LINES = 2_048;
const MAX_RENDERED_SPANS_PER_LINE = 256;
const MAX_RENDERED_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_RENDERER_VIEW_BYTES = 256 * 1024;
const SESSION_EXPORT_READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const EXPORT_ROLES = new Set(["muted", "accent", "link", "success", "warning", "error", "title"]);

export interface SessionExportSkill {
  name: string;
  description: string;
}

export interface SessionExportTool {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  active: boolean;
}

export interface SessionExportUsage {
  inputTokens?: number;
  inputTokensReported?: number;
  outputTokens?: number;
  outputTokensReported?: number;
  cacheReadTokens?: number;
  cacheReadTokensReported?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensReported?: number;
  reasoningTokens?: number;
  reasoningTokensReported?: number;
  totalTokens?: number;
  totalTokensReported?: number;
  cost?: UsageCost;
  costReported?: UsageCost;
}

export interface SessionExportRenderedTool {
  call?: RuntimeUiBlock;
  resultCollapsed?: RuntimeUiBlock;
  resultExpanded?: RuntimeUiBlock;
}

export interface SessionExportTreeNode {
  id: string;
  index: number;
  parentId: string | null;
  children: string[];
  label?: string;
}

export interface SessionExportTree {
  roots: string[];
  nodes: SessionExportTreeNode[];
  activePath: string[];
}

export interface SessionExportData {
  schemaVersion: 1;
  product: "rigyn";
  title: string;
  theme: "dark" | "light";
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
  tree: SessionExportTree;
  jsonl: string;
  usage: SessionExportUsage;
  systemPrompt?: string;
  tools?: SessionExportTool[];
  skills?: SessionExportSkill[];
  renderedTools?: Record<string, SessionExportRenderedTool>;
  /** True when every user-controlled export field and the downloadable JSONL were redacted. */
  redacted?: true;
}

export interface RenderSessionHtmlOptions {
  /** Unknown or unavailable themes deliberately use the standalone export's dark presentation. */
  theme?: "dark" | "light" | string;
  systemPrompt?: string;
  tools?: readonly (ProviderToolDefinition & { active?: boolean })[];
  skills?: readonly SessionExportSkill[];
  toolRenderer?: RuntimeToolRendererBinding;
  /** Receives a bounded, redacted renderer failure when the binding has no diagnostic reporter. */
  onToolRendererDiagnostic?: (diagnostic: { name: string; slot: string; message: string }) => void;
  /** Exact source bytes used by the in-document JSONL download. */
  sourceJsonl?: string;
  /** Produce a review-required sharing copy with known secrets removed. */
  redact?: boolean;
}

export interface SerializeSessionRecordsOptions {
  /** Remove known secrets while preserving structural IDs and references. */
  redact?: boolean;
  /** Selected head for the exported settled journal. The last node is used when omitted. */
  leafId?: string | null;
  /** Latest projected session name. */
  name?: string;
  /** Latest projected node labels. */
  labels?: ReadonlyMap<string, string> | readonly (readonly [string, string])[];
}

function usageSources(entries: readonly SessionEntry[]): NormalizedUsage[] {
  const result: NormalizedUsage[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.usage !== undefined || entry.fromHook !== true) result.push(entry.usage ?? {});
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "tool" && message.usage !== undefined) {
      result.push(message.usage);
      continue;
    }
    if (message.role === "assistant") {
      const successful = message.retryTransient !== true
        && message.stopReason !== "cancelled"
        && message.stopReason !== "aborted"
        && message.stopReason !== "error";
      const metered = message.usage !== undefined || successful && (
        message.provider !== undefined || message.model !== undefined || message.api !== undefined
      );
      if (metered) result.push(message.usage ?? {});
    }
  }
  return result;
}

/** Historical totals include every branch and auxiliary compaction/summary request. */
export function sessionExportUsage(entries: readonly SessionEntry[]): SessionExportUsage {
  const sources = usageSources(entries);
  const exact = sources.reduce<NormalizedUsage | undefined>(
    (sum, usage) => addCompleteNormalizedUsage(sum, usage),
    undefined,
  ) ?? {};
  const tokenFields = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const;
  const total: SessionExportUsage = {};
  for (const field of tokenFields) {
    const exactValue = exact[field];
    if (exactValue !== undefined) {
      total[field] = exactValue;
      continue;
    }
    let reported: number | undefined;
    for (const usage of sources) {
      const value = usage[field];
      if (value === undefined) continue;
      const next = (reported ?? 0) + value;
      reported = Number.isSafeInteger(next) ? next : undefined;
      if (reported === undefined) break;
    }
    if (reported !== undefined) total[`${field}Reported`] = reported;
  }
  if (exact.cost !== undefined) {
    total.cost = { ...exact.cost };
  } else {
    let cost: UsageCost | undefined;
    for (const usage of sources) {
      if (usage.cost === undefined) continue;
      const input = (cost?.input ?? 0) + usage.cost.input;
      const output = (cost?.output ?? 0) + usage.cost.output;
      const cacheRead = (cost?.cacheRead ?? 0) + usage.cost.cacheRead;
      const cacheWrite = (cost?.cacheWrite ?? 0) + usage.cost.cacheWrite;
      const costTotal = input + output + cacheRead + cacheWrite;
      if (![input, output, cacheRead, cacheWrite, costTotal].every(Number.isFinite)) {
        cost = undefined;
        break;
      }
      cost = { input, output, cacheRead, cacheWrite, total: costTotal };
    }
    if (cost !== undefined) total.costReported = cost;
  }
  return total;
}

export function resolveSessionExportTheme(theme: string | undefined): "dark" | "light" {
  return theme?.trim().toLowerCase() === "light" ? "light" : "dark";
}

export function buildSessionExportTree(
  entries: readonly SessionEntry[],
  leafId: string | null,
  stateLabels?: ReadonlyMap<string, string>,
): SessionExportTree {
  const labels = new Map(stateLabels);
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (typeof entry.label === "string" && entry.label.length > 0) labels.set(entry.targetId, entry.label);
    else labels.delete(entry.targetId);
  }
  const index = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.parentId === null || entry.parentId === entry.id || !index.has(entry.parentId)) roots.push(entry.id);
    else {
      const selected = children.get(entry.parentId) ?? [];
      selected.push(entry.id);
      children.set(entry.parentId, selected);
    }
  }
  const byTimestamp = (left: string, right: string): number =>
    new Date(index.get(left)?.timestamp ?? 0).getTime() - new Date(index.get(right)?.timestamp ?? 0).getTime();
  roots.sort(byTimestamp);
  for (const selected of children.values()) selected.sort(byTimestamp);
  const activePath: string[] = [];
  const visited = new Set<string>();
  let current = leafId === null ? undefined : index.get(leafId);
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    activePath.unshift(current.id);
    current = current.parentId === null || current.parentId === current.id ? undefined : index.get(current.parentId);
  }
  return {
    roots,
    nodes: entries.map((entry, entryIndex) => {
      const label = labels.get(entry.id);
      return {
        id: entry.id,
        index: entryIndex,
        parentId: entry.parentId,
        children: [...(children.get(entry.id) ?? [])],
        ...(label === undefined ? {} : { label }),
      };
    }),
    activePath,
  };
}

function serializedSession(manager: SessionManager): string {
  const source = manager.getSessionFile();
  if (source !== undefined && existsSync(source)) return readSessionExportSourceSync(source).toString("utf8");
  const header = manager.getHeader();
  const entries = manager.getEntries();
  const name = manager.getSessionName();
  return serializeSessionRecords(header, entries, {
    leafId: manager.getLeafId(),
    ...(name === undefined ? {} : { name }),
    labels: new Map(entries.flatMap((entry) => {
      const label = manager.getLabel(entry.id);
      return label === undefined ? [] : [[entry.id, label] as const];
    })),
  });
}

function projectionHeader(
  header: SessionHeader,
  redact: boolean,
): SessionV4Header {
  if (header.version !== CURRENT_SESSION_VERSION) {
    throw new Error("Session projection version is not supported");
  }
  const visible = redact
    ? defaultSecretRedactor.redactValue(header) as SessionHeader
    : header;
  return {
    record: "session",
    version: SESSION_V4_VERSION,
    sessionId: header.id,
    createdAt: header.timestamp,
    workspace: visible.cwd,
    cwd: visible.cwd,
    ...(header.parentSession === undefined
      ? {}
      : { parent: { sessionId: header.parentSession } }),
  };
}

function redactedPayload<T>(value: T): T {
  return defaultSecretRedactor.redactPayloadValue(value) as T;
}

const SESSION_PAYLOAD_FIELDS = new Set(["arguments", "data", "details", "metadata", "raw", "value"]);
const SESSION_CONTENT_TYPES = new Set(["text", "thinking", "image", "tool_call", "tool_result", "provider_opaque"]);
const SESSION_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool", "bashExecution", "custom"]);

function redactedSessionPayloads(source: unknown, selected: unknown): unknown {
  if (Array.isArray(source)) {
    if (!Array.isArray(selected) || source.length !== selected.length) {
      throw new Error("Secret redaction changed session payload structure");
    }
    return source.map((value, index) => redactedSessionPayloads(value, selected[index]));
  }
  if (source === null || typeof source !== "object" || selected === null || typeof selected !== "object") {
    return selected;
  }

  const safe = { ...selected } as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const type = descriptors.type !== undefined && "value" in descriptors.type ? descriptors.type.value : undefined;
  const customType = descriptors.customType !== undefined && "value" in descriptors.customType
    ? descriptors.customType.value
    : undefined;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable !== true || !("value" in descriptor)) continue;
    if (
      (key === "type" && typeof descriptor.value === "string" && SESSION_CONTENT_TYPES.has(descriptor.value))
      || (key === "role" && typeof descriptor.value === "string" && SESSION_MESSAGE_ROLES.has(descriptor.value))
    ) {
      safe[key] = descriptor.value;
      continue;
    }
    if (key === "providerState") {
      delete safe[key];
      continue;
    }
    if (SESSION_PAYLOAD_FIELDS.has(key)) {
      const payload = redactedPayload(descriptor.value);
      if (
        key === "data"
        && type === "custom"
        && customType === "rigyn.session.tools-change"
        && payload !== null
        && typeof payload === "object"
        && !Array.isArray(payload)
        && descriptor.value !== null
        && typeof descriptor.value === "object"
        && !Array.isArray(descriptor.value)
      ) {
        const structural = descriptor.value as Record<string, unknown>;
        safe[key] = {
          ...payload,
          ...(structural.tools === undefined ? {} : { tools: redactedPayload(structural.tools) }),
          ...(structural.toolsetFingerprint === undefined
            ? {}
            : { toolsetFingerprint: defaultSecretRedactor.redact(String(structural.toolsetFingerprint)) }),
        };
      } else {
        safe[key] = payload;
      }
      continue;
    }
    safe[key] = redactedSessionPayloads(descriptor.value, safe[key]);
  }
  return safe;
}

function projectionEntry(entry: SessionEntry, redact: boolean): SessionEntry {
  if (!redact) return structuredClone(entry);
  const selected = redactedSessionPayloads(entry, defaultSecretRedactor.redactValue(entry)) as SessionEntry;
  const structural = {
    ...selected,
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };
  switch (entry.type) {
    case "compaction":
      return { ...structural, firstKeptEntryId: entry.firstKeptEntryId } as SessionEntry;
    case "branch_summary":
      return { ...structural, fromId: entry.fromId } as SessionEntry;
    case "label":
      return { ...structural, targetId: entry.targetId } as SessionEntry;
    default:
      return structural as SessionEntry;
  }
}

function exportCommit(
  sequence: number,
  committedAt: string,
  changes: SessionV4Changes,
): SessionV4Commit {
  return {
    record: "commit",
    sequence,
    commitId: `export-${sequence}`,
    committedAt,
    changes,
  };
}

function changes(items: SessionV4Change[]): SessionV4Changes {
  if (items.length === 0) throw new Error("A session export commit must contain a change");
  return items as SessionV4Changes;
}

/**
 * Builds a strict V4 journal from the public session projection.
 *
 * The result is resumable, but deliberately settled: it contains conversation
 * and session presentation state, not active operations, queues, checkpoints,
 * or tool-effect recovery records.
 */
export function serializeSessionRecords(
  header: SessionHeader,
  entries: readonly SessionEntry[],
  input: boolean | SerializeSessionRecordsOptions = false,
): string {
  const options: SerializeSessionRecordsOptions = typeof input === "boolean" ? { redact: input } : input;
  const redact = options.redact === true;
  const journalHeader = projectionHeader(header, redact);
  const commits: SessionV4Commit[] = [];
  let sequence = 0;
  let headId: string | null = null;
  const append = (committedAt: string, items: SessionV4Change[]): void => {
    sequence += 1;
    commits.push(exportCommit(sequence, committedAt, changes(items)));
  };

  for (const source of entries) {
    const entry = projectionEntry(source, redact);
    if (entry.type === "session_info") {
      const name = entry.name?.replace(/[\r\n]+/gu, " ").trim() ?? "";
      append(entry.timestamp, [{ type: "session_name", name: name === "" ? null : name }]);
      continue;
    }
    if (entry.type === "label") {
      append(entry.timestamp, [{
        type: "node_label",
        nodeId: entry.targetId,
        label: entry.label?.trim() === "" || entry.label === undefined ? null : entry.label.trim(),
      }]);
      continue;
    }
    const node = sessionEntryToV4Node(entry, journalHeader.cwd);
    append(entry.timestamp, [
      { type: "conversation_node", node },
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
    ]);
    headId = node.id;
  }

  const stateTimestamp = entries.at(-1)?.timestamp ?? header.timestamp;
  if (options.leafId !== undefined && options.leafId !== headId) {
    append(stateTimestamp, [{
      type: "head",
      branchId: SESSION_V4_PRIMARY_BRANCH_ID,
      nodeId: options.leafId,
    }]);
  }
  if (options.name !== undefined) {
    const sourceName = redact
      ? defaultSecretRedactor.redactValue(options.name) as string
      : options.name;
    const name = sourceName.replace(/[\r\n]+/gu, " ").trim();
    append(stateTimestamp, [{ type: "session_name", name: name === "" ? null : name }]);
  }
  for (const [nodeId, sourceLabel] of options.labels ?? []) {
    const selected = redact
      ? defaultSecretRedactor.redactValue(sourceLabel) as string
      : sourceLabel;
    const label = selected.trim();
    append(stateTimestamp, [{
      type: "node_label",
      nodeId,
      label: label === "" ? null : label,
    }]);
  }

  const result = `${[journalHeader, ...commits].map((record) => JSON.stringify(record)).join("\n")}\n`;
  parseSessionV4Bytes(Buffer.from(result, "utf8"));
  return result;
}

function derivedSystemPrompt(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "system") continue;
    if (entry.message.purpose !== "instructions") continue;
    const prompt = entry.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    if (prompt !== "") return prompt;
  }
  return undefined;
}

function boundedUtf8Prefix(value: string, maximumBytes: number): { text: string; bytes: number } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) return { text: value, bytes: encoded.length };
  let end = Math.max(0, maximumBytes);
  while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), bytes: end };
}

function boundedSpan(
  span: RuntimeUiSpan,
  remaining: { bytes: number; truncated: boolean },
  redact: boolean,
): { text: string; role?: NonNullable<RuntimeUiSpan["role"]> } | undefined {
  let text = typeof span.text === "string" ? span.text : String(span.text ?? "");
  if (redact) text = defaultSecretRedactor.redact(text);
  if (remaining.bytes <= 0) {
    if (text !== "") remaining.truncated = true;
    return undefined;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > remaining.bytes) {
    const retained = boundedUtf8Prefix(text, remaining.bytes);
    text = retained.text;
    remaining.bytes -= retained.bytes;
    remaining.truncated = true;
  } else {
    remaining.bytes -= bytes;
  }
  const role = span.role;
  return {
    text,
    ...(role !== undefined && EXPORT_ROLES.has(role) ? { role } : {}),
  };
}

function boundedUiBlock(block: RuntimeUiBlock | undefined, redact: boolean): RuntimeUiBlock | undefined {
  if (block === undefined) return undefined;
  const remaining = { bytes: MAX_RENDERED_TEXT_BYTES, truncated: false };
  let truncated = block.lines.length > MAX_RENDERED_LINES;
  const lines = block.lines.slice(0, MAX_RENDERED_LINES).map((line) => {
    if (line.spans.length > MAX_RENDERED_SPANS_PER_LINE) truncated = true;
    return {
      spans: line.spans.slice(0, MAX_RENDERED_SPANS_PER_LINE).flatMap((span) => {
        const selected = boundedSpan(span, remaining, redact);
        return selected === undefined ? [] : [selected];
      }),
      ...(line.fill === true ? { fill: true } : {}),
    };
  });
  if (truncated || remaining.truncated) {
    lines.push({ spans: [{ text: "… renderer output truncated", role: "muted" as const }] });
  }
  return { lines };
}

function rendererContext(expanded: boolean, theme: "dark" | "light") {
  return {
    width: EXPORT_RENDER_WIDTH,
    height: 10_000,
    focused: false,
    expanded,
    theme: { name: theme, color: true, unicode: true },
  } as const;
}

function preRenderTools(
  entries: readonly SessionEntry[],
  renderer: RuntimeToolRendererBinding | undefined,
  theme: "dark" | "light",
  redact: boolean,
  onDiagnostic?: RenderSessionHtmlOptions["onToolRendererDiagnostic"],
): Record<string, SessionExportRenderedTool> | undefined {
  if (renderer === undefined) return undefined;
  const failureKeys = new Set<string>();
  const reportFailure = (failure: RuntimeToolRendererFailure): void => {
    const detail = defaultSecretRedactor.redact(errorMessage(failure.cause)).slice(0, 4_096);
    const key = `${failure.name}\u0000${failure.slot}\u0000${detail}`;
    if (failureKeys.has(key) || failureKeys.size >= 128) return;
    failureKeys.add(key);
    if (renderer.reportError !== undefined) {
      try {
        renderer.reportError(failure);
        return;
      } catch {
        // A broken reporter falls back to the export caller's diagnostic channel.
      }
    }
    try {
      onDiagnostic?.({
        name: failure.name,
        slot: failure.slot,
        message: `Runtime tool ${failure.slot} renderer failed for ${failure.name}: ${detail}`,
      });
    } catch {
      // Export availability does not depend on an optional diagnostic observer.
    }
  };
  const hasRenderer = (name: string): boolean => {
    try {
      return renderer.has(name);
    } catch (cause) {
      reportFailure({ name, slot: "has", cause });
      return false;
    }
  };
  const resultErrors = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (redact && "callId" in block && defaultSecretRedactor.redact(block.callId) !== block.callId) continue;
      if (block.type === "tool_result") resultErrors.set(block.callId, block.isError);
    }
  }
  const calls = new Map<string, { name: string; input: JsonValue }>();
  const rendered: Record<string, SessionExportRenderedTool> = Object.create(null) as Record<string, SessionExportRenderedTool>;
  for (const entry of entries) {
    if (entry.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (redact && "callId" in block && defaultSecretRedactor.redact(block.callId) !== block.callId) continue;
      if (block.type === "tool_call") {
        calls.set(block.callId, { name: block.name, input: block.arguments });
        if (!hasRenderer(block.name)) continue;
        try {
          const resultIsError = resultErrors.get(block.callId);
          const selected = boundedUiBlock(renderer.renderCall(block.name, immutableRuntimeToolRenderView({
            callId: block.callId,
            name: block.name,
            input: block.arguments,
            argsComplete: true,
            executionStarted: resultIsError !== undefined,
            status: resultIsError === undefined ? "pending" : resultIsError ? "failed" : "completed",
            expanded: false,
          }), rendererContext(false, theme)), redact);
          if (selected !== undefined) rendered[block.callId] = { call: selected };
        } catch (cause) {
          reportFailure({ name: block.name, slot: "call", cause });
        }
      }
      if (block.type !== "tool_result") continue;
      const call = calls.get(block.callId);
      const name = block.name || call?.name || "tool";
      if (!hasRenderer(name)) continue;
      const base = {
        callId: block.callId,
        name,
        ...(call === undefined ? {} : { input: call.input }),
        result: projectRuntimeToolRenderResult(block, { maximumBytes: MAX_RENDERER_VIEW_BYTES }),
        argsComplete: true,
        executionStarted: true,
        status: block.isError ? "failed" as const : "completed" as const,
      };
      const directContent = projectRuntimeDirectToolRenderContent(
        block,
        { maximumBytes: MAX_RENDERER_VIEW_BYTES },
      );
      const renderResult = (expanded: boolean): RuntimeUiBlock | undefined => {
        try {
          const view = immutableRuntimeToolRenderView({ ...base, expanded });
          const context = rendererContext(expanded, theme);
          const direct = renderer[DIRECT_TOOL_RENDER_RESULT];
          return boundedUiBlock(direct === undefined
            ? renderer.renderResult(name, view, context)
            : direct.call(renderer, name, view, directContent, context), redact);
        } catch (cause) {
          reportFailure({ name, slot: "result", cause });
          return undefined;
        }
      };
      const collapsed = renderResult(false);
      const expanded = renderResult(true);
      if (collapsed !== undefined || expanded !== undefined) {
        rendered[block.callId] = {
          ...rendered[block.callId],
          ...(collapsed === undefined ? {} : { resultCollapsed: collapsed }),
          ...(expanded === undefined ? {} : { resultExpanded: expanded }),
        };
      }
    }
  }
  return Object.keys(rendered).length === 0 ? undefined : rendered;
}

function exportTools(tools: RenderSessionHtmlOptions["tools"], redact: boolean): SessionExportTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const schema = redact ? redactedPayload(tool.inputSchema) : structuredClone(tool.inputSchema);
    return {
      name: redact ? defaultSecretRedactor.redact(tool.name) : tool.name,
      description: redact ? defaultSecretRedactor.redact(tool.description) : tool.description,
      inputSchema: schema !== null && typeof schema === "object" && !Array.isArray(schema) ? schema : {},
      active: tool.active !== false,
    };
  });
}

function redactedSessionHeader(header: SessionHeader): SessionHeader {
  return {
    ...defaultSecretRedactor.redactValue(header) as SessionHeader,
    type: header.type,
    version: header.version,
    id: header.id,
    timestamp: header.timestamp,
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
  };
}

export function buildSessionExportData(
  manager: SessionManager,
  options: RenderSessionHtmlOptions = {},
): SessionExportData {
  const header = manager.getHeader();
  if (header === null) throw new Error("Session has no header");
  const entries = manager.getEntries();
  const redact = options.redact === true;
  const projectedEntries = redact ? entries.map((entry) => projectionEntry(entry, true)) : structuredClone(entries);
  const leafId = manager.getLeafId();
  const name = manager.getSessionName();
  const labels = new Map(entries.flatMap((entry) => {
    const label = manager.getLabel(entry.id);
    return label === undefined ? [] : [[entry.id, label] as const];
  }));
  const projectedLabels = redact
    ? new Map([...labels].map(([entryId, label]) => [
        entryId,
        defaultSecretRedactor.redactValue(label) as string,
      ]))
    : labels;
  const theme = resolveSessionExportTheme(options.theme);
  const sourceSystemPrompt = options.systemPrompt || derivedSystemPrompt(entries);
  const systemPrompt = sourceSystemPrompt === undefined || !redact
    ? sourceSystemPrompt
    : defaultSecretRedactor.redact(sourceSystemPrompt);
  const tools = exportTools(options.tools, redact);
  const skills = options.skills === undefined || options.skills.length === 0
    ? undefined
    : options.skills.map((skill) => ({
        name: redact ? defaultSecretRedactor.redact(skill.name) : skill.name,
        description: redact ? defaultSecretRedactor.redact(skill.description) : skill.description,
      }));
  const renderedTools = preRenderTools(
    entries,
    options.toolRenderer,
    theme,
    redact,
    options.onToolRendererDiagnostic,
  );
  const jsonl = redact
    ? serializeSessionRecords(header, entries, {
        redact: true,
        leafId,
        ...(name === undefined ? {} : { name }),
        labels,
      })
    : options.sourceJsonl ?? serializedSession(manager);
  return {
    schemaVersion: 1,
    product: "rigyn",
    title: redact
      ? defaultSecretRedactor.redact(name ?? "rigyn session")
      : name ?? "rigyn session",
    theme,
    header: redact ? redactedSessionHeader(header) : structuredClone(header),
    entries: projectedEntries,
    leafId,
    tree: buildSessionExportTree(projectedEntries, leafId, projectedLabels),
    jsonl,
    usage: sessionExportUsage(entries),
    ...(systemPrompt === undefined || systemPrompt === "" ? {} : { systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(renderedTools === undefined ? {} : { renderedTools }),
    ...(redact ? { redacted: true } : {}),
  };
}

function encodeSessionData(data: SessionExportData): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64");
}

export function renderSessionHtml(manager: SessionManager, options: RenderSessionHtmlOptions = {}): string {
  const payload = encodeSessionData(buildSessionExportData(manager, options));
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
    "<title>rigyn session export</title>",
    `<style>${SESSION_EXPORT_STYLE}</style></head><body>`,
    '<div id="overlay"></div><div id="app">',
    '<aside id="sidebar"><div class="sidebar-head">',
    '<div class="sidebar-title"><strong>Session tree</strong><button id="mobile-close" class="compact-button" type="button" aria-label="Close navigation">Close</button></div>',
    '<input id="tree-search" class="tree-search" type="search" placeholder="Search the session" autocomplete="off" maxlength="256">',
    '<div class="filters" role="group" aria-label="Tree filter">',
    '<button class="compact-button" type="button" data-filter="default" aria-pressed="true">Default</button>',
    '<button class="compact-button" type="button" data-filter="no-tools" aria-pressed="false">No tools</button>',
    '<button class="compact-button" type="button" data-filter="user" aria-pressed="false">User</button>',
    '<button class="compact-button" type="button" data-filter="labeled" aria-pressed="false">Labeled</button>',
    '<button class="compact-button" type="button" data-filter="all" aria-pressed="false">All</button>',
    '</div></div><nav id="tree" class="tree" aria-label="Session branches"></nav><div id="tree-count" class="tree-count"></div></aside>',
    '<div id="resizer" role="separator" aria-orientation="vertical" aria-label="Resize session tree"></div>',
    '<main id="content"><div class="content-inner">',
    '<div class="topbar"><div><h1 id="session-title"></h1><div id="session-meta" class="meta"></div></div>',
    '<button id="mobile-open" class="compact-button" type="button" aria-label="Open navigation">Branches</button></div>',
    '<div class="viewer-actions">',
    '<button id="toggle-tools" class="compact-button" type="button" aria-pressed="true">Tools</button>',
    '<button id="toggle-thinking" class="compact-button" type="button" aria-pressed="true">Thinking</button>',
    `<button id="download-jsonl" class="compact-button" type="button">${options.redact === true ? "Download redacted JSONL" : "Download original JSONL"}</button>`,
    '</div>',
    '<div class="usage-grid" aria-label="Historical usage totals">',
    '<div class="usage-cell"><span>Input</span><strong id="usage-input">unavailable</strong><small id="usage-input-cost">unavailable</small></div>',
    '<div class="usage-cell"><span>Output</span><strong id="usage-output">unavailable</strong><small id="usage-output-cost">unavailable</small></div>',
    '<div class="usage-cell"><span>Cache read</span><strong id="usage-cache-read">unavailable</strong><small id="usage-cache-read-cost">unavailable</small></div>',
    '<div class="usage-cell"><span>Cache write</span><strong id="usage-cache-write">unavailable</strong><small id="usage-cache-write-cost">unavailable</small></div>',
    '<div class="usage-cell"><span>Total</span><strong id="usage-total">unavailable</strong><small id="usage-cost">unavailable</small></div>',
    '</div>',
    '<details class="session-details"><summary>Prompt, tools and skills</summary><div class="details-body">',
    '<section id="system-prompt-section"><h3>System prompt</h3><div id="system-prompt"></div></section>',
    '<section id="tools-section"><h3>Tool schemas</h3><div id="tool-schemas"></div></section>',
    '<section id="skills-section"><h3>Skills</h3><div id="skills"></div></section>',
    '</div></details><section id="messages" aria-live="polite"></section>',
    '</div></main></div>',
    '<div id="image-modal" class="image-modal" role="dialog" aria-modal="true" aria-label="Image preview"><img id="modal-image" alt=""></div>',
    `<script id="session-data" type="application/octet-stream">${payload}</script>`,
    `<script>${SESSION_EXPORT_CLIENT}</script>`,
    "</body></html>",
  ].join("\n");
}

/** Publishes a complete `0600` export without replacing or opening the destination. */
export function writePrivateExportFileSync(destinationPath: string, contents: string): void {
  const directory = dirname(destinationPath);
  let temporaryPath: string | undefined;
  let descriptor: number | undefined;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = join(directory, `.rigyn-export-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
    try {
      descriptor = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      temporaryPath = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (descriptor === undefined || temporaryPath === undefined) {
    throw new Error(`Unable to create a private temporary export beside: ${destinationPath}`);
  }

  try {
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    const completedDescriptor = descriptor;
    descriptor = undefined;
    closeSync(completedDescriptor);
    try {
      linkSync(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Export destination already exists: ${destinationPath}`, { cause: error });
      }
      throw error;
    }
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function readSessionExportSourceSync(path: string): Buffer {
  const descriptor = openSync(path, SESSION_EXPORT_READ_FLAGS);
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error(`Session path is not a regular file: ${path}`);
    if (details.size > MAX_SESSION_FILE_BYTES) {
      throw new Error(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}: ${path}`);
    }
    const snapshot = Buffer.allocUnsafe(details.size);
    let length = 0;
    while (length < snapshot.length) {
      const count = readSync(descriptor, snapshot, length, snapshot.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if (readSync(descriptor, growthProbe, 0, 1, null) !== 0) {
      throw new Error(`Session file changed while it was read: ${path}`);
    }
    return snapshot.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

export function exportSessionFile(
  inputPath: string,
  outputPath?: string,
  options: Omit<RenderSessionHtmlOptions, "sourceJsonl"> = {},
): string {
  const input = resolve(inputPath);
  if (!existsSync(input)) throw new Error(`File not found: ${input}`);
  const sourceBytes = readSessionExportSourceSync(input);
  const manager = SessionManager.openSnapshotBytes(input, sourceBytes);
  const sourceJsonl = sourceBytes.toString("utf8");
  const output = resolve(outputPath ?? `rigyn-session-${basename(input, ".jsonl")}.html`);
  writePrivateExportFileSync(output, renderSessionHtml(manager, { ...options, sourceJsonl }));
  return output;
}
