import type { ImageContent, TextContent, Usage } from "@rigyn/models";
import type { AgentMessage } from "../../types.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.js";
import type { PendingSessionWrite, SessionContext, SessionMetadata, SessionStorage, SessionTreeEntry } from "../types.js";
import { SessionError } from "../types.js";

export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];
export type CustomEntryContextMessageProjector = (entry: Extract<SessionTreeEntry, { type: "custom" }>, index: number, entries: readonly SessionTreeEntry[]) => readonly AgentMessage[] | undefined;
export interface SessionContextBuildOptions { entryTransforms?: readonly ContextEntryTransform[]; entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>; }

export function defaultContextEntryTransform(path: readonly SessionTreeEntry[]): SessionTreeEntry[] {
  const latest = [...path].reverse().find((entry): entry is Extract<SessionTreeEntry, { type: "compaction" }> => entry.type === "compaction");
  if (!latest) return [...path];
  const compactAt = path.findIndex((entry) => entry.id === latest.id);
  if (latest.retainedTail) return [latest, ...path.slice(compactAt + 1)];
  const firstKept = latest.firstKeptEntryId === undefined ? -1 : path.findIndex((entry) => entry.id === latest.firstKeptEntryId);
  const before = firstKept >= 0 && firstKept < compactAt ? path.slice(firstKept, compactAt) : [];
  return [latest, ...before, ...path.slice(compactAt + 1)];
}
export function buildContextEntries(path: readonly SessionTreeEntry[], options: SessionContextBuildOptions = {}): SessionTreeEntry[] {
  let result = defaultContextEntryTransform(path);
  for (const transform of options.entryTransforms ?? []) result = [...transform(result)];
  return result;
}
export function sessionEntryToContextMessages(entry: SessionTreeEntry, index: number, entries: readonly SessionTreeEntry[], options: SessionContextBuildOptions = {}): AgentMessage[] {
  if (entry.type === "message") return [entry.message];
  if (entry.type === "custom_message") return [createCustomMessage(entry.customType, entry.content as string | Array<TextContent | ImageContent>, entry.display, entry.details, entry.timestamp)];
  if (entry.type === "compaction") return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...(entry.retainedTail ?? [])];
  if (entry.type === "branch_summary" && entry.summary) return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  if (entry.type === "custom") return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
  return [];
}
export function buildSessionContext(path: readonly SessionTreeEntry[], options: SessionContextBuildOptions = {}): SessionContext {
  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  let activeToolNames: string[] | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    else if (entry.type === "message" && entry.message.role === "assistant") model = { provider: entry.message.provider, modelId: entry.message.model };
    else if (entry.type === "active_tools_change") activeToolNames = entry.activeToolNames.slice();
  }
  const contextEntries = buildContextEntries(path, options);
  return { thinkingLevel, model, activeToolNames, messages: contextEntries.flatMap((entry, index) => sessionEntryToContextMessages(entry, index, contextEntries, options)) };
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
  constructor(readonly storage: SessionStorage<TMetadata>, readonly contextBuildOptions: SessionContextBuildOptions = {}) {}
  getMetadata(): Promise<TMetadata> { return this.storage.getMetadata(); }
  getStorage(): SessionStorage<TMetadata> { return this.storage; }
  getLeafId(): Promise<string | null> { return this.storage.getLeafId(); }
  getEntry(id: string): Promise<SessionTreeEntry | undefined> { return this.storage.getEntry(id); }
  getEntries(): Promise<SessionTreeEntry[]> { return this.storage.getEntries(); }
  getLabel(id: string): Promise<string | undefined> { return this.storage.getLabel(id); }
  async getBranch(fromId?: string): Promise<SessionTreeEntry[]> { return this.storage.getPathToRootOrCompaction(fromId ?? await this.storage.getLeafId()); }
  #merge(options: SessionContextBuildOptions): SessionContextBuildOptions { return { entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])], entryProjectors: { ...(this.contextBuildOptions.entryProjectors ?? {}), ...(options.entryProjectors ?? {}) } }; }
  async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> { return buildContextEntries(await this.getBranch(), this.#merge(options)); }
  async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> { return buildSessionContext(await this.storage.getPathToRoot(await this.storage.getLeafId()), this.#merge(options)); }
  async getSessionName(): Promise<string | undefined> { return (await this.storage.findEntries("session_info")).at(-1)?.name?.trim() || undefined; }
  async #append(entry: PendingSessionWrite): Promise<string> {
    const full = { ...entry, id: await this.storage.createEntryId(), parentId: await this.storage.getLeafId(), timestamp: new Date().toISOString() } as SessionTreeEntry;
    await this.storage.appendEntry(full); return full.id;
  }
  appendMessage(message: AgentMessage): Promise<string> { return this.#append({ type: "message", message }); }
  appendThinkingLevelChange(thinkingLevel: string): Promise<string> { return this.#append({ type: "thinking_level_change", thinkingLevel }); }
  appendModelChange(provider: string, modelId: string): Promise<string> { return this.#append({ type: "model_change", provider, modelId }); }
  appendActiveToolsChange(activeToolNames: string[]): Promise<string> { return this.#append({ type: "active_tools_change", activeToolNames: activeToolNames.slice() }); }
  appendCompaction<T>(summary: string, firstKeptEntryId: string | undefined, tokensBefore: number, details?: T, fromHook?: boolean, usage?: Usage, retainedTail?: AgentMessage[]): Promise<string> { return this.#append({ type: "compaction", summary, ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }), tokensBefore, ...(retainedTail === undefined ? {} : { retainedTail }), ...(details === undefined ? {} : { details }), ...(usage === undefined ? {} : { usage }), ...(fromHook === undefined ? {} : { fromHook }) }); }
  appendCustomEntry(customType: string, data?: unknown): Promise<string> { return this.#append({ type: "custom", customType, ...(data === undefined ? {} : { data }) }); }
  appendCustomMessageEntry<T>(customType: string, content: string | Array<TextContent | ImageContent>, display: boolean, details?: T): Promise<string> { return this.#append({ type: "custom_message", customType, content, display, ...(details === undefined ? {} : { details }) }); }
  async appendLabel(targetId: string, label: string | undefined): Promise<string> { if (!await this.storage.getEntry(targetId)) throw new SessionError("not_found", `Entry ${targetId} not found`); return this.#append({ type: "label", targetId, label }); }
  appendSessionName(name: string): Promise<string> { return this.#append({ type: "session_info", name: name.replace(/[\r\n]+/g, " ").trim() }); }
  async moveTo(entryId: string | null, summary?: { summary: string; details?: unknown; usage?: Usage; fromHook?: boolean }): Promise<string | undefined> {
    if (entryId !== null && !await this.storage.getEntry(entryId)) throw new SessionError("not_found", `Entry ${entryId} not found`);
    await this.storage.setLeafId(entryId);
    if (!summary) return undefined;
    return this.#append({ type: "branch_summary", fromId: entryId ?? "root", summary: summary.summary, ...(summary.details === undefined ? {} : { details: summary.details }), ...(summary.usage === undefined ? {} : { usage: summary.usage }), ...(summary.fromHook === undefined ? {} : { fromHook: summary.fromHook }) });
  }
}
