import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { TrustStore } from "../config/trust.js";
import { DirectProcessRunner } from "../process/runner.js";
import type { CommandResult, ProcessRunner } from "../process/types.js";
import type { AgentSession } from "../service/agent-session.js";
import { MissingSessionCwdError } from "../service/agent-session-runtime.js";
import { SessionManager } from "../storage/session-manager.js";
import type { SessionInfo } from "../storage/types.js";
import type { TuiController } from "../tui/controller.js";
import { DEFAULT_TUI_LIMITS, TuiSelectionCancelledError } from "../tui/controller.js";
import type { PickerItem, SessionTreeMetadata, TuiAction } from "../tui/types.js";
import { sameFilesystemPath } from "../utils/paths.js";
import { projectConfigRootMatchesAgentDir } from "../utils/project-scope.js";
import { listSessionCatalog, type SessionCatalogPage, type SessionCatalogQuery } from "../cli/session-index.js";
import { SessionLoadGate } from "../cli/session-load-gate.js";
import { sessionPickerItems } from "../cli/session-picker.js";
import { resolveSessionFile } from "../cli/session-resolution.js";
import { formatSessionReport, formatSessionUsageReport } from "../cli/session-report.js";
import { sessionTreePickerItems } from "../cli/session-tree.js";
import { parseInteractiveExportRequest } from "../interactive/commands.js";
import { interruptInteractiveRunForCommand } from "./interactive-interruption-recovery.js";
import { restoreQueuedMessagesThenAbort } from "./interactive-queue.js";
import { deleteSessionFile } from "./session-file-deletion.js";

