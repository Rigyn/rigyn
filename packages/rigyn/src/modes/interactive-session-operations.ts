import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { TrustStore } from "../config/trust.js";
import type { AgentSession } from "../service/agent-session.js";
import { SessionManager } from "../storage/session-manager.js";
import type { SessionInfo } from "../storage/types.js";
import type { TuiController } from "../tui/controller.js";
import { TuiSelectionCancelledError } from "../tui/controller.js";
import type { TuiAction } from "../tui/types.js";
import { listSessionCatalog } from "../cli/session-index.js";
import { sessionPickerItems } from "../cli/session-picker.js";
import { resolveSessionFile } from "../cli/session-resolution.js";
import { formatSessionReport } from "../cli/session-report.js";
import { sessionTreePickerItems } from "../cli/session-tree.js";
import { parseInteractiveExportRequest } from "../interactive/commands.js";

export interface InteractiveSessionRuntime {
  readonly session: AgentSession;
  readonly cwd: string;
  readonly services: { agentDir: string };
  newSession(): Promise<{ cancelled: boolean }>;
  switchSession(path: string): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }>;
  importFromJsonl(path: string): Promise<{ cancelled: boolean }>;
}

export interface InteractiveSessionOperationsOptions {
  runtime: InteractiveSessionRuntime;
  terminal: TuiController;
  refreshTranscript(): void;
  updateContext(): void;
  /** Uses host-specific path expansion when supplied. */
  resolveInputPath?(value: string): string;
}

export function parseInteractivePathArgument(value: string, command: string): string {
  const selected = value.trim();
  if (selected === "") return "";
  const quote = selected[0];
  if (quote !== "\"" && quote !== "'") return selected;
  if (!selected.endsWith(quote) || selected.length < 2) throw new Error(`${command} path has an unterminated quote`);
  return selected.slice(1, -1);
}

/** Shared session command implementation used by every interactive host. */
export class InteractiveSessionOperations {
  readonly #runtime: InteractiveSessionRuntime;
  readonly #terminal: TuiController;
  readonly #refreshTranscript: () => void;
  readonly #updateContext: () => void;
  readonly #resolveInputPath: (value: string) => string;
  #page: SessionInfo[] = [];
  #cursor: string | undefined;
  #pageScope: "current" | "all" = "current";
  #pageQuery = "";

  constructor(options: InteractiveSessionOperationsOptions) {
    this.#runtime = options.runtime;
    this.#terminal = options.terminal;
    this.#refreshTranscript = options.refreshTranscript;
    this.#updateContext = options.updateContext;
    this.#resolveInputPath = options.resolveInputPath ?? ((value) => resolve(this.#runtime.cwd, value));
  }

  async newSession(): Promise<void> {
    const result = await this.#runtime.newSession();
    this.#terminal.notify(result.cancelled ? "New session cancelled" : "Started a new session");
  }

