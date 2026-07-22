import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { JsonValue } from "../core/json.js";
import type { NormalizedUsage, ToolDefinition, UsageCost } from "../core/types.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { RuntimeToolRendererBinding, RuntimeUiBlock, RuntimeUiSpan } from "../tui/components.js";
import { SESSION_EXPORT_CLIENT } from "./session-export-client.js";
import { SESSION_EXPORT_STYLE } from "./session-export-style.js";
import { SessionManager } from "./session-manager.js";
import type { SessionEntry, SessionHeader } from "./types.js";

const EXPORT_RENDER_WIDTH = 100;
const MAX_RENDERED_LINES = 2_048;
const MAX_RENDERED_SPANS_PER_LINE = 256;
const MAX_RENDERED_TEXT_BYTES = 8 * 1024 * 1024;
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: UsageCost;
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
  product: "Rigyn";
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
  tools?: readonly (ToolDefinition & { active?: boolean })[];
  skills?: readonly SessionExportSkill[];
  toolRenderer?: RuntimeToolRendererBinding;
  /** Exact source bytes used by the in-document JSONL download. */
  sourceJsonl?: string;
  /** Produce a review-required sharing copy with known secrets removed. */
  redact?: boolean;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageSources(entries: readonly SessionEntry[]): NormalizedUsage[] {
  const result: NormalizedUsage[] = [];
  for (const entry of entries) {
    if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage !== undefined) {
      result.push(entry.usage);
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if ((message.role === "assistant" || message.role === "tool") && message.usage !== undefined) {
      result.push(message.usage);
    }
  }
  return result;
}

/** Historical totals include every branch and auxiliary compaction/summary request. */
export function sessionExportUsage(entries: readonly SessionEntry[]): SessionExportUsage {
  const total: SessionExportUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of usageSources(entries)) {
    total.inputTokens += finite(usage.inputTokens);
    total.outputTokens += finite(usage.outputTokens);
    total.cacheReadTokens += finite(usage.cacheReadTokens);
    total.cacheWriteTokens += finite(usage.cacheWriteTokens);
    total.reasoningTokens += finite(usage.reasoningTokens);
    total.cost.input += finite(usage.cost?.input);
    total.cost.output += finite(usage.cost?.output);
    total.cost.cacheRead += finite(usage.cost?.cacheRead);
    total.cost.cacheWrite += finite(usage.cost?.cacheWrite);
  }
  total.totalTokens = total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  total.cost.total = total.cost.input + total.cost.output + total.cost.cacheRead + total.cost.cacheWrite;
  return total;
}

export function resolveSessionExportTheme(theme: string | undefined): "dark" | "light" {
  return theme?.trim().toLowerCase() === "light" ? "light" : "dark";
}

export function buildSessionExportTree(entries: readonly SessionEntry[], leafId: string | null): SessionExportTree {
  const labels = new Map<string, string>();
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

/** Shared policy helper for tests and non-DOM export consumers. */
export function sanitizeSessionExportUrl(value: string, kind: "link" | "image"): string | undefined {
  const selected = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (kind === "link" && /^(?:https?|mailto|tel):/iu.test(selected)) return selected;
  if (kind === "image" && /^https?:/iu.test(selected)) return selected;
  if (kind === "image" && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/iu.test(selected)) return selected;
  return undefined;
}

function serializedSession(manager: SessionManager): string {
  const source = manager.getSessionFile();
  if (source !== undefined && existsSync(source)) return readFileSync(source, "utf8");
  const header = manager.getHeader();
  if (header === null) throw new Error("Session has no header");
  return `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function serializeSessionRecords(
  header: SessionHeader,
  entries: readonly SessionEntry[],
  redact = false,
): string {
  const records = redact
    ? defaultSecretRedactor.redactValue([header, ...entries]) as Array<SessionHeader | SessionEntry>
    : [header, ...entries];
  return `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
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

function boundedSpan(
  span: RuntimeUiSpan,
  remaining: { bytes: number },
): { text: string; role?: NonNullable<RuntimeUiSpan["role"]> } | undefined {
  if (remaining.bytes <= 0) return undefined;
  let text = typeof span.text === "string" ? span.text : String(span.text ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > remaining.bytes) {
    text = Buffer.from(text, "utf8").subarray(0, remaining.bytes).toString("utf8");
  }
  remaining.bytes -= Buffer.byteLength(text, "utf8");
  const role = span.role;
  return {
    text,
    ...(role !== undefined && EXPORT_ROLES.has(role) ? { role } : {}),
  };
}

function boundedUiBlock(block: RuntimeUiBlock | undefined): RuntimeUiBlock | undefined {
  if (block === undefined) return undefined;
  const remaining = { bytes: MAX_RENDERED_TEXT_BYTES };
  const lines = block.lines.slice(0, MAX_RENDERED_LINES).map((line) => ({
    spans: line.spans.slice(0, MAX_RENDERED_SPANS_PER_LINE)
      .flatMap((span) => {
        const selected = boundedSpan(span, remaining);
        return selected === undefined ? [] : [selected];
      }),
    ...(line.fill === true ? { fill: true } : {}),
  }));
  if (block.lines.length > MAX_RENDERED_LINES || remaining.bytes <= 0) {
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
): Record<string, SessionExportRenderedTool> | undefined {
  if (renderer === undefined) return undefined;
  const calls = new Map<string, { name: string; input: JsonValue }>();
  const rendered: Record<string, SessionExportRenderedTool> = Object.create(null) as Record<string, SessionExportRenderedTool>;
  for (const entry of entries) {
    if (entry.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_call") {
        calls.set(block.callId, { name: block.name, input: block.arguments });
        if (!renderer.has(block.name)) continue;
        try {
          const selected = boundedUiBlock(renderer.renderCall(block.name, {
            callId: block.callId,
            name: block.name,
            input: block.arguments,
            status: "completed",
            expanded: false,
          }, rendererContext(false, theme)));
          if (selected !== undefined) rendered[block.callId] = { call: selected };
        } catch {
          // Export must remain available when an optional extension renderer fails.
        }
      }
      if (block.type !== "tool_result") continue;
      const call = calls.get(block.callId);
      const name = block.name || call?.name || "tool";
      if (!renderer.has(name)) continue;
      const base = {
        callId: block.callId,
        name,
        ...(call === undefined ? {} : { input: call.input }),
        result: {
          content: block.content,
          isError: block.isError,
          ...(block.metadata === undefined ? {} : { metadata: block.metadata }),
        },
        ...(block.images === undefined ? {} : { images: block.images }),
        status: block.isError ? "failed" as const : "completed" as const,
      };
      try {
        const collapsed = boundedUiBlock(renderer.renderResult(name, { ...base, expanded: false }, rendererContext(false, theme)));
        const expanded = boundedUiBlock(renderer.renderResult(name, { ...base, expanded: true }, rendererContext(true, theme)));
        if (collapsed !== undefined || expanded !== undefined) {
          rendered[block.callId] = {
            ...rendered[block.callId],
            ...(collapsed === undefined ? {} : { resultCollapsed: collapsed }),
            ...(expanded === undefined ? {} : { resultExpanded: expanded }),
          };
        }
      } catch {
        // The generic safe renderer is the deterministic fallback.
      }
    }
  }
  return Object.keys(rendered).length === 0 ? undefined : rendered;
}

function exportTools(tools: RenderSessionHtmlOptions["tools"]): SessionExportTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    active: tool.active !== false,
  }));
}

