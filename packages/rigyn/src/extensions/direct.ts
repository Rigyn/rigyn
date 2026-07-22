import type { Static, TSchema } from "typebox";
import type { ThinkingLevel } from "@rigyn/kernel";
import type { Api, Model, Provider } from "@rigyn/models";
import type {
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  AssistantMessageEvent,
  CustomMessage,
  ImageContent,
  TextContent,
  ToolExecutionMode,
  ToolResultMessage,
  Usage,
} from "@rigyn/kernel";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  Component,
  EditorComponent,
  EditorTheme,
  KeybindingsManager,
  KeyId,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@rigyn/terminal";

import type { EventBus } from "../core/event-bus.js";
import type { BuildSystemPromptOptions } from "../core/system-prompt.js";
import type { SourceInfo } from "../core/source-info.js";
import type { SlashCommandInfo } from "../core/slash-commands.js";
import type { CompactionResult } from "../context/public-compaction.js";
import type { ReadonlyFooterDataProvider } from "../tui/footer-data.js";
import type { Theme } from "../tui/theme.js";
import type {
  ExtensionModelRegistry,
  ExtensionProviderConfig,
  ExtensionProviderModelConfig,
} from "./model-boundary.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  ExtensionSessionManager,
  ReadonlyExtensionSessionManager,
  SessionEntry,
} from "./session-contract.js";

export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  PersistedSessionMessage,
  ExtensionSessionManager,
  FileEntry,
  LabelEntry,
  ModelChangeEntry,
  ReadonlyExtensionSessionManager,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionMessageEntry,
  SessionInfoEntry,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
} from "./session-contract.js";
export type {
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  AssistantMessageEvent,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  ToolExecutionMode,
  ToolResultMessage,
  Usage,
} from "@rigyn/kernel";
export type { CompactionResult } from "../context/public-compaction.js";
export type { AppKeybindings } from "../tui/keybindings.js";

export type ExtensionMode = "tui" | "rpc" | "json" | "print";
export type InputSource = "interactive" | "rpc" | "extension";

export interface ExtensionUIDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
  placement?: WidgetPlacement;
}

export type TerminalInputHandler = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;

export interface WorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

export interface ExtensionUIContext {
  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(handler: TerminalInputHandler): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: WorkingIndicatorOptions): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(
    key: string,
    content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
    options?: ExtensionWidgetOptions,
  ): void;
  setFooter(
    factory: ((tui: TUI, theme: Theme, data: ReadonlyFooterDataProvider) => Component & { dispose?(): void }) | undefined,
  ): void;
  setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;
  setTitle(title: string): void;
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    },
  ): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  addAutocompleteProvider(factory: AutocompleteProviderFactory): void;
  setEditorComponent(factory: EditorFactory | undefined): void;
  getEditorComponent(): EditorFactory | undefined;
  readonly theme: Theme;
  getAllThemes(): { name: string; path: string | undefined }[];
  getTheme(name: string): Theme | undefined;
  setTheme(theme: string | Theme): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface CompactOptions {
  customInstructions?: string;
  onComplete?: (result: CompactionResult) => void;
  onError?: (error: Error) => void;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: ExtensionMode;
  hasUI: boolean;
  cwd: string;
  sessionManager: ReadonlyExtensionSessionManager;
  modelRegistry: ExtensionModelRegistry;
  model: Model<Api> | undefined;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}

export interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: ExtensionSessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
  fork(
    entryId: string,
    options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<{ cancelled: boolean }>;
  switchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}

export interface ReplacedSessionContext extends ExtensionCommandContext {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>;
}

export interface ToolRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

export interface ToolRenderContext<TState = unknown, TArgs = unknown> {
  args: TArgs;
  toolCallId: string;
  invalidate(): void;
  lastComponent: Component | undefined;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;
  executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
  renderCall?: (
    args: Static<TParams>,
    theme: Theme,
    context: ToolRenderContext<TState, Static<TParams>>,
  ) => Component;
  renderResult?: (
    result: AgentToolResult<TDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<TState, Static<TParams>>,
  ) => Component;
}

type AnyToolDefinition = ToolDefinition<TSchema, unknown, unknown>;

export function defineTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
  return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

export interface ProjectTrustEvent { type: "project_trust"; cwd: string }
export type ProjectTrustEventDecision = "yes" | "no" | "undecided";
export interface ProjectTrustEventResult { trusted: ProjectTrustEventDecision; remember?: boolean }
export interface ProjectTrustContext {
  cwd: string;
  mode: ExtensionMode;
  hasUI: boolean;
  ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}