  async refreshSessions(scope: "current" | "all" = "current", query = "", more = false): Promise<void> {
    const session = this.#runtime.session;
    const continuing = more && scope === this.#pageScope && query === this.#pageQuery && this.#cursor !== undefined;
    const page = await listSessionCatalog({
      cwd: this.#runtime.cwd,
      sessionDirectory: session.sessionManager.getSessionDir(),
      allWorkspaces: scope === "all",
      search: query,
      limit: 200,
      ...(continuing && this.#cursor !== undefined ? { afterPath: this.#cursor } : {}),
    });
    this.#page = continuing ? [...this.#page, ...page.sessions] : page.sessions;
    this.#cursor = page.nextPath;
    this.#pageScope = scope;
    this.#pageQuery = query;
    this.#terminal.setPickerItems("session", sessionPickerItems(this.#page, session.sessionFile));
    this.#terminal.setSessionPickerScope(scope);
    this.#terminal.setSessionPickerPagination(page.hasMore, page.hasMore ? `${this.#page.length} sessions loaded` : undefined);
  }

  async resume(argument: string): Promise<void> {
    if (argument === "--all") {
      await this.refreshSessions("all");
      this.#terminal.openPicker("session", "Resume session");
      return;
    }
    if (argument !== "") {
      const info = await resolveSessionFile({
        cwd: this.#runtime.cwd,
        reference: argument,
        sessionDirectory: this.#runtime.session.sessionManager.getSessionDir(),
        allWorkspaces: true,
      });
      await this.switchSession(info.path);
      return;
    }
    await this.refreshSessions();
    this.#terminal.openPicker("session", "Resume session");
  }

  async switchSession(path: string): Promise<void> {
    if (!this.#runtime.session.isIdle) throw new Error("Wait for the active turn or cancel it before switching sessions");
    if (!existsSync(path)) throw new Error("Selected session no longer exists");
    const result = await this.#runtime.switchSession(path);
    if (result.cancelled) this.#terminal.notify("Session switch cancelled");
  }

  async handleCatalogAction(action:
    | Extract<TuiAction, { type: "session_open" | "session_scope" | "session_search" | "session_more" }>
  ): Promise<void> {
    if (action.type === "session_open" || action.type === "session_scope") {
      await this.refreshSessions(action.type === "session_scope" ? action.scope : "current");
      if (action.type === "session_open") this.#terminal.openPicker("session", "Resume session");
    } else if (action.type === "session_search") await this.refreshSessions(action.scope, action.query);
    else await this.refreshSessions(action.scope, action.query, true);
  }

  async handleMutation(action:
    | Extract<TuiAction, { type: "session_rename" | "session_delete" }>
  ): Promise<void> {
    const path = String(action.item.value);
    if (action.type === "session_rename") {
      if (!existsSync(path)) throw new Error("Session no longer exists");
      SessionManager.open(path).appendSessionInfo(action.name);
    } else {
      if (path === this.#runtime.session.sessionFile) throw new Error("Cannot delete the active session");
      await rm(path);
    }
    await this.refreshSessions(action.scope, action.query);
  }

  async name(argument: string): Promise<void> {
    const name = argument || await this.#terminal.question("Session name: ");
    this.#runtime.session.setSessionName(name);
    this.#updateContext();
  }

  async showSession(): Promise<void> {
    const session = this.#runtime.session;
    const model = session.model;
    const context = {
      messages: session.messages,
      thinkingLevel: session.thinkingLevel,
      model: model === undefined ? null : { provider: model.provider, modelId: model.id },
    };
    const info = (await SessionManager.listAll(session.sessionManager.getSessionDir()))
      .find((entry) => entry.path === session.sessionFile);
    if (info !== undefined) {
      this.#terminal.notify(formatSessionReport({ session: info, context }));
      return;
    }
    const count = (role: string) => session.messages.filter((message) => message.role === role || (
      role === "user" && message.role === "bashExecution" && message.excludeFromContext !== true
    )).length;
    this.#terminal.notify(`Session: ${session.sessionId}\nMessages: ${count("user")} user · ${count("assistant")} assistant · ${count("tool")} tool`);
  }

  async navigateTree(): Promise<void> {
    const session = this.#runtime.session;
    const rows = sessionTreePickerItems(
      session.sessionManager.getTree(),
      new Set(session.sessionManager.getBranch().map((entry) => entry.id)),
    );
    if (rows.length === 0) { this.#terminal.notify("No entries in this session"); return; }
    let targetId: string;
    try {
      targetId = await this.#terminal.chooseSessionTree("Session Tree", rows, {
        filter: session.settingsManager.getTreeFilterMode(),
        onLabelChange(eventId, label) {
          session.setLabel(eventId, label);
          return label === undefined ? {} : { label };
        },
      });
    } catch (error) {
      if (error instanceof TuiSelectionCancelledError) return;
      throw error;
    }
    if (targetId === session.sessionManager.getLeafId()) { this.#terminal.notify("Already at this point"); return; }
    let summarize: "none" | "default" | "custom" = "none";
    if (!session.settingsManager.getBranchSummarySkipPrompt()) {
      try {
        summarize = await this.#terminal.choose("Summarize the branch being left?", [
          { label: "No summary", value: "none" as const },
          { label: "Summarize", value: "default" as const },
          { label: "Summarize with custom instructions", value: "custom" as const },
        ]);
      } catch (error) {
        if (error instanceof TuiSelectionCancelledError) return;
        throw error;
      }
    }
    let customInstructions: string | undefined;
    if (summarize === "custom") {
      try { customInstructions = (await this.#terminal.question("Summary instructions: ", undefined, { cancelable: true })).trim() || undefined; }
      catch (error) { if (error instanceof TuiSelectionCancelledError) return; throw error; }
    }
    const result = await session.navigateTree(targetId, {
      summarize: summarize !== "none",
      ...(customInstructions === undefined ? {} : { customInstructions }),
    });
    if (result.cancelled) {
      this.#terminal.notify(result.aborted === true ? "Branch summarization cancelled" : "Tree navigation cancelled");
      return;
    }
    if (result.editorText !== undefined && this.#terminal.getEditorText().trim() === "") {
      this.#terminal.setEditorText(result.editorText);
    }
    this.#refreshTranscript();
    this.#updateContext();
    this.#terminal.notify("Navigated to selected point");
  }

  async forkSession(): Promise<void> {
    const messages = this.#runtime.session.getUserMessagesForForking();
    if (messages.length === 0) { this.#terminal.notify("No user messages are available to fork from"); return; }
    let entryId: string;
    try {
      entryId = await this.#terminal.choose("Fork from user message", messages.map((message) => ({
        label: message.text.replace(/\s+/gu, " ").trim().slice(0, 500),
        detail: message.entryId,
        value: message.entryId,
      })));
    } catch (error) {
      if (error instanceof TuiSelectionCancelledError) return;
      throw error;
    }
    const result = await this.#runtime.fork(entryId);
    if (result.cancelled) { this.#terminal.notify("Fork cancelled"); return; }
    this.#terminal.setEditorText(result.selectedText ?? "");
    this.#terminal.notify("Forked to a new session");
  }

  async cloneSession(): Promise<void> {
    const leafId = this.#runtime.session.sessionManager.getLeafId();
    if (leafId === null) { this.#terminal.notify("Nothing to clone yet"); return; }
    const result = await this.#runtime.fork(leafId, { position: "at" });
    if (result.cancelled) this.#terminal.notify("Clone cancelled");
    else { this.#terminal.setEditorText(""); this.#terminal.notify("Cloned to a new session"); }
  }

  async exportSession(argument: string, forceRedact: boolean): Promise<void> {
    const request = forceRedact ? { redact: true, pathArgument: argument } : parseInteractiveExportRequest(argument);
    const selected = parseInteractivePathArgument(request.pathArgument, request.redact ? "/share" : "/export");
    const path = resolve(this.#runtime.cwd, selected || `${this.#runtime.session.sessionId}.html`);
    if (extname(path).toLowerCase() === ".jsonl") this.#runtime.session.exportToJsonl(path, { redact: request.redact });
    else await this.#runtime.session.exportToHtml(path, { redact: request.redact });
    this.#terminal.notify(`Exported ${path}`);
  }

  async importSession(argument: string): Promise<void> {
    const selected = parseInteractivePathArgument(argument, "/import");
    if (selected === "") throw new Error("Usage: /import <path.jsonl>");
    const path = this.#resolveInputPath(selected);
    const confirmed = await this.#terminal.choose("Import session", [
      { label: "Import and replace current session", detail: path, value: true },
      { label: "Cancel", value: false },
    ]);
    if (!confirmed) { this.#terminal.notify("Import cancelled"); return; }
    const result = await this.#runtime.importFromJsonl(path);
    this.#terminal.notify(result.cancelled ? "Import cancelled" : `Imported session from ${path}`);
  }

  async saveProjectTrust(): Promise<void> {
    const store = new TrustStore(join(this.#runtime.services.agentDir, "trusted-workspaces.json"));
    const workspace = this.#runtime.cwd;
    const action = await this.#terminal.choose("Project trust", [
      { label: "Trust this workspace", detail: workspace, value: "trust" as const },
      { label: "Trust workspace and descendants", detail: workspace, value: "descendants" as const },
      { label: "Do not trust this workspace", detail: workspace, value: "deny" as const },
      { label: "Remove saved decision", detail: workspace, value: "remove" as const },
    ]);
    if (action === "trust") await store.trust(workspace);
    else if (action === "descendants") await store.trustDescendants(workspace);
    else if (action === "deny") await store.deny(workspace);
    else await store.untrust(workspace);
    this.#terminal.notify("Saved project trust decision. Restart Rigyn for it to take effect.");
  }

  showContext(): void {
    this.#terminal.notify(`Context messages: ${this.#runtime.session.messages.length}`);
  }

  copyLatestAssistant(required = true): void {
    const value = this.#runtime.session.getLastAssistantText();
    if (value === undefined) {
      if (required) throw new Error("No assistant text is available");
      return;
    }
    this.#terminal.copyToClipboard(value);
  }

  async compact(argument: string): Promise<void> {
    const result = await this.#runtime.session.compact(argument || undefined);
    this.#refreshTranscript();
    this.#terminal.notify(`Context compacted from ${result.tokensBefore} estimated tokens`);
  }
}