export function buildSessionExportData(
  manager: SessionManager,
  options: RenderSessionHtmlOptions = {},
): SessionExportData {
  const header = manager.getHeader();
  if (header === null) throw new Error("Session has no header");
  const entries = manager.getEntries();
  const theme = resolveSessionExportTheme(options.theme);
  const systemPrompt = options.systemPrompt || derivedSystemPrompt(entries);
  const tools = exportTools(options.tools);
  const skills = options.skills === undefined || options.skills.length === 0
    ? undefined
    : options.skills.map((skill) => ({ name: skill.name, description: skill.description }));
  const renderedTools = preRenderTools(entries, options.toolRenderer, theme);
  const data: SessionExportData = {
    schemaVersion: 1,
    product: "Rigyn",
    title: manager.getSessionName() ?? "Rigyn session",
    theme,
    header: structuredClone(header),
    entries: structuredClone(entries),
    leafId: manager.getLeafId(),
    tree: buildSessionExportTree(entries, manager.getLeafId()),
    jsonl: options.sourceJsonl ?? serializedSession(manager),
    usage: sessionExportUsage(entries),
    ...(systemPrompt === undefined || systemPrompt === "" ? {} : { systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(renderedTools === undefined ? {} : { renderedTools }),
  };
  if (options.redact !== true) return data;
  const redacted = defaultSecretRedactor.redactValue(data) as SessionExportData;
  redacted.jsonl = serializeSessionRecords(redacted.header, redacted.entries);
  redacted.redacted = true;
  return redacted;
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
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https: http:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
    "<title>Rigyn session export</title>",
    `<style>${SESSION_EXPORT_STYLE}</style></head><body>`,
    '<div id="overlay"></div><div id="app">',
    '<aside id="sidebar"><div class="sidebar-head">',
    '<div class="sidebar-title"><strong>Session tree</strong><button id="mobile-close" class="compact-button" type="button" aria-label="Close navigation">Close</button></div>',
    '<input id="tree-search" class="tree-search" type="search" placeholder="Search the session" autocomplete="off">',
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
    '<div class="usage-cell"><span>Input</span><strong id="usage-input">0</strong><small id="usage-input-cost">$0</small></div>',
    '<div class="usage-cell"><span>Output</span><strong id="usage-output">0</strong><small id="usage-output-cost">$0</small></div>',
    '<div class="usage-cell"><span>Cache read</span><strong id="usage-cache-read">0</strong><small id="usage-cache-read-cost">$0</small></div>',
    '<div class="usage-cell"><span>Cache write</span><strong id="usage-cache-write">0</strong><small id="usage-cache-write-cost">$0</small></div>',
    '<div class="usage-cell"><span>Total</span><strong id="usage-total">0</strong><small id="usage-cost">$0</small></div>',
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

export function exportSessionFile(
  inputPath: string,
  outputPath?: string,
  options: Omit<RenderSessionHtmlOptions, "sourceJsonl"> = {},
): string {
  const input = resolve(inputPath);
  if (!existsSync(input)) throw new Error(`File not found: ${input}`);
  const sourceJsonl = readFileSync(input, "utf8");
  const manager = SessionManager.open(input);
  const output = resolve(outputPath ?? `rigyn-session-${basename(input, ".jsonl")}.html`);
  writeFileSync(output, renderSessionHtml(manager, { ...options, sourceJsonl }), { encoding: "utf8", mode: 0o600 });
  return output;
}