export type ProjectTrustHandler = (
  event: ProjectTrustEvent,
  ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

export interface ResourcesDiscoverEvent { type: "resources_discover"; cwd: string; reason: "startup" | "reload" }
export interface ResourcesDiscoverResult { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }
export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}
export interface SessionInfoChangedEvent { type: "session_info_changed"; name: string | undefined }
export interface SessionBeforeSwitchEvent { type: "session_before_switch"; reason: "new" | "resume"; targetSessionFile?: string }
export interface SessionBeforeForkEvent { type: "session_before_fork"; entryId: string; position: "before" | "at" }
export interface CompactionFileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: CompactionFileOperations;
  settings: CompactionSettings;
}
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  signal: AbortSignal;
}
export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: CompactionEntry;
  fromExtension: boolean;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
}
export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}
export interface TreePreparation {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}
export interface SessionBeforeTreeEvent { type: "session_before_tree"; preparation: TreePreparation; signal: AbortSignal }
export interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromExtension?: boolean;
}

export type SessionEvent =
  | SessionStartEvent
  | SessionInfoChangedEvent
  | SessionBeforeSwitchEvent
  | SessionBeforeForkEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionShutdownEvent
  | SessionBeforeTreeEvent
  | SessionTreeEvent;

export interface ContextEvent { type: "context"; messages: AgentMessage[] }
export interface BeforeProviderRequestEvent { type: "before_provider_request"; payload: unknown }
export interface BeforeProviderHeadersEvent { type: "before_provider_headers"; headers: Record<string, string | null> }
export interface AfterProviderResponseEvent { type: "after_provider_response"; status: number; headers: Record<string, string> }
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
}
export interface AgentStartEvent { type: "agent_start" }
export interface AgentEndEvent { type: "agent_end"; messages: AgentMessage[] }
export interface AgentSettledEvent { type: "agent_settled" }
export interface TurnStartEvent { type: "turn_start"; turnIndex: number; timestamp: number }
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}
export interface MessageStartEvent { type: "message_start"; message: AgentMessage }
export interface MessageUpdateEvent {
  type: "message_update";
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}
export interface MessageEndEvent { type: "message_end"; message: AgentMessage }
interface ToolExecutionEventBase { toolCallId: string; toolName: string; args: unknown }
export interface ToolExecutionStartEvent extends ToolExecutionEventBase { type: "tool_execution_start" }
export interface ToolExecutionUpdateEvent extends ToolExecutionEventBase {
  type: "tool_execution_update";
  partialResult: unknown;
}
export interface ToolExecutionEndEvent extends ToolExecutionEventBase {
  type: "tool_execution_end";
  result: unknown;
  isError: boolean;
}
export type ModelSelectSource = "set" | "cycle" | "restore";
export interface ModelSelectEvent {
  type: "model_select";
  model: Model<Api>;
  previousModel: Model<Api> | undefined;
  source: ModelSelectSource;
}
export interface ThinkingLevelSelectEvent {
  type: "thinking_level_select";
  level: ThinkingLevel;
  previousLevel: ThinkingLevel;
}
export interface UserBashEvent { type: "user_bash"; command: string; excludeFromContext: boolean; cwd: string }
export interface InputEvent {
  type: "input";
  text: string;
  images?: ImageContent[];
  source: InputSource;
  streamingBehavior?: "steer" | "followUp";
}
export type InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: ImageContent[] }
  | { action: "handled" };

interface ToolCallEventBase {
  type: "tool_call";
  toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
  toolName: "bash";
  input: { command: string; timeout?: number };
}
export interface ReadToolCallEvent extends ToolCallEventBase {
  toolName: "read";
  input: { path: string; offset?: number; limit?: number };
}
export interface EditToolCallEvent extends ToolCallEventBase {
  toolName: "edit";
  input: { path: string; edits: Array<{ oldText: string; newText: string }> };
}
export interface WriteToolCallEvent extends ToolCallEventBase {
  toolName: "write";
  input: { path: string; content: string };
}
export interface GrepToolCallEvent extends ToolCallEventBase {
  toolName: "grep";
  input: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
  };
}
export interface FindToolCallEvent extends ToolCallEventBase {
  toolName: "find";
  input: { pattern: string; path?: string; limit?: number };
}
export interface LsToolCallEvent extends ToolCallEventBase {
  toolName: "ls";
  input: { path?: string; limit?: number };
}
export interface CustomToolCallEvent extends ToolCallEventBase {
  toolName: string;
  input: Record<string, unknown>;
}

export type ToolCallEvent =
  | BashToolCallEvent
  | ReadToolCallEvent
  | EditToolCallEvent
  | WriteToolCallEvent
  | GrepToolCallEvent
  | FindToolCallEvent
  | LsToolCallEvent
  | CustomToolCallEvent;

interface ToolResultEventBase {
  type: "tool_result";
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  usage?: Usage;
}