export interface InteractiveSessionRuntime {
  readonly session: AgentSession;
  readonly cwd: string;
  readonly services: { agentDir: string };
  newSession(options?: { signal?: AbortSignal }): Promise<{ cancelled: boolean }>;
  switchSession(path: string, options?: { cwdOverride?: string; signal?: AbortSignal }): Promise<{ cancelled: boolean }>;
  fork(
    entryId: string,
    options?: { position?: "before" | "at"; signal?: AbortSignal },
  ): Promise<{ cancelled: boolean; selectedText?: string }>;
  importFromJsonl(path: string, cwdOverride?: string, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
}

type TranscriptRefreshOptions = { preserveExisting?: boolean };

export interface InteractiveSessionOperationsOptions {
  runtime: InteractiveSessionRuntime;
  terminal: TuiController;
  refreshTranscript(options?: TranscriptRefreshOptions): void;
  updateContext(): void;
  /** Uses host-specific path expansion when supplied. */
  resolveInputPath?(value: string): string;
  /** Test and embedding seam for bounded local helper processes. */
  processRunner?: ProcessRunner;
  /** Deterministic test seam for asynchronous session-catalog loads. */
  sessionCatalogLoader?(query: SessionCatalogQuery): Promise<SessionCatalogPage>;
  /** Lets the interactive owner route Escape to an active branch summary without closing the tree flow. */
  registerSummaryCancelHandler?(handler: () => void): () => void;
}

const SHARE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const TREE_OLDER_PAGE = Symbol("tree-older-page");
const TREE_NEWER_PAGE = Symbol("tree-newer-page");
const TREE_OLDER_EVENT_ID = "rigyn-tree-page-older";
const TREE_NEWER_EVENT_ID = "rigyn-tree-page-newer";
type TreePickerValue = string | typeof TREE_OLDER_PAGE | typeof TREE_NEWER_PAGE;

function runtimeSessionManager(session: AgentSession): SessionManager {
  const compatible = session as AgentSession & { nativeSessionManager?: SessionManager };
  return compatible.nativeSessionManager ?? compatible.sessionManager as unknown as SessionManager;
}

function treePageItem(
  value: typeof TREE_OLDER_PAGE | typeof TREE_NEWER_PAGE,
  label: string,
  detail: string,
): PickerItem<TreePickerValue> & { tree: SessionTreeMetadata } {
  const eventId = value === TREE_OLDER_PAGE ? TREE_OLDER_EVENT_ID : TREE_NEWER_EVENT_ID;
  return {
    id: eventId,
    label,
    detail,
    value,
    tree: {
      eventId,
      kind: "navigation",
      depth: 0,
      prefix: "",
      branches: [],
      paths: [],
      active: false,
    },
  };
}

function processFailure(result: CommandResult, fallback: string): string {
  if (result.timedOut) return `${fallback}: command timed out`;
  if (result.cancelled) return `${fallback}: command was cancelled`;
  const detail = defaultSecretRedactor.redact(result.stderr.toString("utf8").trim());
  return detail === "" ? fallback : `${fallback}: ${detail}`;
}

function secretGistUrl(output: string): string {
  for (const candidate of output.trim().split(/\s+/u).reverse()) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "gist.github.com" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname.split("/").filter(Boolean).length >= 2
      ) return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    } catch {
      // Continue until the bounded CLI output yields a valid Gist URL.
    }
  }
  throw new Error("GitHub CLI did not return a valid Gist URL");
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
  readonly #refreshTranscript: (options?: TranscriptRefreshOptions) => void;
  readonly #updateContext: () => void;
  readonly #resolveInputPath: (value: string) => string;
  readonly #processRunner: ProcessRunner;
  readonly #sessionCatalogLoader: (query: SessionCatalogQuery) => Promise<SessionCatalogPage>;
  readonly #registerSummaryCancelHandler: (handler: () => void) => () => void;
  readonly #catalogLoads = new SessionLoadGate<SessionCatalogPage>();
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
    this.#processRunner = options.processRunner ?? new DirectProcessRunner();
    this.#sessionCatalogLoader = options.sessionCatalogLoader ?? listSessionCatalog;
    this.#registerSummaryCancelHandler = options.registerSummaryCancelHandler ?? (() => () => undefined);
  }

  async newSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const result = await this.#runtime.newSession(signal === undefined ? undefined : { signal });
    this.#terminal.notify(result.cancelled ? "New session cancelled" : "Started a new session");
  }

  async recover(argument: string, signal?: AbortSignal): Promise<void> {
    const values = argument.trim() === "" ? [] : argument.trim().split(/\s+/u);
    if (values.length !== 0 && (values.length !== 2 || values[0] !== "abandon")) {
      throw new Error("Usage: /recover [abandon EFFECT_ID]");
    }
    const recoveryOptions = {
      ...(signal === undefined ? {} : { signal }),
      ...(values.length === 0
        ? {}
        : { resolutions: [{ effectId: values[1]!, outcome: "abandoned" as const }] }),
    };
    let result = await this.#runtime.session.recoverInterruptedRun(recoveryOptions);
    let automaticallyAbandoned = 0;
    if (!result.recovered && values.length === 0 && result.blocked.length > 0) {
      const blocked = result.blocked;
      automaticallyAbandoned = blocked.length;
      result = await this.#runtime.session.recoverInterruptedRun({
        ...(signal === undefined ? {} : { signal }),
        resolutions: blocked.map((entry) => ({
          effectId: entry.effectId,
          outcome: "abandoned" as const,
        })),
      });
    }
    if (result.recovered) {
      this.#terminal.notify(
        automaticallyAbandoned === 0
          ? `Recovered interrupted operation ${result.operationId}.`
          : `Recovered interrupted operation ${result.operationId}; abandoned ${automaticallyAbandoned} ` +
            `blocked tool call${automaticallyAbandoned === 1 ? "" : "s"} without replay.`,
        "status",
      );
      return;
    }
    if (result.operationId === undefined) {
      this.#terminal.notify("No interrupted operation needs recovery.", "status");
      return;
    }
    this.#terminal.notify([
      `Interrupted operation ${result.operationId} still needs a decision:`,
      ...result.blocked.map((entry) => `- ${entry.effectId} (${entry.name}): ${entry.reason}`),
      "Automatic recovery could not settle this operation. Retry /recover or use /recover abandon EFFECT_ID.",
    ].join("\n"), "warning");
  }

  async recoverAtStartup(signal?: AbortSignal): Promise<void> {
    const result = await this.#runtime.session.recoverInterruptedRun(
      signal === undefined ? {} : { signal },
    );
    if (result.recovered) {
      this.#terminal.notify(`Recovered interrupted operation ${result.operationId}.`, "status");
      return;
    }
    if (result.operationId === undefined) return;
    this.#terminal.notify([
      `Interrupted operation ${result.operationId} needs a decision:`,
      ...result.blocked.map((entry) => `- ${entry.effectId} (${entry.name}): ${entry.reason}`),
      "Run /recover to settle the remaining effects without replaying unsafe tools.",
    ].join("\n"), "warning");
  }

  async refreshSessions(scope: "current" | "all" = "current", query = "", more = false): Promise<void> {
    const session = this.#runtime.session;
    const manager = runtimeSessionManager(session);
    const sessionDirectory = scope === "all" && manager.usesDefaultSessionDir()
      ? undefined
      : manager.getSessionDir();
    const continuing = more && scope === this.#pageScope && query === this.#pageQuery && this.#cursor !== undefined;
    const afterPath = continuing ? this.#cursor : undefined;
    const requestKey = JSON.stringify([scope, query, afterPath ?? null]);
    const result = await this.#catalogLoads.request(requestKey, async () => await this.#sessionCatalogLoader({
      cwd: this.#runtime.cwd,
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
      allWorkspaces: scope === "all",
      search: query,
      limit: 200,
      ...(afterPath === undefined ? {} : { afterPath }),
    }));
    if (!result.current) return;
    const page = result.value;
    this.#page = continuing ? [...this.#page, ...page.sessions] : page.sessions;
    this.#cursor = page.nextPath;
    this.#pageScope = scope;
    this.#pageQuery = query;
    this.#terminal.setPickerItems("session", sessionPickerItems(this.#page, session.sessionFile));
    this.#terminal.setSessionPickerScope(scope);
    this.#terminal.setSessionPickerPagination(page.hasMore, page.hasMore ? `${this.#page.length} sessions loaded` : undefined);
  }

  async resume(argument: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (argument === "--all") {
      await this.refreshSessions("all");
      signal?.throwIfAborted();
      this.#terminal.openPicker("session", "Resume session");
      return;
    }
    if (argument !== "") {
      const manager = runtimeSessionManager(this.#runtime.session);
      const sessionDirectory = manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir();
      const info = await resolveSessionFile({
        cwd: this.#runtime.cwd,
        reference: argument,
        ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
        allWorkspaces: true,
      });
      signal?.throwIfAborted();
      await this.switchSession(info.path, signal);
      return;
    }
    await this.refreshSessions();
    signal?.throwIfAborted();
    this.#terminal.openPicker("session", "Resume session");
  }

  async switchSession(path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#runtime.session.isIdle) throw new Error("Wait for the active turn or cancel it before switching sessions");
    if (!existsSync(path)) throw new Error("Selected session no longer exists");
    let result: { cancelled: boolean };
    let recovered = false;
    try {
      result = await this.#runtime.switchSession(path, signal === undefined ? undefined : { signal });
    } catch (error) {
      if (!(error instanceof MissingSessionCwdError)) throw error;
      const selectedCwd = await this.#selectFallbackCwd(error, signal);
      if (selectedCwd === undefined) { this.#terminal.notify("Session switch cancelled"); return; }
      result = await this.#runtime.switchSession(path, {
        cwdOverride: selectedCwd,
        ...(signal === undefined ? {} : { signal }),
      });
      recovered = true;
    }
    if (result.cancelled) this.#terminal.notify("Session switch cancelled");
    else if (recovered) this.#terminal.notify("Resumed session in current working directory");
  }

  async #selectFallbackCwd(
    error: MissingSessionCwdError,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.#terminal.choose("Session working directory not found", [
        {
          label: "Continue in current working directory",
          detail: error.issue.fallbackCwd,
          value: error.issue.fallbackCwd,
        },
        {
          label: "Cancel",
          detail: `Missing: ${error.issue.sessionCwd}`,
          value: undefined,
        },
      ], signal);
    } catch (selectionError) {
      if (!(selectionError instanceof TuiSelectionCancelledError)) throw selectionError;
      return undefined;
    }
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
    | Extract<TuiAction, { type: "session_delete" }>
  ): Promise<void> {
    const path = String(action.item.value);
    if (
      this.#runtime.session.sessionFile !== undefined &&
      sameFilesystemPath(path, this.#runtime.session.sessionFile)
    ) throw new Error("Cannot delete the active session");
    const method = await deleteSessionFile(path, {
      cwd: this.#runtime.cwd,
      processRunner: this.#processRunner,
    });
    this.#terminal.notify(method === "trash" ? "Session moved to trash" : "Session deleted permanently");
    await this.refreshSessions(action.scope, action.query);
  }

  async name(argument: string): Promise<void> {
    const name = argument || await this.#terminal.question("Session name: ");
    this.#runtime.session.setSessionName(name);
    this.#updateContext();
  }

  async showSession(): Promise<void> {
    const session = this.#runtime.session;
    const stats = session.getSessionStats();
    const model = session.model;
    const context = {
      model: model === undefined ? null : { provider: model.provider, modelId: model.id },
    };
    const info = (await SessionManager.listAll(runtimeSessionManager(session).getSessionDir()))
      .find((entry) => entry.path === session.sessionFile);
    if (info !== undefined) {
      this.#terminal.notify(formatSessionReport({ session: info, context, stats }));
      return;
    }
    this.#terminal.notify(`Session: ${session.sessionId}\nID: ${session.sessionId}\n${formatSessionUsageReport(stats)}`);
  }

  async navigateTree(signal?: AbortSignal): Promise<void> {
    const session = this.#runtime.session;
    let initialEventId: string | undefined;
    let pageOffset: number | undefined;
    treeSelection: while (true) {
      signal?.throwIfAborted();
      const manager = runtimeSessionManager(session);
      const entryCount = manager.getEntryCount();
      const pickerLimit = this.#terminal.getPickerItemLimit?.() ?? DEFAULT_TUI_LIMITS.maxPickerItems;
      let rows: Array<PickerItem<TreePickerValue> & { tree: SessionTreeMetadata }>;
      if (entryCount <= pickerLimit) {
        rows = sessionTreePickerItems(
          manager.getTree(),
          new Set(manager.getBranch().map((entry) => entry.id)),
        );
      } else {
        const paginationSlots = pickerLimit >= 3 ? 2 : 0;
        const pageSize = Math.max(1, pickerLimit - paginationSlots);
        const maximumOffset = Math.max(0, entryCount - pageSize);
        if (pageOffset === undefined) {
          const leafId = manager.getLeafId();
          const leafSequence = leafId === null ? undefined : manager.getEntrySequence(leafId);
          pageOffset = Math.min(maximumOffset, Math.max(0, (leafSequence ?? entryCount - 1) - pageSize + 1));
        } else {
          pageOffset = Math.min(pageOffset, maximumOffset);
        }
        rows = sessionTreePickerItems(
          manager.getTreePage(pageOffset, pageSize),
          new Set(manager.getActiveBranchEntryIdsInPage(pageOffset, pageSize)),
        );
        if (paginationSlots > 0 && pageOffset > 0) {
          rows.unshift(treePageItem(
            TREE_OLDER_PAGE,
            "Earlier entries",
            `Show entries ${Math.max(1, pageOffset - pageSize + 1)}–${pageOffset}`,
          ));
        }
        if (paginationSlots > 0 && pageOffset + pageSize < entryCount) {
          rows.push(treePageItem(
            TREE_NEWER_PAGE,
            "Later entries",
            `Show entries ${pageOffset + pageSize + 1}–${Math.min(entryCount, pageOffset + pageSize * 2)}`,
          ));
        }
      }
      if (rows.length === 0) { this.#terminal.notify("No entries in this session"); return; }
      let selection: TreePickerValue;
      try {
        selection = await this.#terminal.chooseSessionTree("Session Tree", rows, {
          filter: session.settingsManager.getTreeFilterMode(),
          ...(initialEventId === undefined ? {} : { initialEventId }),
          onLabelChange(eventId, label) {
            if (eventId === TREE_OLDER_EVENT_ID || eventId === TREE_NEWER_EVENT_ID) return {};
            session.setLabel(eventId, label);
            if (label === undefined) return {};
            const sequence = manager.getEntrySequence(eventId);
            const labelTimestamp = sequence === undefined
              ? undefined
              : manager.getTreeEntryPage(sequence, 1)[0]?.labelTimestamp;
            return { label, ...(labelTimestamp === undefined ? {} : { labelTimestamp }) };
          },
        }, signal);
      } catch (error) {
        if (error instanceof TuiSelectionCancelledError) return;
        throw error;
      }
      signal?.throwIfAborted();
      if (selection === TREE_OLDER_PAGE) {
        const pageSize = Math.max(1, pickerLimit - 2);
        pageOffset = Math.max(0, (pageOffset ?? 0) - pageSize);
        initialEventId = undefined;
        continue;
      }
      if (selection === TREE_NEWER_PAGE) {
        const pageSize = Math.max(1, pickerLimit - 2);
        pageOffset = Math.min(Math.max(0, entryCount - pageSize), (pageOffset ?? 0) + pageSize);
        initialEventId = undefined;
        continue;
      }
      const targetId = selection;
      if (targetId === manager.getLeafId()) {
        this.#terminal.notify("Already at this point");
        return;
      }

      let summarize: "none" | "default" | "custom" = "none";
      let customInstructions: string | undefined;
      summaryChoice: while (!session.settingsManager.getBranchSummarySkipPrompt()) {
        try {
          summarize = await this.#terminal.choose("Summarize the branch being left?", [
            { label: "No summary", value: "none" as const },
            { label: "Summarize", value: "default" as const },
            { label: "Summarize with custom instructions", value: "custom" as const },
          ], signal);
        } catch (error) {
          if (error instanceof TuiSelectionCancelledError) {
            initialEventId = targetId;
            continue treeSelection;
          }
          throw error;
        }
        if (summarize !== "custom") break;
        try {
          customInstructions = (
            await this.#terminal.question("Summary instructions: ", signal, { cancelable: true })
          ).trim() || undefined;
          break;
        } catch (error) {
          if (error instanceof TuiSelectionCancelledError) continue summaryChoice;
          throw error;
        }
      }

      if (session.isStreaming) {
        await interruptInteractiveRunForCommand({
          session,
          command: "/tree",
          terminal: this.#terminal,
          ...(signal === undefined ? {} : { signal }),
          interrupt: async () => {
            await restoreQueuedMessagesThenAbort(session, this.#terminal, "Tree navigation requested");
          },
        });
        signal?.throwIfAborted();
      }

      const summarizing = summarize !== "none";
      const cancelNavigation = (): void => session.abortBranchSummary();
      let releaseSummaryCancelHandler = (): void => undefined;
      let presentationReleased = false;
      const releaseSummaryPresentation = (): void => {
        if (presentationReleased) return;
        presentationReleased = true;
        releaseSummaryCancelHandler();
        this.#terminal.setInputBlocked();
      };
      const cancelSummary = (): void => {
        cancelNavigation();
        releaseSummaryPresentation();
      };
      const cancelOperation = summarizing ? cancelSummary : cancelNavigation;
      let result: Awaited<ReturnType<AgentSession["navigateTree"]>>;
      signal?.addEventListener("abort", cancelOperation, { once: true });
      try {
        if (summarizing) {
          this.#terminal.setInputBlocked("Summarizing branch… Esc to cancel", "summary");
          releaseSummaryCancelHandler = this.#registerSummaryCancelHandler(cancelSummary);
        }
        signal?.throwIfAborted();
        result = await session.navigateTree(targetId, {
          summarize: summarizing,
          ...(customInstructions === undefined ? {} : { customInstructions }),
        });
        signal?.throwIfAborted();
      } finally {
        signal?.removeEventListener("abort", cancelOperation);
        if (summarizing) releaseSummaryPresentation();
      }
      if (result.cancelled) {
        this.#terminal.notify(result.aborted === true ? "Branch summarization cancelled" : "Tree navigation cancelled");
        if (result.aborted === true) {
          initialEventId = targetId;
          continue;
        }
        return;
      }
      if (result.editorText !== undefined && this.#terminal.getEditorText().trim() === "") {
        this.#terminal.setEditorText(result.editorText);
      }
      this.#refreshTranscript();
      this.#updateContext();
      this.#terminal.notify("Navigated to selected point");
      return;
    }
  }

  async forkSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const messages = this.#runtime.session.getUserMessagesForForking();
    if (messages.length === 0) { this.#terminal.notify("No user messages are available to fork from"); return; }
    let entryId: string;
    try {
      entryId = await this.#terminal.choose("Fork from user message", messages.map((message) => ({
        label: message.text.replace(/\s+/gu, " ").trim().slice(0, 500),
        detail: message.entryId,
        value: message.entryId,
      })), signal);
    } catch (error) {
      if (error instanceof TuiSelectionCancelledError) return;
      throw error;
    }
    const result = await this.#runtime.fork(entryId, signal === undefined ? undefined : { signal });
    if (result.cancelled) { this.#terminal.notify("Fork cancelled"); return; }
    this.#terminal.setEditorText(result.selectedText ?? "");
    this.#terminal.notify("Forked to a new session");
  }

  async cloneSession(argument = "", signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const leafId = runtimeSessionManager(this.#runtime.session).getLeafId();
    if (leafId === null) { this.#terminal.notify("Nothing to clone yet"); return; }
    const result = await this.#runtime.fork(leafId, {
      position: "at",
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.cancelled) this.#terminal.notify("Clone cancelled");
    else {
      const name = argument.trim();
      if (name !== "") this.#runtime.session.setSessionName(name);
      this.#terminal.setEditorText("");
      this.#terminal.notify(name === "" ? "Cloned to a new session" : `Cloned to new session "${name}"`);
    }
  }

  async exportSession(argument: string, forceRedact: boolean): Promise<void> {
    const request = forceRedact ? { redact: true, pathArgument: argument } : parseInteractiveExportRequest(argument);
    const selected = parseInteractivePathArgument(request.pathArgument, request.redact ? "/share" : "/export");
    const path = resolve(this.#runtime.cwd, selected || `${this.#runtime.session.sessionId}.html`);
    if (extname(path).toLowerCase() === ".jsonl") this.#runtime.session.exportToJsonl(path, { redact: request.redact });
    else await this.#runtime.session.exportToHtml(path, { redact: request.redact });
    this.#terminal.notify(`Exported ${path}`);
  }

  async shareSession(argument: string, signal?: AbortSignal): Promise<void> {
    if (argument.trim() !== "") throw new Error("Usage: /share");
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "rigyn-share-"));
    const path = join(temporaryDirectory, "rigyn-session.html");
    const operationSignal = signal === undefined
      ? AbortSignal.timeout(120_000)
      : AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    try {
      await this.#runtime.session.exportToHtml(path, { redact: true });
      let authentication: CommandResult;
      try {
        authentication = await this.#processRunner.run({
          argv: ["gh", "auth", "status"],
          cwd: this.#runtime.cwd,
          timeoutMs: 30_000,
          outputLimitBytes: SHARE_OUTPUT_LIMIT_BYTES,
        }, operationSignal);
      } catch (error) {
        throw new Error(
          `GitHub CLI is not available: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (authentication.exitCode !== 0) {
        throw new Error(processFailure(authentication, "GitHub CLI is not authenticated; run gh auth login"));
      }
      const shared = await this.#processRunner.run({
        argv: ["gh", "gist", "create", "--public=false", path],
        cwd: this.#runtime.cwd,
        timeoutMs: 120_000,
        outputLimitBytes: SHARE_OUTPUT_LIMIT_BYTES,
      }, operationSignal);
      if (shared.exitCode !== 0) throw new Error(processFailure(shared, "GitHub CLI could not create the Gist"));
      this.#terminal.notify(`Share URL: ${secretGistUrl(shared.stdout.toString("utf8"))}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async importSession(argument: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const selected = parseInteractivePathArgument(argument, "/import");
    if (selected === "") throw new Error("Usage: /import <path.jsonl>");
    const path = this.#resolveInputPath(selected);
    let confirmed: boolean;
    try {
      confirmed = await this.#terminal.choose("Import session", [
        { label: "Import and replace current session", detail: path, value: true },
        { label: "Cancel", value: false },
      ], signal);
    } catch (error) {
      if (!(error instanceof TuiSelectionCancelledError)) throw error;
      this.#terminal.notify("Import cancelled");
      return;
    }
    if (!confirmed) { this.#terminal.notify("Import cancelled"); return; }
    let result: { cancelled: boolean };
    try {
      result = await this.#runtime.importFromJsonl(path, undefined, signal);
    } catch (error) {
      if (!(error instanceof MissingSessionCwdError)) throw error;
      const selectedCwd = await this.#selectFallbackCwd(error, signal);
      if (selectedCwd === undefined) { this.#terminal.notify("Import cancelled"); return; }
      result = await this.#runtime.importFromJsonl(path, selectedCwd, signal);
    }
    this.#terminal.notify(result.cancelled ? "Import cancelled" : `Imported session from ${path}`);
  }

  async saveProjectTrust(): Promise<void> {
    const workspace = this.#runtime.cwd;
    const agentDir = this.#runtime.services.agentDir;
    if (projectConfigRootMatchesAgentDir(workspace, agentDir)) {
      this.#terminal.notify(
        "Project trust is unavailable because this workspace's .rigyn directory is the active Rigyn home.",
        "warning",
      );
      return;
    }
    const store = new TrustStore(join(agentDir, "trusted-workspaces.json"));
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
    this.#terminal.notify("Saved project trust decision. Restart rigyn for it to take effect.");
  }

  showContext(): void {
    const session = this.#runtime.session;
    const model = session.model;
    const usage = session.getContextUsage();
    const lines = [
      `Model: ${model === undefined ? "none" : `${model.provider}/${model.id} (${model.api})`} · thinking: ${session.thinkingLevel}`,
      usage === undefined
        ? "Context: unknown (model context window unavailable)"
        : `Context: ${usage.tokens === null ? "unknown" : usage.tokens}/${usage.contextWindow} tokens${usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`}`,
      `Messages: ${session.messages.length} · auto-compaction: ${session.autoCompactionEnabled ? "on" : "off"} · context operation: ${session.isCompacting ? "running" : "idle"}`,
    ];
    const composition = session.getPromptComposition();
    if (composition === undefined) {
      lines.push("System prompt: not composed yet");
    } else {
      const bounded = (values: readonly string[]): string => {
        const shown = values.slice(0, 12);
        return `${shown.join(", ")}${values.length > shown.length ? `, +${values.length - shown.length} more` : ""}`;
      };
      const promptKind = composition.sources.some((source) => source.source === "built-in:system-prompt")
        ? "built-in core"
        : "custom core";
      lines.push(
        `System prompt: ${composition.bytes} bytes · ${promptKind} · sha256 ${composition.sha256}${composition.truncated ? " · provenance truncated" : ""}`,
        `Prompt sources: ${composition.sources.length === 0
          ? "none"
          : bounded(composition.sources.map((source) =>
              `${source.kind.replaceAll("_", " ")}: ${JSON.stringify(source.source)}`))}`,
        `Prompt skills: ${composition.skills.length === 0
          ? "none"
          : bounded(composition.skills.map((skill) =>
              `${skill.name} (${JSON.stringify(skill.manifestPath)})`))}`,
        `Prompt tools: ${composition.tools.length === 0 ? "none" : bounded(composition.tools)}`,
      );
    }
    this.#terminal.notify(lines.join("\n"));
  }

  async copyLatestAssistant(required = true): Promise<void> {
    const value = this.#runtime.session.getLastAssistantText();
    if (value === undefined) {
      if (required) throw new Error("No assistant text is available");
      return;
    }
    await this.#terminal.copyToClipboard(value);
  }

  async compact(argument: string): Promise<void> {
    try {
      await this.#runtime.session.compact(argument || undefined);
      this.#refreshTranscript({ preserveExisting: true });
    } finally {
      this.#updateContext();
    }
  }
}