export interface BashToolResultEvent extends ToolResultEventBase { toolName: "bash"; details: unknown }
export interface ReadToolResultEvent extends ToolResultEventBase { toolName: "read"; details: unknown }
export interface EditToolResultEvent extends ToolResultEventBase { toolName: "edit"; details: unknown }
export interface WriteToolResultEvent extends ToolResultEventBase { toolName: "write"; details: undefined }
export interface GrepToolResultEvent extends ToolResultEventBase { toolName: "grep"; details: unknown }
export interface FindToolResultEvent extends ToolResultEventBase { toolName: "find"; details: unknown }
export interface LsToolResultEvent extends ToolResultEventBase { toolName: "ls"; details: unknown }
export interface CustomToolResultEvent extends ToolResultEventBase { toolName: string; details: unknown }

export type ToolResultEvent =
  | BashToolResultEvent
  | ReadToolResultEvent
  | EditToolResultEvent
  | WriteToolResultEvent
  | GrepToolResultEvent
  | FindToolResultEvent
  | LsToolResultEvent
  | CustomToolResultEvent;

export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
  toolName: TName,
  event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
  return event.toolName === toolName;
}
export function isBashToolResult(event: ToolResultEvent): event is BashToolResultEvent { return event.toolName === "bash"; }
export function isReadToolResult(event: ToolResultEvent): event is ReadToolResultEvent { return event.toolName === "read"; }
export function isEditToolResult(event: ToolResultEvent): event is EditToolResultEvent { return event.toolName === "edit"; }
export function isWriteToolResult(event: ToolResultEvent): event is WriteToolResultEvent { return event.toolName === "write"; }
export function isGrepToolResult(event: ToolResultEvent): event is GrepToolResultEvent { return event.toolName === "grep"; }
export function isFindToolResult(event: ToolResultEvent): event is FindToolResultEvent { return event.toolName === "find"; }
export function isLsToolResult(event: ToolResultEvent): event is LsToolResultEvent { return event.toolName === "ls"; }

export type ExtensionEvent =
  | ProjectTrustEvent | ResourcesDiscoverEvent | SessionStartEvent | SessionInfoChangedEvent
  | SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionBeforeCompactEvent | SessionCompactEvent
  | SessionShutdownEvent | SessionBeforeTreeEvent | SessionTreeEvent | ContextEvent
  | BeforeProviderRequestEvent | BeforeProviderHeadersEvent | AfterProviderResponseEvent
  | BeforeAgentStartEvent | AgentStartEvent | AgentEndEvent | AgentSettledEvent
  | TurnStartEvent | TurnEndEvent | MessageStartEvent | MessageUpdateEvent | MessageEndEvent
  | ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent
  | ModelSelectEvent | ThinkingLevelSelectEvent | UserBashEvent | InputEvent | ToolCallEvent | ToolResultEvent;

export interface ContextEventResult { messages?: AgentMessage[] }
export type BeforeProviderRequestEventResult = unknown;
export interface ToolCallEventResult { block?: boolean; reason?: string }
export interface UserBashEventResult { operations?: unknown; result?: { output: string; exitCode?: number; cancelled: boolean; truncated: boolean; fullOutputPath?: string } }
export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
}
export interface MessageEndEventResult { message?: AgentMessage }
export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  systemPrompt?: string;
}
export interface SessionBeforeSwitchResult { cancel?: boolean }
export interface SessionBeforeForkResult { cancel?: boolean; skipConversationRestore?: boolean }
export interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult }
export interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: { summary: string; details?: unknown; usage?: Usage };
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface MessageRenderOptions { expanded: boolean }
export interface EntryRenderOptions { expanded: boolean }
export type MessageRenderer<T = unknown> = (
  message: CustomMessage<T>,
  options: MessageRenderOptions,
  theme: Theme,
) => Component | undefined;
export type EntryRenderer<T = unknown> = (
  entry: CustomEntry<T>,
  options: EntryRenderOptions,
  theme: Theme,
) => Component | undefined;

export interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
  invocationName: string;
}

export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

export interface ToolInfo {
  name: string;
  description: string;
  parameters: TSchema;
  promptGuidelines?: string[];
  sourceInfo: SourceInfo;
}

export type DiscoverableResource =
  | {
      kind: "command";
      source: "builtin" | "runtime_extension" | "extension_template";
      name: string;
      extensionId?: string;
      description?: string;
      argumentHint?: string;
      syntax?: string;
    }
  | {
      kind: "prompt";
      name: string;
      extensionId: string;
      description?: string;
      argumentHint?: string;
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      scope: "user" | "workspace";
      trusted: boolean;
      disableModelInvocation: boolean;
    };

export interface DiscoveryView {
  resources: DiscoverableResource[];
  truncated: boolean;
  omitted: { commands: number; prompts: number; skills: number };
}

export interface ExtensionAPI {
  /** Registers generation-owned cleanup. Callbacks run once in reverse registration order after the API becomes stale. */
  onDispose(dispose: () => void | Promise<void>): void;
  on(event: "project_trust", handler: ProjectTrustHandler): void;
  on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
  on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void;
  on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
  on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;
  on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
  on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(event: "before_provider_request", handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): void;
  on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): void;
  on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
  on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
  on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
  on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
  on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
  on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
  on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
  on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void;
  registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
  registerShortcut(shortcut: KeyId, options: { description?: string; handler(ctx: ExtensionContext): Promise<void> | void }): void;
  registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void;
  getFlag(name: string): boolean | string | undefined;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp" }): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  setActiveTools(toolNames: string[]): void;
  getCommands(): SlashCommandInfo[];
  /** Returns one bounded, callback-free command, prompt, and skill discovery snapshot. */
  getDiscoveryView(signal?: AbortSignal): Promise<DiscoveryView>;
  setModel(model: Model<Api>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  registerProvider(provider: Provider): void;
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  events: EventBus;
}

export type ProviderConfig = ExtensionProviderConfig;
export type ProviderModelConfig = ExtensionProviderModelConfig;
export type ExtensionFactory = (rigyn: ExtensionAPI) => void | Promise<void>;
export type InlineExtension = ExtensionFactory | { name: string; factory: ExtensionFactory; hidden?: boolean };

export interface RegisteredTool {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
  name: string;
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
  extensionPath: string;
}

export interface ExtensionShortcut {
  shortcut: KeyId;
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
  extensionPath: string;
}

export type SendMessageHandler = <T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;
export type SendUserMessageHandler = (
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" },
) => void;
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;
export type SetSessionNameHandler = (name: string) => void;
export type GetSessionNameHandler = () => string | undefined;
export type SetLabelHandler = (entryId: string, label: string | undefined) => void;
export type GetActiveToolsHandler = () => string[];
export type GetAllToolsHandler = () => ToolInfo[];
export type GetCommandsHandler = () => SlashCommandInfo[];
export type SetActiveToolsHandler = (toolNames: string[]) => void;
export type RefreshToolsHandler = () => void;
export type SetModelHandler = (model: Model<Api>) => Promise<boolean>;
export type GetThinkingLevelHandler = () => ThinkingLevel;
export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export interface ExtensionRuntimeState {
  flagValues: Map<string, boolean | string>;
  pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
  pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
  assertActive(): void;
  invalidate(message?: string): void;
  registerProvider(name: string, config: ProviderConfig, extensionPath?: string): void;
  registerNativeProvider(provider: Provider, extensionPath?: string): void;
  unregisterProvider(name: string, extensionPath?: string): void;
}

export interface ExtensionActions {
  sendMessage: SendMessageHandler;
  sendUserMessage: SendUserMessageHandler;
  appendEntry: AppendEntryHandler;
  setSessionName: SetSessionNameHandler;
  getSessionName: GetSessionNameHandler;
  setLabel: SetLabelHandler;
  getActiveTools: GetActiveToolsHandler;
  getAllTools: GetAllToolsHandler;
  setActiveTools: SetActiveToolsHandler;
  refreshTools: RefreshToolsHandler;
  getCommands: GetCommandsHandler;
  setModel: SetModelHandler;
  getThinkingLevel: GetThinkingLevelHandler;
  setThinkingLevel: SetThinkingLevelHandler;
}

export interface ExtensionContextActions {
  getModel: () => Model<Api> | undefined;
  isIdle: () => boolean;
  isProjectTrusted: () => boolean;
  getSignal: () => AbortSignal | undefined;
  abort: () => void;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => ContextUsage | undefined;
  compact: (options?: CompactOptions) => void;
  getSystemPrompt: () => string;
  getSystemPromptOptions?: () => BuildSystemPromptOptions;
}

export interface ExtensionCommandContextActions {
  waitForIdle: () => Promise<void>;
  newSession: ExtensionCommandContext["newSession"];
  fork: ExtensionCommandContext["fork"];
  navigateTree: ExtensionCommandContext["navigateTree"];
  switchSession: ExtensionCommandContext["switchSession"];
  reload: ExtensionCommandContext["reload"];
}

export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

type RegisteredHandler = (...args: unknown[]) => Promise<unknown>;

export interface Extension {
  path: string;
  resolvedPath: string;
  hidden?: boolean;
  sourceInfo: SourceInfo;
  handlers: Map<string, RegisteredHandler[]>;
  tools: Map<string, RegisteredTool>;
  messageRenderers: Map<string, MessageRenderer>;
  entryRenderers?: Map<string, EntryRenderer>;
  commands: Map<string, RegisteredCommand>;
  flags: Map<string, ExtensionFlag>;
  shortcuts: Map<KeyId, ExtensionShortcut>;
}

export interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}

export interface ExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}
