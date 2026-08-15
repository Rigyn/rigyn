import type { AssistantMessage, Model, Transport } from "@rigyn/models";
import {
  Box,
  CancellableLoader,
  Container,
  Editor,
  getKeybindings,
  Image,
  Input,
  Loader,
  Markdown,
  parseKey,
  SelectList,
  Spacer,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorOptions,
  type EditorTheme,
  type Focusable,
  type KeybindingsManager,
  type MarkdownTheme,
  type TUI,
} from "@rigyn/terminal";
import { wrapTextWithAnsi } from "@rigyn/terminal";

import type {
  DefaultProjectTrust,
  ThinkingLevel,
  WarningSettings,
} from "../core/settings-manager.js";
import type { NormalizedUsage } from "../core/types.js";
import { normalizedCacheHitRate } from "../core/cache-usage.js";
import { normalizedContextTokens } from "../core/usage.js";
import { errorMessage } from "../core/errors.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import { isJsonValue } from "../core/json.js";
import type {
  CustomMessage,
  MarkdownTransformer,
  MessageRenderer,
  ToolDefinition,
  ToolRenderContext,
} from "../extensions/direct.js";
import type { SessionInfo, SessionTreeNode } from "../storage/types.js";
import { resolveSessionParentPaths } from "../storage/session-lineage.js";
import type { TruncationResult } from "../tools/truncate.js";
import type { KeybindingAction } from "./keybindings.js";
import { Keybindings as ConfiguredKeybindings } from "./keybindings.js";
import { elapsedText, toolCallSummary } from "./model.js";
import { editTextExternally } from "./external-editor.js";
import {
  currentTheme,
  currentThemeNames,
  getEditorTheme,
  getMarkdownTheme,
  getSelectListTheme,
  getSettingsListTheme,
  keyHint,
} from "./public-theme.js";
import {
  buildSessionPickerRows,
  type SessionPickerMetadata,
  type SessionPickerSortMode,
} from "./session-picker.js";
import { BUILTIN_THEME_NAMES, type Theme } from "./theme.js";
import { style } from "./theme.js";
import { sanitizeRuntimeUiBlock, type RuntimeUiBlock } from "./components.js";
import { byteTruncate, sanitizeTerminalText, stripAnsi } from "./unicode.js";

export type AppKeybinding = KeybindingAction;

let fallbackKeybindings: KeybindingsManager | undefined;
function currentAppKeybindings(): KeybindingsManager {
  const selected = getKeybindings();
  if (selected.getDefinition("app.message.copy") !== undefined) return selected;
  fallbackKeybindings ??= new ConfiguredKeybindings().manager();
  return fallbackKeybindings;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join("\n");
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string" || Array.isArray(record.content)) return textContent(record.content);
  if (typeof record.summary === "string") return record.summary;
  return "";
}

function inlineLabel(value: string, fallback: string, maxBytes = 256): string {
  const selected = byteTruncate(
    sanitizeTerminalText(value).replaceAll("\n", " ").replace(/\s+/gu, " ").trim(),
    maxBytes,
  );
  return selected === "" ? fallback : selected;
}

function humanFailure(value: unknown): string {
  return byteTruncate(
    sanitizeTerminalText(defaultSecretRedactor.redact(errorMessage(value))).replaceAll("\n", " "),
    4_096,
  );
}

function displayAppKey(action: AppKeybinding): string {
  const key = currentAppKeybindings().getKeys(action)[0];
  if (key === undefined) return "";
  return displayKey(key);
}

function appKeyHint(action: AppKeybinding, description: string): string {
  const key = displayAppKey(action);
  return key === "" ? description : `${key} ${description}`;
}

function displayKey(key: string): string {
  return key.split("+").map((part) =>
    part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)).join("+");
}

function selectorNavigationHint(): string {
  const keys = getKeybindings();
  const bindings = [
    ...keys.getKeys("tui.select.up"),
    ...keys.getKeys("tui.select.down"),
    "j",
    "k",
  ];
  return `${[...new Set(bindings.map(displayKey))].join("/")} navigate`;
}

const COMMAND_ZONE_START = "\x1b]133;A\x07";
const COMMAND_ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";

function transformMessageMarkdown(
  markdown: string,
  transformers: readonly MarkdownTransformer[],
  context: Parameters<MarkdownTransformer>[1],
): string {
  let selected = markdown;
  for (const transformer of transformers) {
    try {
      const transformed = transformer(selected, context);
      if (typeof transformed === "string") selected = transformed;
    } catch {
      // Presentation extensions are isolated from the readable source message.
    }
  }
  return selected;
}

class AssistantThinkingBlock implements Component {
  readonly #markdown: Markdown;
  readonly #streaming: boolean;
  readonly #outputPad: number;
  readonly #durationMs: number | undefined;

  constructor(
    markdown: Markdown,
    streaming: boolean,
    outputPad: number,
    durationMs: number | undefined,
  ) {
    this.#markdown = markdown;
    this.#streaming = streaming;
    this.#outputPad = outputPad;
    this.#durationMs = durationMs;
  }

  invalidate(): void { this.#markdown.invalidate(); }

  render(width: number): string[] {
    const maximum = Math.max(0, Math.floor(width));
    const padding = Math.min(this.#outputPad, Math.floor(maximum / 2));
    const blockWidth = Math.max(0, maximum - (padding * 2));
    if (blockWidth === 0) return [];
    const theme = currentTheme();
    const innerWidth = Math.max(0, blockWidth - 2);
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
    const spinner = frames[Math.floor(Date.now() / 80) % frames.length] ?? frames[0];
    const title = this.#streaming
      ? `${spinner} Thinking…`
      : this.#durationMs === undefined ? "Thought" : `Thought · ${elapsedText(this.#durationMs)}`;
    const visibleLabel = truncateToWidth(` ${title} `, innerWidth);
    const top = theme.fg("border", "┌")
      + theme.fg("thinkingText", visibleLabel)
      + theme.fg("border", "─".repeat(Math.max(0, innerWidth - visibleWidth(visibleLabel))))
      + (blockWidth > 1 ? theme.fg("border", "┐") : "");
    const bottom = theme.fg(
      "border",
      `└${"─".repeat(Math.max(0, blockWidth - 2))}${blockWidth > 1 ? "┘" : ""}`,
    );
    const prefix = " ".repeat(padding);
    if (!this.#streaming) return [`${prefix}${top}`, `${prefix}${bottom}`];
    const padded = innerWidth >= 3;
    const contentWidth = Math.max(0, innerWidth - (padded ? 2 : 0));
    const body = contentWidth === 0 ? [] : this.#markdown.render(contentWidth).map((line) => {
      const bounded = truncateToWidth(line, contentWidth);
      const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(bounded)));
      return prefix
        + theme.fg("border", "│")
        + (padded ? " " : "")
        + bounded
        + fill
        + (padded ? " " : "")
        + (blockWidth > 1 ? theme.fg("border", "│") : "");
    });
    return [`${prefix}${top}`, ...body, `${prefix}${bottom}`];
  }
}

export class AssistantMessageComponent extends Container {
  #message: AssistantMessage | undefined;
  #hideThinkingBlock: boolean;
  #markdownTheme: MarkdownTheme;
  #hiddenThinkingLabel: string;
  #outputPad: number;
  readonly #markdownTransformers: readonly MarkdownTransformer[];
  #hasToolCalls = false;
  #isStreaming = false;
  #thinkingStartedAt: number | undefined;
  #thinkingDurationMs: number | undefined;

  constructor(
    message?: AssistantMessage,
    hideThinkingBlock = false,
    theme: MarkdownTheme = getMarkdownTheme(),
    hiddenThinkingLabel = "Thinking...",
    outputPad = 1,
    markdownTransformers: readonly MarkdownTransformer[] = [],
  ) {
    super();
    this.#hideThinkingBlock = hideThinkingBlock;
    this.#markdownTheme = theme;
    this.#hiddenThinkingLabel = hiddenThinkingLabel;
    this.#outputPad = Math.max(0, Math.floor(outputPad));
    this.#markdownTransformers = markdownTransformers;
    if (message !== undefined) this.updateContent(message);
  }

  updateContent(message: AssistantMessage, isStreaming = this.#isStreaming): void {
    const hasVisibleThinking = message.content.some((block) =>
      block.type === "thinking" && block.redacted !== true && block.thinking.trim() !== "");
    if (isStreaming && hasVisibleThinking && this.#thinkingStartedAt === undefined) {
      this.#thinkingStartedAt = Date.now();
      this.#thinkingDurationMs = undefined;
    } else if (!isStreaming && this.#isStreaming && this.#thinkingStartedAt !== undefined) {
      this.#thinkingDurationMs = Math.max(0, Date.now() - this.#thinkingStartedAt);
      this.#thinkingStartedAt = undefined;
    } else if (!isStreaming && !this.#isStreaming && message !== this.#message) {
      this.#thinkingDurationMs = undefined;
    }
    this.#message = message;
    this.#isStreaming = isStreaming;
    this.#rebuild();
  }

  setHideThinkingBlock(hide: boolean): void { this.#hideThinkingBlock = hide; this.#rebuild(); }
  setHiddenThinkingLabel(label: string): void { this.#hiddenThinkingLabel = label; this.#rebuild(); }
  setOutputPad(padding: number): void { this.#outputPad = Math.max(0, Math.floor(padding)); this.#rebuild(); }
  override invalidate(): void { this.#rebuild(); super.invalidate(); }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.#hasToolCalls || lines.length === 0) return lines;
    lines[0] = COMMAND_ZONE_START + lines[0];
    lines[lines.length - 1] = COMMAND_ZONE_END + lines[lines.length - 1];
    return lines;
  }

  #rebuild(): void {
    this.clear();
    const content = this.#message?.content ?? [];
    this.#hasToolCalls = content.some((block) => block.type === "toolCall");
    const visible = (block: AssistantMessage["content"][number]): boolean =>
      (block.type === "text" && block.text.trim() !== "")
      || (block.type === "thinking" && block.redacted !== true && block.thinking.trim() !== "");
    if (content.some(visible)) this.addChild(new Spacer(1));
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]!;
      if (block.type === "text" && block.text.trim() !== "") {
        this.addChild(new Markdown(block.text.trim(), this.#outputPad, 0, this.#markdownTheme, undefined, {
          transform: (markdown, availableWidth) => transformMessageMarkdown(
            markdown,
            this.#markdownTransformers,
            { messageType: "assistant", isStreaming: this.#isStreaming, availableWidth },
          ),
        }));
        continue;
      }
      if (block.type !== "thinking") continue;
      const thinking: string[] = [];
      while (index < content.length && content[index]?.type === "thinking") {
        const selected = content[index] as Extract<AssistantMessage["content"][number], { type: "thinking" }>;
        const value = selected.redacted === true ? "" : selected.thinking.trim();
        if (value !== "") thinking.push(value);
        index += 1;
      }
      index -= 1;
      if (thinking.length === 0) continue;
      if (this.#hideThinkingBlock) {
        this.addChild(new Text(
          currentTheme().italic(currentTheme().fg("thinkingText", this.#hiddenThinkingLabel)),
          this.#outputPad,
          0,
        ));
      } else {
        const markdown = new Markdown(
          thinking.join("\n\n"),
          0,
          0,
          this.#markdownTheme,
          {
            color: (text) => currentTheme().fg("thinkingText", text),
            italic: true,
          },
          {
            transform: (markdown, availableWidth) => transformMessageMarkdown(
              markdown,
              this.#markdownTransformers,
              { messageType: "assistant-thinking", isStreaming: this.#isStreaming, availableWidth },
            ),
          },
        );
        this.addChild(new AssistantThinkingBlock(
          markdown,
          this.#isStreaming,
          this.#outputPad,
          this.#thinkingDurationMs,
        ));
      }
      if (content.slice(index + 1).some(visible)) this.addChild(new Spacer(1));
    }
    const stopReason = this.#message?.stopReason;
    const error = stopReason === "length"
      ? "Error: Model stopped at the maximum output token limit. The response may be incomplete."
      : !this.#hasToolCalls && stopReason === "aborted"
        ? this.#message?.errorMessage && this.#message.errorMessage !== "Request was aborted"
          ? this.#message.errorMessage
          : "Operation aborted"
        : !this.#hasToolCalls && stopReason === "error"
          ? `Error: ${this.#message?.errorMessage ?? "Unknown error"}`
          : undefined;
    if (error !== undefined) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(currentTheme().fg("error", error), this.#outputPad, 0));
    }
  }
}

export class UserMessageComponent extends Container {
  readonly #text: string;
  readonly #markdownTheme: MarkdownTheme;
  readonly #markdownTransformers: readonly MarkdownTransformer[];
  #outputPad: number;

  constructor(
    text: string,
    theme: MarkdownTheme = getMarkdownTheme(),
    outputPad = 1,
    markdownTransformers: readonly MarkdownTransformer[] = [],
  ) {
    super();
    this.#text = text;
    this.#markdownTheme = theme;
    this.#outputPad = Math.max(0, Math.floor(outputPad));
    this.#markdownTransformers = markdownTransformers;
    this.#rebuild();
  }

  setOutputPad(padding: number): void { this.#outputPad = Math.max(0, Math.floor(padding)); this.#rebuild(); }
  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    lines[0] = COMMAND_ZONE_START + lines[0];
    lines[lines.length - 1] = COMMAND_ZONE_END + lines[lines.length - 1];
    return lines;
  }
  #rebuild(): void {
    this.clear();
    const box = new Box(this.#outputPad, 1, (text) => currentTheme().bg("userMessageBg", text));
    box.addChild(new Markdown(this.#text, 0, 0, this.#markdownTheme, {
      color: (text) => currentTheme().fg("userMessageText", text),
    }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
      transform: (markdown, availableWidth) => transformMessageMarkdown(
        markdown,
        this.#markdownTransformers,
        { messageType: "user", isStreaming: false, availableWidth },
      ),
    }));
    this.addChild(box);
  }
}

class ExpandableSummary extends Box {
  #expanded = false;
  readonly #value: string;
  readonly #label: string;
  readonly #collapsedDetail: string | undefined;
  readonly #markdownTheme: MarkdownTheme;
  constructor(message: unknown, collapsedLabel: string, theme?: MarkdownTheme, collapsedDetail?: string) {
    super(1, 1, (value) => currentTheme().bg("customMessageBg", value));
    this.#value = textContent(message);
    this.#label = inlineLabel(collapsedLabel, "Summary");
    this.#collapsedDetail = collapsedDetail;
    this.#markdownTheme = theme ?? getMarkdownTheme();
    this.#update();
  }
  setExpanded(expanded: boolean): void { this.#expanded = expanded; this.#update(); }
  override invalidate(): void {
    this.setBgFn((value) => currentTheme().bg("customMessageBg", value));
    this.#update();
    super.invalidate();
  }
  #update(): void {
    this.clear();
    this.addChild(new Text(
      currentTheme().bold(currentTheme().fg("customMessageLabel", this.#label)),
      0,
      0,
    ));
    this.addChild(new Spacer(1));
    if (this.#expanded) {
      this.addChild(new Markdown(this.#value, 0, 0, this.#markdownTheme, {
        color: (value) => currentTheme().fg("customMessageText", value),
      }));
      return;
    }
    const details = [this.#collapsedDetail, appKeyHint("app.tools.expand", "to expand")]
      .filter((value): value is string => value !== undefined && value !== "")
      .join(" · ");
    this.addChild(new Text(currentTheme().fg("muted", details), 0, 0));
  }
}

export class BranchSummaryMessageComponent extends ExpandableSummary {
  constructor(message: unknown, theme?: MarkdownTheme) { super(message, "Branch summary", theme); }
}
export class CompactionSummaryMessageComponent extends ExpandableSummary {
  constructor(message: unknown, theme?: MarkdownTheme) {
    const tokens = message !== null && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).tokensBefore
      : undefined;
    const detail = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
      ? `${tokens.toLocaleString("en-US")} tokens before`
      : undefined;
    super(message, "Context compacted", theme, detail);
  }
}
export class SkillInvocationMessageComponent extends ExpandableSummary {
  constructor(message: unknown, theme?: MarkdownTheme) {
    const record = message !== null && typeof message === "object" && !Array.isArray(message)
      ? message as Record<string, unknown>
      : undefined;
    const name = [record?.skillName, record?.name, record?.id].find((value): value is string =>
      typeof value === "string" && value.trim() !== "");
    super(message, name === undefined ? "Skill invoked" : `Skill: ${inlineLabel(name, "unnamed skill")}`, theme);
  }
}

export class CustomMessageComponent extends Container {
  readonly #message: CustomMessage<unknown>;
  readonly #renderer: MessageRenderer | undefined;
  readonly #markdownTheme: MarkdownTheme;
  #outputPad: number;
  #expanded = false;

  constructor(
    message: CustomMessage<unknown>,
    renderer?: MessageRenderer,
    theme: MarkdownTheme = getMarkdownTheme(),
    outputPad = 1,
  ) {
    super();
    this.#message = message;
    this.#renderer = renderer;
    this.#markdownTheme = theme;
    this.#outputPad = Math.max(0, Math.floor(outputPad));
    this.#rebuild();
  }
  setExpanded(expanded: boolean): void { if (this.#expanded !== expanded) { this.#expanded = expanded; this.#rebuild(); } }
  setOutputPad(outputPad: number): void {
    const next = Math.max(0, Math.floor(outputPad));
    if (next !== this.#outputPad) {
      this.#outputPad = next;
      this.#rebuild();
    }
  }
  override invalidate(): void { this.#rebuild(); super.invalidate(); }
  #rebuild(): void {
    this.clear();
    this.addChild(new Spacer(1));
    if (this.#renderer !== undefined) {
      try {
        const rendered = this.#renderer(
          this.#message,
          { expanded: this.#expanded, outputPad: this.#outputPad },
          currentTheme(),
        );
        if (rendered !== undefined) { this.addChild(rendered); return; }
      } catch { /* renderer failures use the readable fallback */ }
    }
    const box = new Box(1, 1, (value) => currentTheme().bg("customMessageBg", value));
    box.addChild(new Text(currentTheme().bold(currentTheme().fg(
      "customMessageLabel",
      `[${inlineLabel(this.#message.customType, "custom")}]`,
    )), 0, 0));
    box.addChild(new Spacer(1));
    const value = typeof this.#message.content === "string"
      ? this.#message.content
      : this.#message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    box.addChild(new Markdown(value, 0, 0, this.#markdownTheme, {
      color: (text) => currentTheme().fg("customMessageText", text),
    }));
    this.addChild(box);
  }
}

export class DynamicBorder implements Component {
  constructor(private readonly color: (text: string) => string = (text) => text) {}
  invalidate(): void {}
  render(width: number): string[] { return [this.color("─".repeat(Math.max(0, width)))]; }
}

export class BorderedLoader extends Container {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #loader: CancellableLoader;
  onAbort: (() => void) | undefined;
  constructor(tui: TUI, theme: Theme, message: string, options: { cancellable?: boolean } = {}) {
    super(); this.signal = this.#controller.signal;
    this.#loader = new CancellableLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), message);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.addChild(this.#loader);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    if (options.cancellable !== false) this.#loader.onAbort = () => { this.#controller.abort(); this.onAbort?.(); };
  }
  handleInput(data: string): void { this.#loader.handleInput(data); }
  dispose(): void { this.#loader.stop(); }
}

export class CustomEditor extends Editor {
  readonly actionHandlers = new Map<AppKeybinding, () => void>();
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  constructor(tui: TUI, theme: EditorTheme, private readonly keybindings: { matches(data: string, action: AppKeybinding): boolean }, options?: EditorOptions) {
    super(tui, theme, options);
  }
  onAction(action: AppKeybinding, handler: () => void): void { this.actionHandlers.set(action, handler); }
  override handleInput(data: string): void {
    if (this.onExtensionShortcut?.(data) === true) return;
    if (this.keybindings.matches(data, "app.clipboard.pasteImage") && this.onPasteImage !== undefined) {
      this.onPasteImage();
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt")
      && !(parseKey(data) === "escape" && this.isShowingAutocomplete())
      && this.onEscape !== undefined
    ) {
      this.onEscape();
      return;
    }
    if (
      this.keybindings.matches(data, "app.exit")
      && parseKey(data) === "ctrl+d"
      && this.getText() !== ""
    ) {
      super.handleInput("\u001b[3~");
      return;
    }
    if (this.keybindings.matches(data, "app.exit") && this.onCtrlD !== undefined) {
      this.onCtrlD();
      return;
    }
    for (const [action, handler] of this.actionHandlers) {
      if (
        action !== "app.clipboard.pasteImage"
        && action !== "app.interrupt"
        && action !== "app.exit"
        && this.keybindings.matches(data, action)
      ) {
        handler();
        return;
      }
    }
    super.handleInput(data);
  }
}

class Countdown {
  readonly #timer: ReturnType<typeof setInterval>;
  #remaining: number;
  constructor(timeoutMs: number, tui: TUI, onTick: (seconds: number) => void, onExpire: () => void) {
    this.#remaining = Math.ceil(timeoutMs / 1000);
    onTick(this.#remaining);
    this.#timer = setInterval(() => {
      this.#remaining -= 1;
      onTick(this.#remaining);
      tui.requestRender();
      if (this.#remaining <= 0) { this.dispose(); onExpire(); }
    }, 1000);
    this.#timer.unref?.();
  }
  dispose(): void { clearInterval(this.#timer); }
}

export interface ExtensionInputOptions { tui?: TUI; timeout?: number }
export class ExtensionInputComponent extends Container implements Focusable {
  readonly #input = new Input();
  readonly #title: Text;
  readonly #baseTitle: string;
  readonly #onSubmit: (value: string) => void;
  readonly #onCancel: () => void;
  readonly #countdown: Countdown | undefined;
  #focused = false;
  #completed = false;

  constructor(title: string, placeholder: string | undefined, onSubmit: (value: string) => void, onCancel: () => void, options?: ExtensionInputOptions) {
    super();
    this.#baseTitle = inlineLabel(title, "Input");
    this.#onSubmit = onSubmit;
    this.#onCancel = onCancel;
    this.#title = new Text(this.#styledTitle(this.#baseTitle), 1, 0);
    this.addChild(new DynamicBorder((value) => currentTheme().fg("borderAccent", value)));
    this.addChild(new Spacer(1));
    this.addChild(this.#title);
    const hint = placeholder === undefined
      ? ""
      : byteTruncate(sanitizeTerminalText(placeholder).replaceAll("\n", " ").trim(), 512);
    if (hint !== "") this.addChild(new Text(`(${hint})`, 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.#input);
    this.addChild(new Spacer(1));
    this.addChild(new Text(currentTheme().fg(
      "muted",
      `${keyHint("tui.select.confirm", "submit")} · ${keyHint("tui.select.cancel", "cancel")}`,
    ), 1, 0));
    this.addChild(new DynamicBorder((value) => currentTheme().fg("borderAccent", value)));
    this.#countdown = options?.tui !== undefined && (options.timeout ?? 0) > 0
      ? new Countdown(
        options.timeout!,
        options.tui,
        (seconds) => this.#title.setText(this.#styledTitle(`${this.#baseTitle} (${seconds}s)`)),
        () => this.#cancel(),
      )
      : undefined;
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#input.focused = value; }
  handleInput(data: string): void {
    if (this.#completed) return;
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.confirm") || data === "\n") this.#submit();
    else if (keys.matches(data, "tui.select.cancel")) this.#cancel();
    else this.#input.handleInput(data);
  }
  dispose(): void { this.#completed = true; this.#countdown?.dispose(); }
  #submit(): void { if (!this.#completed) { this.#completed = true; this.#countdown?.dispose(); this.#onSubmit(this.#input.getValue()); } }
  #cancel(): void { if (!this.#completed) { this.#completed = true; this.#countdown?.dispose(); this.#onCancel(); } }
  #styledTitle(value: string): string { return currentTheme().bold(currentTheme().fg("accent", value)); }
}

export class ExtensionEditorComponent extends Container implements Focusable {
  readonly #editor: Editor;
  readonly #tui: TUI;
  readonly #keybindings: KeybindingsManager;
  readonly #onCancel: () => void;
  readonly #externalEditorCommand: string | undefined;
  readonly #externalEditorController = new AbortController();
  #focused = false;
  #editingExternally = false;
  #disposed = false;
  #completed = false;
  constructor(tui: TUI, keybindings: KeybindingsManager, title: string, prefill: string | undefined, onSubmit: (value: string) => void, onCancel: () => void, options?: EditorOptions, externalEditorCommand?: string) {
    super();
    this.#tui = tui;
    this.#keybindings = keybindings;
    this.#onCancel = onCancel;
    this.#externalEditorCommand = externalEditorCommand;
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text(title, 1, 0));
    this.addChild(new Spacer(1));
    this.#editor = new Editor(tui, getEditorTheme(), options);
    if (prefill !== undefined) this.#editor.setText(prefill);
    this.#editor.onSubmit = (value) => {
      if (this.#completed) return;
      this.#completed = true;
      onSubmit(value);
    };
    this.addChild(this.#editor);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#editor.focused = value; }
  handleInput(data: string): void {
    if (this.#editingExternally) return;
    if (this.#completed) return;
    if (getKeybindings().matches(data, "tui.select.cancel")) { this.#completed = true; this.#onCancel(); return; }
    if (this.#keybindings.matches(data, "app.editor.external" as never)) { void this.#openExternalEditor(); return; }
    this.#editor.handleInput(data);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#completed = true;
    this.#externalEditorController.abort(new Error("Editor closed"));
  }
  async #openExternalEditor(): Promise<void> {
    if (this.#editingExternally) return;
    this.#editingExternally = true;
    this.#tui.stop();
    try {
      const value = await editTextExternally(this.#editor.getText(), {
        ...(this.#externalEditorCommand === undefined ? {} : { command: this.#externalEditorCommand }),
        signal: this.#externalEditorController.signal,
      });
      this.#editor.setText(value.replace(/\n$/u, ""));
    } catch {
      // Closing or a failed editor leaves the in-terminal draft unchanged.
    } finally {
      this.#editingExternally = false;
      if (!this.#disposed) {
        this.#tui.start();
        this.#tui.requestRender(true);
      }
    }
  }
}

function selection(_title: string, values: readonly string[], onSelect: (value: string) => void, onCancel: () => void): SelectList {
  const list = new SelectList(values.map((value) => ({ value, label: value })), 12, getSelectListTheme());
  list.onSelect = (item) => onSelect(item.value); list.onCancel = onCancel;
  return list;
}

export interface ExtensionSelectorOptions { tui?: TUI; timeout?: number; onToggleToolsExpanded?: () => void }
export class ExtensionSelectorComponent extends Container {
  readonly #list: SelectList;
  readonly #countdown: Countdown | undefined;
  readonly #toggle: (() => void) | undefined;
  readonly #optionCount: number;
  #selectedIndex = 0;
  #completed = false;
  constructor(title: string, options: string[], onSelect: (value: string) => void, onCancel: () => void, config?: ExtensionSelectorOptions) {
    super();
    const safeTitle = inlineLabel(title, "Choose");
    const styledTitle = (value: string): string => currentTheme().bold(currentTheme().fg("accent", value));
    const titleText = new Text(styledTitle(safeTitle), 1, 0);
    this.#toggle = config?.onToggleToolsExpanded;
    this.#optionCount = options.length;
    this.addChild(new DynamicBorder((value) => currentTheme().fg("borderAccent", value)));
    this.addChild(new Spacer(1));
    this.addChild(titleText);
    this.addChild(new Spacer(1));
    this.#list = selection(title, options, (value) => this.#select(value, onSelect), () => this.#cancel(onCancel));
    this.addChild(this.#list);
    this.addChild(new Spacer(1));
    const hints = [
      selectorNavigationHint(),
      keyHint("tui.select.confirm", "select"),
      keyHint("tui.select.cancel", "cancel"),
      ...(this.#toggle === undefined ? [] : [appKeyHint("app.tools.expand", "expand tools")]),
    ].join(" · ");
    this.addChild(new Text(currentTheme().fg("muted", hints), 1, 0));
    this.addChild(new DynamicBorder((value) => currentTheme().fg("borderAccent", value)));
    this.#countdown = config?.tui !== undefined && (config.timeout ?? 0) > 0
      ? new Countdown(
        config.timeout!,
        config.tui,
        (seconds) => titleText.setText(styledTitle(`${safeTitle} (${seconds}s)`)),
        () => this.#cancel(onCancel),
      )
      : undefined;
  }
  handleInput(data: string): void {
    if (this.#completed) return;
    const terminalKeys = getKeybindings();
    if (currentAppKeybindings().matches(data, "app.tools.expand")) this.#toggle?.();
    else if (data === "j" || terminalKeys.matches(data, "tui.select.down")) this.#move(1);
    else if (data === "k" || terminalKeys.matches(data, "tui.select.up")) this.#move(-1);
    else if (parseKey(data) === "up" || parseKey(data) === "down") return;
    else this.#list.handleInput(data);
  }
  dispose(): void { this.#completed = true; this.#countdown?.dispose(); }
  #select(value: string, callback: (value: string) => void): void {
    if (this.#completed) return;
    this.#completed = true;
    this.#countdown?.dispose();
    callback(value);
  }
  #cancel(callback: () => void): void {
    if (this.#completed) return;
    this.#completed = true;
    this.#countdown?.dispose();
    callback();
  }
  #move(delta: -1 | 1): void {
    if (this.#optionCount === 0) return;
    this.#selectedIndex = Math.max(0, Math.min(this.#optionCount - 1, this.#selectedIndex + delta));
    this.#list.setSelectedIndex(this.#selectedIndex);
  }
}

class ValueSelector<T extends string> extends Container {
  readonly list: SelectList;
  #completed = false;
  constructor(values: readonly T[], current: T | undefined, onSelect: (value: T) => void, onCancel: () => void) {
    super(); this.list = selection("", values, (value) => {
      if (this.#completed) return;
      this.#completed = true;
      onSelect(value as T);
    }, () => {
      if (this.#completed) return;
      this.#completed = true;
      onCancel();
    });
    const index = current === undefined ? 0 : values.indexOf(current); this.list.setSelectedIndex(Math.max(0, index)); this.addChild(this.list);
  }
  handleInput(data: string): void { if (!this.#completed) this.list.handleInput(data); }
  dispose(): void { this.#completed = true; }
  getSelectList(): SelectList { return this.list; }
}

export class ThinkingSelectorComponent extends ValueSelector<ThinkingLevel> {
  constructor(current: ThinkingLevel, levels: ThinkingLevel[], onSelect: (level: ThinkingLevel) => void, onCancel: () => void) { super(levels, current, onSelect, onCancel); }
}
export class ShowImagesSelectorComponent extends ValueSelector<"show" | "hide"> {
  constructor(current: boolean, onSelect: (show: boolean) => void, onCancel: () => void) { super(["show", "hide"], current ? "show" : "hide", (value) => onSelect(value === "show"), onCancel); }
}
export class ThemeSelectorComponent extends ValueSelector<string> {
  constructor(
    current: string,
    onSelect: (theme: string) => void,
    onCancel: () => void,
    onPreview: (theme: string) => void,
    themes: readonly string[] = currentThemeNames(),
  ) {
    super([...new Set([current, ...BUILTIN_THEME_NAMES, ...themes])], current, onSelect, onCancel);
    this.list.onSelectionChange = (item) => onPreview(item.value);
  }
}

export class UserMessageSelectorComponent extends Container {
  readonly #list: SelectList;
  readonly #onCancel: () => void;
  #completed = false;
  constructor(messages: Array<{ id: string; text: string }>, onSelect: (id: string) => void, onCancel: () => void, initial?: string) {
    super();
    this.#onCancel = onCancel;
    this.#list = new SelectList(messages.map((message, index) => ({
      value: message.id,
      label: message.text.replace(/\s+/gu, " ").trim() || "(empty message)",
      description: `${index + 1} of ${messages.length}`,
    })), 12, getSelectListTheme());
    this.#list.onSelect = (item) => { if (this.#completed) return; this.#completed = true; onSelect(item.value); };
    this.#list.onCancel = () => this.#cancel();
    const selected = initial === undefined
      ? messages.length - 1
      : messages.findIndex((message) => message.id === initial);
    this.#list.setSelectedIndex(Math.max(0, selected));
    this.addChild(this.#list);
    if (messages.length === 0) queueMicrotask(() => this.#cancel());
  }
  handleInput(data: string): void { if (!this.#completed) this.#list.handleInput(data); }
  getMessageList(): SelectList { return this.#list; }
  #cancel(): void { if (this.#completed) return; this.#completed = true; this.#onCancel(); }
}

type PublicModel = Model;
interface ScopedPublicModel { model: PublicModel; thinkingLevel?: string }
interface ModelSelectorRuntime {
  getAvailableSnapshot(): readonly PublicModel[];
  getModel(provider: string, id: string): PublicModel | undefined;
  getError?(): string | undefined;
  refresh(options?: { signal?: AbortSignal }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
}

function sameModel(left: PublicModel | undefined, right: PublicModel | undefined): boolean {
  return left !== undefined && right !== undefined && left.provider === right.provider && left.id === right.id;
}

function searchMatch(value: string, query: string): boolean {
  const target = value.toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean).every((part) => target.includes(part));
}

export class ModelSelectorComponent extends Container implements Focusable {
  readonly #tui: TUI;
  readonly #settings: { setDefaultModelAndProvider?(provider: string, id: string): void };
  readonly #runtime: ModelSelectorRuntime;
  readonly #search = new Input();
  readonly #listContainer = new Container();
  readonly #onSelect: (model: PublicModel) => void;
  readonly #onCancel: () => void;
  readonly #controller = new AbortController();
  #all: PublicModel[] = [];
  #scoped: PublicModel[] = [];
  #filtered: PublicModel[] = [];
  #scope: "all" | "scoped";
  #selected = 0;
  #current: PublicModel | undefined;
  #focused = false;
  #closed = false;

  constructor(tui: TUI, current: PublicModel | undefined, settings: { setDefaultModelAndProvider?(provider: string, id: string): void }, runtime: ModelSelectorRuntime, scoped: readonly ScopedPublicModel[], onSelect: (model: PublicModel) => void, onCancel: () => void, initialSearchInput?: string) {
    super();
    this.#tui = tui;
    this.#current = current;
    this.#settings = settings;
    this.#runtime = runtime;
    this.#scoped = scoped.map((entry) => runtime.getModel(entry.model.provider, entry.model.id) ?? entry.model);
    this.#scope = this.#scoped.length > 0 ? "scoped" : "all";
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.#search);
    this.addChild(new Spacer(1));
    this.addChild(this.#listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    if (initialSearchInput !== undefined) this.#search.setValue(initialSearchInput);
    this.#search.onSubmit = () => this.#select();
    this.#loadSnapshot();
    this.#filter();
    tui.requestRender();
    void this.#refresh();
  }

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#search.focused = value; }
  getSearchInput(): Input { return this.#search; }
  handleInput(data: string): void {
    if (this.#closed) return;
    const keys = getKeybindings();
    if (keys.matches(data, "tui.input.tab") && this.#scoped.length > 0) {
      this.#scope = this.#scope === "all" ? "scoped" : "all";
      this.#selected = 0;
      this.#filter();
    } else if (keys.matches(data, "tui.select.up")) {
      if (this.#filtered.length > 0) this.#selected = this.#selected === 0 ? this.#filtered.length - 1 : this.#selected - 1;
      this.#renderList();
    } else if (keys.matches(data, "tui.select.down")) {
      if (this.#filtered.length > 0) this.#selected = this.#selected === this.#filtered.length - 1 ? 0 : this.#selected + 1;
      this.#renderList();
    } else if (keys.matches(data, "tui.select.confirm") || data === "\n") this.#select();
    else if (keys.matches(data, "tui.select.cancel")) { if (this.#close()) this.#onCancel(); }
    else { this.#search.handleInput(data); this.#filter(); }
  }
  dispose(): void { this.#close(); }
  #close(): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    this.#controller.abort();
    return true;
  }
  #loadSnapshot(): void {
    this.#all = [...this.#runtime.getAvailableSnapshot()].sort((left, right) => {
      const leftCurrent = sameModel(left, this.#current);
      const rightCurrent = sameModel(right, this.#current);
      return leftCurrent === rightCurrent ? left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id) : leftCurrent ? -1 : 1;
    });
    this.#scoped = this.#scoped.map((entry) => this.#runtime.getModel(entry.provider, entry.id) ?? entry);
  }
  #filter(): void {
    const active = this.#scope === "scoped" ? this.#scoped : this.#all;
    const query = this.#search.getValue();
    this.#filtered = query === "" ? [...active] : active.filter((entry) => searchMatch(`${entry.name ?? ""} ${entry.provider} ${entry.id}`, query));
    this.#selected = Math.max(0, Math.min(this.#selected, this.#filtered.length - 1));
    this.#renderList();
  }
  #renderList(): void {
    this.#listContainer.clear();
    const visible = this.#filtered.slice(Math.max(0, this.#selected - 5), Math.max(0, this.#selected - 5) + 10);
    if (visible.length === 0) this.#listContainer.addChild(new Text(this.#runtime.getError?.() ?? "  No matching models", 0, 0));
    else for (const entry of visible) {
      const selected = entry === this.#filtered[this.#selected];
      this.#listContainer.addChild(new Text(`${selected ? "→" : " "} ${entry.id} [${entry.provider}]${sameModel(entry, this.#current) ? " ✓" : ""}`, 0, 0));
    }
    this.#tui.requestRender();
  }
  #select(): void {
    if (this.#closed) return;
    const selected = this.#filtered[this.#selected];
    if (selected === undefined) return;
    this.#close();
    this.#settings.setDefaultModelAndProvider?.(selected.provider, selected.id);
    this.#onSelect(selected);
  }
  async #refresh(): Promise<void> {
    try {
      await this.#runtime.refresh({ signal: this.#controller.signal });
      if (this.#closed) return;
      this.#loadSnapshot();
      this.#filter();
    } catch {
      if (!this.#closed) this.#renderList();
    }
  }
}

export interface AuthSelectorProvider {
  id: string;
  name: string;
  authType: "oauth" | "api_key";
  method?: { name?: string };
  status?: { type?: string; source?: string };
}
export class OAuthSelectorComponent extends Container implements Focusable {
  readonly #search = new Input();
  readonly #listContainer = new Container();
  readonly #providers: AuthSelectorProvider[];
  readonly #onSelect: (id: string, authType: "oauth" | "api_key") => void;
  readonly #onCancel: () => void;
  #filtered: AuthSelectorProvider[];
  #selected = 0;
  #focused = false;
  #completed = false;
  constructor(mode: "login" | "logout", providers: AuthSelectorProvider[], onSelect: (id: string, authType: "oauth" | "api_key") => void, onCancel: () => void, initialSearchInput?: string) {
    super();
    this.#providers = [...providers];
    this.#filtered = [...providers];
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.addChild(new DynamicBorder());
    this.addChild(new Text(mode === "login" ? "Choose a provider to configure:" : "Choose a provider to sign out:", 1, 0));
    if (initialSearchInput !== undefined) this.#search.setValue(initialSearchInput);
    this.addChild(this.#search);
    this.addChild(this.#listContainer);
    this.addChild(new DynamicBorder());
    this.#search.onSubmit = () => this.#select();
    this.#filter();
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#search.focused = value; }
  handleInput(data: string): void {
    if (this.#completed) return;
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up")) { if (this.#filtered.length > 0) this.#selected = Math.max(0, this.#selected - 1); this.#renderList(); }
    else if (keys.matches(data, "tui.select.down")) { if (this.#filtered.length > 0) this.#selected = Math.min(this.#filtered.length - 1, this.#selected + 1); this.#renderList(); }
    else if (keys.matches(data, "tui.select.confirm") || data === "\n") this.#select();
    else if (keys.matches(data, "tui.select.cancel")) { this.#completed = true; this.#onCancel(); }
    else { this.#search.handleInput(data); this.#filter(); }
  }
  #select(): void {
    if (this.#completed) return;
    const selected = this.#filtered[this.#selected];
    if (selected === undefined) return;
    this.#completed = true;
    this.#onSelect(selected.id, selected.authType);
  }
  #filter(): void {
    const query = this.#search.getValue();
    this.#filtered = query === "" ? [...this.#providers] : this.#providers.filter((entry) => searchMatch(`${entry.name} ${entry.id} ${entry.authType} ${entry.method?.name ?? ""}`, query));
    this.#selected = Math.max(0, Math.min(this.#selected, this.#filtered.length - 1));
    this.#renderList();
  }
  #renderList(): void {
    this.#listContainer.clear();
    if (this.#filtered.length === 0) this.#listContainer.addChild(new Text("  No providers match the search", 0, 0));
    else {
      const start = Math.min(
        Math.max(0, this.#selected - 4),
        Math.max(0, this.#filtered.length - 8),
      );
      this.#filtered.slice(start, start + 8).forEach((provider, index) => {
        this.#listContainer.addChild(new Text(`${start + index === this.#selected ? "→" : " "} ${provider.name} [${provider.authType === "oauth" ? "OAuth" : "API key"}]`, 0, 0));
      });
    }
  }
}

type SessionsLoader = (onProgress?: (loaded: number, total: number) => void) => Promise<SessionInfo[]>;
interface PublicSessionMetadata extends SessionPickerMetadata {
  source: SessionInfo;
}

class PublicSessionList implements Component, Focusable {
  readonly #search = new Input();
  readonly #keybindings: KeybindingsManager;
  readonly #requestRender: () => void;
  readonly #currentSessionFilePath: string | undefined;
  #sessions: SessionInfo[] = [];
  #filtered: Array<{ session: SessionInfo; depth: number }> = [];
  #selected = 0;
  #focused = false;
  #showPaths = false;
  #namedOnly = false;
  #sort: SessionPickerSortMode = "threaded";
  #filterError: string | undefined;
  onSelect?: (path: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  constructor(
    keybindings: KeybindingsManager,
    requestRender: () => void,
    currentSessionFilePath?: string,
  ) {
    this.#keybindings = keybindings;
    this.#requestRender = requestRender;
    this.#currentSessionFilePath = currentSessionFilePath;
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#search.focused = value; }
  setSessions(sessions: SessionInfo[]): void {
    const selectedPath = this.getSelectedSessionPath() ?? this.#currentSessionFilePath;
    this.#sessions = [...sessions];
    this.#filter();
    const selected = this.#filtered.findIndex((row) => row.session.path === selectedPath);
    if (selected >= 0) this.#selected = selected;
  }
  getSelectedSessionPath(): string | undefined { return this.#filtered[this.#selected]?.session.path; }
  getSelectedSession(): SessionInfo | undefined { return this.#filtered[this.#selected]?.session; }
  get searchEmpty(): boolean { return this.#search.getValue() === ""; }
  get sort(): SessionPickerSortMode { return this.#sort; }
  get namedOnly(): boolean { return this.#namedOnly; }
  cycleSort(): void {
    this.#sort = this.#sort === "threaded" ? "recent" : this.#sort === "recent" ? "relevance" : "threaded";
    this.#selected = 0;
    this.#filter();
  }
  toggleNamedFilter(): void {
    this.#namedOnly = !this.#namedOnly;
    this.#selected = 0;
    this.#filter();
  }
  invalidate(): void {}
  render(width: number): string[] {
    const rows = this.#filterError !== undefined
      ? [`  Invalid search: ${this.#filterError}`]
      : this.#filtered.length === 0
        ? ["  No sessions found"]
        : this.#filtered.slice(Math.max(0, this.#selected - 5), Math.max(0, this.#selected - 5) + 10).map((row) => {
          const { session, depth } = row;
          const index = this.#filtered.indexOf(row);
          const current = session.path === this.#currentSessionFilePath ? "●" : " ";
          const label = (session.name ?? session.firstMessage) || session.id;
          const detail = this.#showPaths ? ` · ${session.path}` : "";
          return truncateToWidth(`${index === this.#selected ? "→" : " "} ${current} ${"  ".repeat(depth)}${label}${detail}`, width, "");
        });
    return [...this.#search.render(width), ...rows];
  }
  handleInput(data: string): void {
    if (this.#keybindings.matches(data, "tui.select.up")) { if (this.#filtered.length > 0) this.#selected = this.#selected === 0 ? this.#filtered.length - 1 : this.#selected - 1; }
    else if (this.#keybindings.matches(data, "tui.select.down")) { if (this.#filtered.length > 0) this.#selected = this.#selected === this.#filtered.length - 1 ? 0 : this.#selected + 1; }
    else if (this.#keybindings.matches(data, "tui.select.confirm") || data === "\n") { const selected = this.#filtered[this.#selected]; if (selected !== undefined) this.onSelect?.(selected.session.path); }
    else if (this.#keybindings.matches(data, "tui.select.cancel")) this.onCancel?.();
    else if (this.#keybindings.matches(data, "app.exit")) this.onExit?.();
    else if (this.#keybindings.matches(data, "app.session.togglePath")) this.#showPaths = !this.#showPaths;
    else { this.#search.handleInput(data); this.#filter(); }
    this.#requestRender();
  }
  #filter(): void {
    const query = this.#search.getValue();
    const parentPaths = resolveSessionParentPaths(this.#sessions);
    const metadata: PublicSessionMetadata[] = this.#sessions.map((session) => ({
      id: session.path,
      label: (session.name ?? session.firstMessage) || session.id,
      ...(session.name === undefined ? {} : { name: session.name }),
      detail: session.path,
      keywords: [session.cwd, session.firstMessage, session.allMessagesText],
      ...(parentPaths.get(session.path) === undefined ? {} : { parentId: parentPaths.get(session.path)! }),
      updatedAt: session.modified,
      source: session,
    }));
    const result = buildSessionPickerRows(metadata, {
      query,
      namedOnly: this.#namedOnly,
      sort: this.#sort,
    });
    this.#filterError = result.error;
    this.#filtered = result.rows.map((row) => ({ session: row.session.source, depth: row.depth }));
    this.#selected = Math.max(0, Math.min(this.#selected, this.#filtered.length - 1));
  }
}

export class SessionSelectorComponent extends Container implements Focusable {
  readonly #currentLoader: SessionsLoader;
  readonly #allLoader: SessionsLoader;
  readonly #requestRender: () => void;
  readonly #list: PublicSessionList;
  readonly #header = new Text("Resume Session (Current Folder)", 0, 0);
  readonly #body = new Container();
  readonly #deleteSession: ((path: string) => Promise<void>) | undefined;
  readonly #showDeleteHint: boolean;
  readonly #keybindings: KeybindingsManager;
  readonly #currentSessionFilePath: string | undefined;
  #scope: "current" | "all" = "current";
  #mode: "list" | "confirm_delete" = "list";
  #deleteTarget: SessionInfo | undefined;
  #deletePending = false;
  #loadGeneration = 0;
  #focused = false;
  #closed = false;
  #completed = false;
  constructor(
    currentLoader: SessionsLoader,
    allLoader: SessionsLoader,
    onSelect: (path: string) => void,
    onCancel: () => void,
    onExit: () => void,
    requestRender: () => void,
    options?: {
      deleteSession?: (path: string) => Promise<void>;
      showDeleteHint?: boolean;
      keybindings?: KeybindingsManager;
    },
    currentSessionFilePath?: string,
  ) {
    super();
    this.#currentLoader = currentLoader;
    this.#allLoader = allLoader;
    this.#requestRender = requestRender;
    this.#keybindings = options?.keybindings ?? currentAppKeybindings();
    this.#currentSessionFilePath = currentSessionFilePath;
    this.#deleteSession = options?.deleteSession;
    this.#showDeleteHint = options?.showDeleteHint !== false && this.#deleteSession !== undefined;
    this.#list = new PublicSessionList(this.#keybindings, requestRender, currentSessionFilePath);
    this.#list.onSelect = (path) => this.#complete(() => onSelect(path));
    this.#list.onCancel = () => this.#complete(onCancel);
    this.#list.onExit = () => this.#complete(onExit);
    this.addChild(new DynamicBorder());
    this.addChild(this.#header);
    this.addChild(this.#body);
    this.addChild(new DynamicBorder());
    this.#showList();
    void this.#load("current");
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) {
    this.#focused = value;
    this.#list.focused = value && this.#mode === "list";
  }
  handleInput(data: string): void {
    if (this.#closed) return;
    if (this.#mode === "confirm_delete") {
      if (this.#keybindings.matches(data, "tui.select.cancel")) this.#showList();
      else if (this.#keybindings.matches(data, "tui.select.confirm") || data === "\n") void this.#finishDelete();
    } else if (this.#keybindings.matches(data, "app.session.delete")) {
      this.#beginDelete();
    } else if (this.#keybindings.matches(data, "app.session.deleteNoninvasive") && this.#list.searchEmpty) {
      this.#beginDelete();
    } else if (this.#keybindings.matches(data, "app.session.toggleSort")) {
      this.#list.cycleSort();
      this.#updateHeader();
      this.#requestRender();
    } else if (this.#keybindings.matches(data, "app.session.toggleNamedFilter")) {
      this.#list.toggleNamedFilter();
      this.#updateHeader();
      this.#requestRender();
    } else if (this.#keybindings.matches(data, "app.session.toggleScope")) {
      this.#scope = this.#scope === "current" ? "all" : "current";
      void this.#load(this.#scope);
    } else this.#list.handleInput(data);
  }
  getSessionList(): PublicSessionList { return this.#list; }
  dispose(): void { this.#closed = true; this.#completed = true; this.#loadGeneration += 1; }
  #complete(callback: () => void): void {
    if (this.#completed) return;
    this.#completed = true;
    this.#closed = true;
    this.#loadGeneration += 1;
    callback();
  }
  async #load(scope: "current" | "all"): Promise<void> {
    if (this.#closed) return;
    const generation = ++this.#loadGeneration;
    this.#header.setText(scope === "current" ? "Resume Session (Current Folder) · Loading…" : "Resume Session (All) · Loading…");
    this.#requestRender();
    try {
      const sessions = await (scope === "current" ? this.#currentLoader : this.#allLoader)(() => {
        if (!this.#closed && generation === this.#loadGeneration) this.#requestRender();
      });
      if (this.#closed || generation !== this.#loadGeneration || scope !== this.#scope) return;
      this.#list.setSessions(sessions);
      this.#updateHeader();
    } catch (error) {
      if (this.#closed || generation !== this.#loadGeneration || scope !== this.#scope) return;
      this.#header.setText(`Failed to load sessions: ${humanFailure(error)}`);
    }
    this.#requestRender();
  }
  #updateHeader(): void {
    const scope = this.#scope === "current" ? "Current folder" : "All folders";
    const actions = [
      this.#showDeleteHint ? "delete available" : "",
    ].filter(Boolean);
    this.#header.setText(
      `Resume session · ${scope} · ${this.#list.sort}${this.#list.namedOnly ? " · named only" : ""}${actions.length === 0 ? "" : ` · ${actions.join(" · ")}`}`,
    );
  }
  #showList(): void {
    this.#mode = "list";
    this.#deleteTarget = undefined;
    this.#body.clear();
    this.#body.addChild(this.#list);
    this.#list.focused = this.#focused;
    this.#updateHeader();
    this.#requestRender();
  }
  #beginDelete(): void {
    if (this.#deleteSession === undefined) return;
    const selected = this.#list.getSelectedSession();
    if (selected === undefined) return;
    if (selected.path === this.#currentSessionFilePath) {
      this.#header.setText("The active session cannot be deleted");
      this.#requestRender();
      return;
    }
    this.#mode = "confirm_delete";
    this.#deleteTarget = selected;
    this.#body.clear();
    this.#body.addChild(new Text(`Delete ${(selected.name ?? selected.firstMessage) || selected.id}?`, 1, 0));
    this.#header.setText("Delete session · Enter confirms · Escape returns");
    this.#list.focused = false;
    this.#requestRender();
  }
  async #finishDelete(): Promise<void> {
    if (this.#closed) return;
    const target = this.#deleteTarget;
    if (target === undefined || this.#deleteSession === undefined || this.#deletePending) return;
    this.#deletePending = true;
    this.#header.setText("Deleting session…");
    this.#requestRender();
    try {
      await this.#deleteSession(target.path);
      if (this.#closed) return;
      this.#showList();
      await this.#load(this.#scope);
    } catch (error) {
      if (this.#closed) return;
      this.#header.setText(`Delete failed: ${humanFailure(error)}`);
      this.#requestRender();
    } finally {
      this.#deletePending = false;
    }
  }
}

interface TreeNodeLike { entry?: { id?: string; parentId?: string | null; type?: string; [key: string]: unknown }; id?: string; label?: string; labelTimestamp?: string; children?: TreeNodeLike[] }
interface PublicFlatTreeNode {
  node: TreeNodeLike;
  id: string;
  parentId?: string;
  depth: number;
  hasChildren: boolean;
}
type PublicTreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
const MAX_PUBLIC_TREE_NODES = 50_000;

function flattenTree(nodes: readonly TreeNodeLike[]): PublicFlatTreeNode[] {
  const result: PublicFlatTreeNode[] = [];
  const visited = new Set<TreeNodeLike>();
  const pending: Array<{ node: TreeNodeLike; depth: number; parentId?: string }> = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    pending.push({ node: nodes[index]!, depth: 0 });
  }
  while (pending.length > 0) {
    const { node, depth, parentId } = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const id = node.entry?.id ?? node.id;
    if (typeof id !== "string") continue;
    if (result.length >= MAX_PUBLIC_TREE_NODES) {
      throw new RangeError(`Tree selector supports at most ${MAX_PUBLIC_TREE_NODES} nodes`);
    }
    result.push({
      node,
      id,
      ...(parentId === undefined ? {} : { parentId }),
      depth,
      hasChildren: (node.children?.length ?? 0) > 0,
    });
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: children[index]!, depth: depth + 1, parentId: id });
    }
  }
  return result;
}

function treeEntryText(node: TreeNodeLike): string {
  const entry = (node.entry ?? node) as Record<string, unknown>;
  const parts = [
    node.label,
    entry.type,
    entry.id,
    textContent(entry.message),
    textContent(entry.data),
    textContent(entry.content),
    textContent(entry.summary),
    typeof entry.modelId === "string" ? entry.modelId : "",
    typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "",
    typeof entry.customType === "string" ? entry.customType : "",
  ];
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

function treeEntryRole(node: TreeNodeLike): string | undefined {
  const message = (node.entry as Record<string, unknown> | undefined)?.message;
  return message !== null && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
    ? (message as { role: string }).role
    : undefined;
}

export class TreeSelectorComponent extends Container implements Focusable {
  readonly #all: PublicFlatTreeNode[];
  readonly #byId: ReadonlyMap<string, PublicFlatTreeNode>;
  readonly #body = new Container();
  readonly #search = new Input();
  readonly #labelInput = new Input();
  readonly #current: string | null;
  readonly #maxVisible: number;
  readonly #onSelect: (id: string) => void;
  readonly #onCancel: () => void;
  readonly #onLabelChange: ((id: string, label: string | undefined) => void) | undefined;
  readonly #folded = new Set<string>();
  readonly #activePath = new Set<string>();
  #cancelled = false;
  #emptyCancel: ReturnType<typeof setTimeout> | undefined;
  #list: SelectList;
  #filterMode: PublicTreeFilter;
  #pathOnly = false;
  #showLabelTimestamp = false;
  #mode: "tree" | "label" = "tree";
  #labelTarget: PublicFlatTreeNode | undefined;
  #focused = false;
  onCopy?: (text: string | undefined) => void;
  constructor(tree: SessionTreeNode[] | TreeNodeLike[], current: string | null, terminalHeight: number, onSelect: (id: string) => void, onCancel: () => void, onLabelChange?: (id: string, label: string | undefined) => void, initialSelectedId?: string, initialFilterMode: PublicTreeFilter = "default") {
    super();
    this.#all = flattenTree(tree as TreeNodeLike[]);
    this.#byId = new Map(this.#all.map((entry) => [entry.id, entry]));
    this.#current = current;
    this.#maxVisible = Math.max(5, Math.floor(terminalHeight / 2));
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.#onLabelChange = onLabelChange;
    this.#filterMode = initialFilterMode;
    this.#list = new SelectList([], this.#maxVisible, getSelectListTheme());
    let path = current ?? undefined;
    while (path !== undefined && !this.#activePath.has(path)) {
      this.#activePath.add(path);
      path = this.#byId.get(path)?.parentId;
    }
    this.addChild(new DynamicBorder());
    this.addChild(new Text("Session Tree", 1, 0));
    this.addChild(this.#body);
    this.addChild(new DynamicBorder());
    this.#rebuild(initialSelectedId ?? current ?? undefined);
    this.#labelInput.onSubmit = () => this.#saveLabel();
    if (this.#all.length === 0) {
      this.#emptyCancel = setTimeout(() => this.#cancel(), 100);
      this.#emptyCancel.unref?.();
    }
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) {
    this.#focused = value;
    this.#search.focused = value && this.#mode === "tree";
    this.#labelInput.focused = value && this.#mode === "label";
  }
  handleInput(data: string): void {
    if (this.#cancelled) return;
    const keys = currentAppKeybindings();
    if (this.#mode === "label") {
      if (keys.matches(data, "tui.select.cancel")) this.#showTree();
      else this.#labelInput.handleInput(data);
      return;
    }
    if (keys.matches(data, "app.tree.editLabel")) {
      this.#beginLabel();
    } else if (keys.matches(data, "app.tree.toggleLabelTimestamp")) {
      this.#showLabelTimestamp = !this.#showLabelTimestamp;
      this.#rebuild();
    } else if (keys.matches(data, "app.tree.foldOrUp")) {
      this.#foldOrSelectParent();
    } else if (keys.matches(data, "app.tree.unfoldOrDown")) {
      this.#unfoldOrSelectChild();
    } else if (keys.matches(data, "app.tree.togglePath")) {
      this.#pathOnly = !this.#pathOnly;
      this.#rebuild();
    } else if (keys.matches(data, "app.message.copy")) {
      const selected = this.#selected();
      this.onCopy?.(selected === undefined ? undefined : treeEntryText(selected.node));
    } else if (keys.matches(data, "app.tree.filter.default")) {
      this.#setFilter("default");
    } else if (keys.matches(data, "app.tree.filter.noTools")) {
      this.#setFilter(this.#filterMode === "no-tools" ? "default" : "no-tools");
    } else if (keys.matches(data, "app.tree.filter.userOnly")) {
      this.#setFilter(this.#filterMode === "user-only" ? "default" : "user-only");
    } else if (keys.matches(data, "app.tree.filter.labeledOnly")) {
      this.#setFilter(this.#filterMode === "labeled-only" ? "default" : "labeled-only");
    } else if (keys.matches(data, "app.tree.filter.all")) {
      this.#setFilter(this.#filterMode === "all" ? "default" : "all");
    } else if (keys.matches(data, "app.tree.filter.cycleForward")) {
      this.#cycleFilter(1);
    } else if (keys.matches(data, "app.tree.filter.cycleBackward")) {
      this.#cycleFilter(-1);
    } else if (keys.matches(data, "tui.select.cancel") && this.#search.getValue() !== "") {
      this.#search.setValue("");
      this.#rebuild();
    } else if (
      keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") ||
      keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown") ||
      keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.cancel")
    ) {
      this.#list.handleInput(data);
    } else {
      this.#search.handleInput(data);
      this.#rebuild();
    }
  }
  getTreeList(): SelectList { return this.#list; }
  getSearchQuery(): string { return this.#search.getValue(); }
  #selected(): PublicFlatTreeNode | undefined {
    const id = this.#list.getSelectedItem()?.value;
    return id === undefined ? undefined : this.#byId.get(id);
  }
  #passesMode(entry: PublicFlatTreeNode): boolean {
    const type = entry.node.entry?.type;
    const role = treeEntryRole(entry.node);
    const bookkeeping = ["label", "custom", "model_change", "thinking_level_change", "session_info"].includes(type ?? "");
    if (this.#filterMode === "all") return true;
    if (this.#filterMode === "labeled-only") return entry.node.label !== undefined;
    if (this.#filterMode === "user-only") return type === "message" && role === "user";
    if (this.#filterMode === "no-tools") return !bookkeeping && role !== "tool" && role !== "toolResult";
    return !bookkeeping;
  }
  #rebuild(preferredId?: string): void {
    const selectedId = preferredId ?? this.#list.getSelectedItem()?.value;
    const query = this.#search.getValue();
    const visible: PublicFlatTreeNode[] = [];
    let hiddenBelowDepth: number | undefined;
    for (const entry of this.#all) {
      if (hiddenBelowDepth !== undefined && entry.depth > hiddenBelowDepth) continue;
      hiddenBelowDepth = undefined;
      if (
        this.#passesMode(entry) &&
        (!this.#pathOnly || this.#activePath.has(entry.id)) &&
        (query === "" || searchMatch(treeEntryText(entry.node), query))
      ) visible.push(entry);
      if (this.#folded.has(entry.id)) hiddenBelowDepth = entry.depth;
    }
    const items = visible.map((entry) => {
      const folded = entry.hasChildren ? this.#folded.has(entry.id) ? "▸" : "▾" : "·";
      const current = entry.id === this.#current ? "◆" : " ";
      const label = entry.node.label ??
        (treeEntryText(entry.node).split(/\s+/u).filter(Boolean).slice(0, 8).join(" ") || entry.id);
      const stamp = this.#showLabelTimestamp && entry.node.labelTimestamp !== undefined
        ? ` · ${entry.node.labelTimestamp}`
        : "";
      const indentDepth = Math.min(entry.depth, 32);
      const indent = `${entry.depth > indentDepth ? "… " : ""}${"│ ".repeat(indentDepth)}`;
      return {
        value: entry.id,
        label: `${indent}${folded} ${current} ${label}${stamp}`,
        ...(entry.node.entry?.type === undefined ? {} : { description: entry.node.entry.type }),
      };
    });
    this.#list = new SelectList(items, this.#maxVisible, getSelectListTheme());
    this.#list.onSelect = (item) => {
      if (this.#cancelled) return;
      this.#cancelled = true;
      if (this.#emptyCancel !== undefined) clearTimeout(this.#emptyCancel);
      this.#emptyCancel = undefined;
      this.#onSelect(item.value);
    };
    this.#list.onCancel = () => this.#cancel();
    const selected = items.findIndex((item) => item.value === selectedId);
    if (selected >= 0) this.#list.setSelectedIndex(selected);
    this.#body.clear();
    this.#body.addChild(this.#search);
    this.#body.addChild(new Text(
      `${visible.length}/${this.#all.length} · ${this.#filterMode}${this.#pathOnly ? " · active path" : ""}`,
      1,
      0,
    ));
    this.#body.addChild(this.#list);
    this.#search.focused = this.#focused;
  }
  #setFilter(mode: PublicTreeFilter): void {
    this.#filterMode = mode;
    this.#folded.clear();
    this.#rebuild();
  }
  #cycleFilter(direction: 1 | -1): void {
    const modes: PublicTreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
    const index = modes.indexOf(this.#filterMode);
    this.#setFilter(modes[(index + direction + modes.length) % modes.length]!);
  }
  #foldOrSelectParent(): void {
    const selected = this.#selected();
    if (selected === undefined) return;
    if (selected.hasChildren && !this.#folded.has(selected.id)) {
      this.#folded.add(selected.id);
      this.#rebuild(selected.id);
      return;
    }
    if (selected.parentId !== undefined) this.#rebuild(selected.parentId);
  }
  #unfoldOrSelectChild(): void {
    const selected = this.#selected();
    if (selected === undefined) return;
    if (this.#folded.delete(selected.id)) {
      this.#rebuild(selected.id);
      return;
    }
    const child = this.#all.find((entry) => entry.parentId === selected.id);
    if (child !== undefined) this.#rebuild(child.id);
  }
  #beginLabel(): void {
    if (this.#onLabelChange === undefined) return;
    const selected = this.#selected();
    if (selected === undefined) return;
    this.#mode = "label";
    this.#labelTarget = selected;
    this.#labelInput.setValue(selected.node.label ?? "");
    this.#body.clear();
    this.#body.addChild(new Text(`Label ${selected.id} · Enter saves · Escape returns`, 1, 0));
    this.#body.addChild(this.#labelInput);
    this.#search.focused = false;
    this.#labelInput.focused = this.#focused;
  }
  #saveLabel(): void {
    const target = this.#labelTarget;
    if (target === undefined) return;
    const label = this.#labelInput.getValue().trim() || undefined;
    if (label === undefined) {
      delete target.node.label;
      delete target.node.labelTimestamp;
    } else {
      target.node.label = label;
      target.node.labelTimestamp = new Date().toISOString();
    }
    this.#onLabelChange?.(target.id, label);
    this.#showTree(target.id);
  }
  #showTree(preferredId?: string): void {
    this.#mode = "tree";
    this.#labelTarget = undefined;
    this.#labelInput.focused = false;
    this.#rebuild(preferredId);
  }
  #cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    if (this.#emptyCancel !== undefined) clearTimeout(this.#emptyCancel);
    this.#emptyCancel = undefined;
    this.#onCancel();
  }
  dispose(): void {
    this.#cancelled = true;
    if (this.#emptyCancel !== undefined) clearTimeout(this.#emptyCancel);
    this.#emptyCancel = undefined;
  }
}

export interface SettingsConfig {
  autocompleteMaxVisible: number;
  autoCompact: boolean;
  autoResizeImages: boolean;
  availableThemes: string[];
  availableThinkingLevels: ThinkingLevel[];
  blockImages: boolean;
  clearOnShrink: boolean;
  collapseChangelog: boolean;
  currentTheme: string;
  defaultProjectTrust: DefaultProjectTrust;
  doubleEscapeAction: "fork" | "tree" | "none";
  editorPaddingX: number;
  enableSkillCommands: boolean;
  followUpMode: "all" | "one-at-a-time";
  hideThinkingBlock: boolean;
  httpIdleTimeoutMs: number;
  imageWidthCells: number;
  outputPad: 0 | 1;
  quietStartup: boolean;
  showCacheMissNotices: boolean;
  showHardwareCursor: boolean;
  showImages: boolean;
  showTerminalProgress: boolean;
  steeringMode: "all" | "one-at-a-time";
  terminalTheme: "light" | "dark";
  thinkingLevel: ThinkingLevel;
  transport: Transport;
  treeFilterMode: PublicTreeFilter;
  warnings: WarningSettings;
}
export interface SettingsCallbacks {
  onAutoCompactChange(enabled: boolean): void;
  onShowImagesChange(enabled: boolean): void;
  onImageWidthCellsChange(width: number): void;
  onAutoResizeImagesChange(enabled: boolean): void;
  onBlockImagesChange(enabled: boolean): void;
  onEnableSkillCommandsChange(enabled: boolean): void;
  onSteeringModeChange(mode: "all" | "one-at-a-time"): void;
  onFollowUpModeChange(mode: "all" | "one-at-a-time"): void;
  onTransportChange(transport: Transport): void;
  onHttpIdleTimeoutMsChange(timeoutMs: number): void;
  onThinkingLevelChange(level: ThinkingLevel): void;
  onThemeChange(theme: string): void;
  onThemePreview?(theme: string): void;
  onHideThinkingBlockChange(hidden: boolean): void;
  onShowCacheMissNoticesChange(shown: boolean): void;
  onCollapseChangelogChange(collapsed: boolean): void;
  onDoubleEscapeActionChange(action: "fork" | "tree" | "none"): void;
  onTreeFilterModeChange(mode: PublicTreeFilter): void;
  onShowHardwareCursorChange(enabled: boolean): void;
  onEditorPaddingXChange(padding: number): void;
  onOutputPadChange(padding: 0 | 1): void;
  onAutocompleteMaxVisibleChange(maxVisible: number): void;
  onQuietStartupChange(enabled: boolean): void;
  onDefaultProjectTrustChange(value: DefaultProjectTrust): void;
  onClearOnShrinkChange(enabled: boolean): void;
  onShowTerminalProgressChange(enabled: boolean): void;
  onWarningsChange(warnings: WarningSettings): void;
  onCancel(): void;
}
export class SettingsSelectorComponent extends Container {
  readonly #list: SettingsList;
  constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
    super();
    const booleanValues = ["true", "false"];
    const idleTimeouts = [0, 30_000, 60_000, 300_000, 600_000];
    const items = [
      { id: "auto-compact", label: "Automatic compaction", currentValue: String(config.autoCompact), values: booleanValues },
      { id: "show-images", label: "Inline images", currentValue: String(config.showImages), values: booleanValues },
      { id: "image-width", label: "Image width", currentValue: String(config.imageWidthCells), values: ["60", "80", "120"] },
      { id: "auto-resize-images", label: "Resize large images", currentValue: String(config.autoResizeImages), values: booleanValues },
      { id: "block-images", label: "Block model images", currentValue: String(config.blockImages), values: booleanValues },
      { id: "skill-commands", label: "Skill commands", currentValue: String(config.enableSkillCommands), values: booleanValues },
      { id: "steering-mode", label: "Steering queue", currentValue: config.steeringMode, values: ["one-at-a-time", "all"] },
      { id: "follow-up-mode", label: "Follow-up queue", currentValue: config.followUpMode, values: ["one-at-a-time", "all"] },
      { id: "transport", label: "Codex transport (auto default)", currentValue: config.transport, values: ["auto", "sse", "websocket", "websocket-cached"] },
      { id: "http-idle-timeout", label: "HTTP idle timeout (ms)", currentValue: String(config.httpIdleTimeoutMs), values: idleTimeouts.map(String) },
      { id: "thinking", label: "Thinking level", currentValue: config.thinkingLevel, values: config.availableThinkingLevels },
      { id: "theme", label: `Theme (${config.terminalTheme})`, currentValue: config.currentTheme, values: [...new Set([config.currentTheme, ...config.availableThemes])] },
      { id: "cache-miss-notices", label: "Cache reuse estimates", currentValue: String(config.showCacheMissNotices), values: booleanValues },
      { id: "collapse-changelog", label: "Condensed changelog", currentValue: String(config.collapseChangelog), values: booleanValues },
      { id: "double-escape", label: "Double Escape", currentValue: config.doubleEscapeAction, values: ["tree", "fork", "none"] },
      { id: "tree-filter", label: "Tree filter", currentValue: config.treeFilterMode, values: ["default", "no-tools", "user-only", "labeled-only", "all"] },
      { id: "hardware-cursor", label: "Hardware cursor", currentValue: String(config.showHardwareCursor), values: booleanValues },
      { id: "editor-padding", label: "Editor padding", currentValue: String(config.editorPaddingX), values: ["0", "1", "2", "3"] },
      { id: "output-padding", label: "Output padding", currentValue: String(config.outputPad), values: ["0", "1"] },
      { id: "autocomplete-size", label: "Autocomplete rows", currentValue: String(config.autocompleteMaxVisible), values: ["3", "5", "7", "10", "15", "20"] },
      { id: "quiet-startup", label: "Quiet startup", currentValue: String(config.quietStartup), values: booleanValues },
      { id: "project-trust", label: "Default project trust", currentValue: config.defaultProjectTrust, values: ["ask", "always", "never"] },
      { id: "clear-on-shrink", label: "Clear vacated rows", currentValue: String(config.clearOnShrink), values: booleanValues },
      { id: "terminal-progress", label: "Terminal progress", currentValue: String(config.showTerminalProgress), values: booleanValues },
      {
        id: "anthropic-usage-warning",
        label: "Anthropic API billing warning",
        currentValue: String(config.warnings.anthropicExtraUsage !== false),
        values: booleanValues,
      },
    ];
    const enabled = (value: string): boolean => value === "true";
    this.#list = new SettingsList(items, 16, getSettingsListTheme(), (id, value) => {
      switch (id) {
        case "auto-compact": callbacks.onAutoCompactChange(enabled(value)); break;
        case "show-images": callbacks.onShowImagesChange(enabled(value)); break;
        case "image-width": callbacks.onImageWidthCellsChange(Number.parseInt(value, 10)); break;
        case "auto-resize-images": callbacks.onAutoResizeImagesChange(enabled(value)); break;
        case "block-images": callbacks.onBlockImagesChange(enabled(value)); break;
        case "skill-commands": callbacks.onEnableSkillCommandsChange(enabled(value)); break;
        case "steering-mode": callbacks.onSteeringModeChange(value as SettingsConfig["steeringMode"]); break;
        case "follow-up-mode": callbacks.onFollowUpModeChange(value as SettingsConfig["followUpMode"]); break;
        case "transport": callbacks.onTransportChange(value as Transport); break;
        case "http-idle-timeout": callbacks.onHttpIdleTimeoutMsChange(Number.parseInt(value, 10)); break;
        case "thinking": callbacks.onThinkingLevelChange(value as ThinkingLevel); break;
        case "theme": callbacks.onThemePreview?.(value); callbacks.onThemeChange(value); break;
        case "cache-miss-notices": callbacks.onShowCacheMissNoticesChange(enabled(value)); break;
        case "collapse-changelog": callbacks.onCollapseChangelogChange(enabled(value)); break;
        case "double-escape": callbacks.onDoubleEscapeActionChange(value as SettingsConfig["doubleEscapeAction"]); break;
        case "tree-filter": callbacks.onTreeFilterModeChange(value as PublicTreeFilter); break;
        case "hardware-cursor": callbacks.onShowHardwareCursorChange(enabled(value)); break;
        case "editor-padding": callbacks.onEditorPaddingXChange(Number.parseInt(value, 10)); break;
        case "output-padding": callbacks.onOutputPadChange(value === "0" ? 0 : 1); break;
        case "autocomplete-size": callbacks.onAutocompleteMaxVisibleChange(Number.parseInt(value, 10)); break;
        case "quiet-startup": callbacks.onQuietStartupChange(enabled(value)); break;
        case "project-trust": callbacks.onDefaultProjectTrustChange(value as DefaultProjectTrust); break;
        case "clear-on-shrink": callbacks.onClearOnShrinkChange(enabled(value)); break;
        case "terminal-progress": callbacks.onShowTerminalProgressChange(enabled(value)); break;
        case "anthropic-usage-warning": callbacks.onWarningsChange({
          ...config.warnings,
          anthropicExtraUsage: enabled(value),
        }); break;
      }
    }, callbacks.onCancel, { enableSearch: true });
    this.addChild(this.#list);
  }
  getSettingsList(): SettingsList { return this.#list; }
}

export class BashExecutionComponent extends Container {
  static readonly MAX_RETAINED_OUTPUT_BYTES = 64 * 1024;
  #output = "";
  #omittedOutputBytes = 0;
  readonly #content = new Container();
  readonly #card = new Box(1, 1);
  readonly #loader: Loader;
  #expanded = false;
  #status: "running" | "complete" | "cancelled" | "error" = "running";
  #exitCode: number | undefined;
  #truncation: TruncationResult | undefined;
  #fullOutputPath: string | undefined;
  constructor(private readonly command: string, private readonly ui: TUI, private readonly exclude = false) {
    super();
    this.#loader = new Loader(
      ui,
      (value) => currentTheme().fg("bashMode", value),
      (value) => currentTheme().fg("thinkingText", value),
      "Running",
    );
    this.#card.addChild(this.#content);
    this.addChild(new Spacer(1));
    this.addChild(this.#card);
    this.#render();
  }
  appendOutput(chunk: string): void {
    const normalized = stripAnsi(chunk).replace(/\r\n|\r/gu, "\n");
    const next = Buffer.from(this.#output + normalized);
    if (next.byteLength > BashExecutionComponent.MAX_RETAINED_OUTPUT_BYTES) {
      let start = next.byteLength - BashExecutionComponent.MAX_RETAINED_OUTPUT_BYTES;
      while (start < next.byteLength && (next[start]! & 0xc0) === 0x80) start += 1;
      this.#omittedOutputBytes += start;
      this.#output = next.subarray(start).toString("utf8");
    } else this.#output = next.toString("utf8");
    this.#render();
    this.ui.requestRender();
  }
  setComplete(exitCode: number | undefined, cancelled: boolean, truncationResult?: TruncationResult, fullOutputPath?: string): void {
    this.#exitCode = exitCode;
    this.#status = cancelled ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? "error" : "complete";
    this.#loader.stop();
    this.#truncation = truncationResult;
    this.#fullOutputPath = fullOutputPath;
    this.#render();
    this.ui.requestRender();
  }
  setExpanded(expanded: boolean): void { this.#expanded = expanded; this.#render(); }
  getOutput(): string { return this.#output; }
  getCommand(): string { return this.command; }
  dispose(): void { this.#loader.stop(); }
  override invalidate(): void { this.#render(); super.invalidate(); }
  #render(): void {
    this.#content.clear();
    const background = this.#status === "running"
      ? "toolPendingBg"
      : this.#status === "complete"
        ? "toolSuccessBg"
        : "toolErrorBg";
    this.#card.setBgFn((value) => currentTheme().bg(background, value));
    const lines = this.#output.split("\n");
    const hidden = Math.max(0, lines.length - 20);
    const shown = this.#expanded ? lines : lines.slice(-20);
    const status: string[] = [];
    if (this.#status === "cancelled") status.push(currentTheme().fg("warning", "Cancelled"));
    else if (this.#status === "error") status.push(currentTheme().fg("error", `Exited ${this.#exitCode ?? "unknown"}`));
    else if (this.#status === "complete") status.push(currentTheme().fg("success", "Completed"));
    if (this.#omittedOutputBytes > 0) status.push(`... ${this.#omittedOutputBytes} earlier output bytes omitted`);
    if (hidden > 0) status.push(this.#expanded ? "(collapse for preview)" : `... ${hidden} more lines (expand to view)`);
    if (this.#truncation?.truncated === true && this.#fullOutputPath !== undefined) {
      const safePath = inlineLabel(this.#fullOutputPath, "unavailable", 1_024);
      status.push(currentTheme().fg("warning", `Output was shortened. Complete output: ${safePath}`));
    }
    const marker = this.exclude ? "!!" : "$";
    const safeCommand = inlineLabel(this.command, "(empty command)", 4_096);
    this.#content.addChild(new Text(currentTheme().bold(currentTheme().fg(
      "bashMode",
      `${marker} ${safeCommand}`,
    )), 0, 0));
    if (this.#output !== "") {
      this.#content.addChild(new Spacer(1));
      this.#content.addChild(new Text(currentTheme().fg("toolOutput", shown.join("\n")), 0, 0));
    }
    if (this.#status === "running") this.#content.addChild(this.#loader);
    if (status.length > 0) {
      this.#content.addChild(new Spacer(1));
      this.#content.addChild(new Text(status.join("\n"), 0, 0));
    }
  }
}

export interface ToolExecutionOptions { showImages?: boolean; imageWidthCells?: number }
type DisposableToolComponent = Component & { dispose?(): void };

function toolRendererComponent(output: Component | RuntimeUiBlock): {
  component: Component;
  owned?: DisposableToolComponent;
} {
  if (output !== null && typeof output === "object" && typeof (output as Component).render === "function") {
    return { component: output as Component, owned: output as DisposableToolComponent };
  }
  return {
    component: {
      invalidate() {},
      render(width: number): string[] {
        const block = sanitizeRuntimeUiBlock(output, { width });
        return block.lines.map((line) => line.spans.map((span) =>
          span.role === undefined ? span.text : style(currentTheme(), span.role, span.text)).join(""));
      },
    },
  };
}

export class ToolExecutionComponent extends Container {
  readonly #body = new Container();
  readonly #card = new Box(1, 1);
  #leadingImages: Image[] = [];
  #trailingImages: Image[] = [];
  readonly #rendererState: Record<string, unknown> = {};
  #result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean } | undefined;
  #partial = true;
  #expanded = false;
  #showImages: boolean;
  #imageWidthCells: number;
  #executionStarted = false;
  #argsComplete = false;
  #callRendererComponent: DisposableToolComponent | undefined;
  #resultRendererComponent: DisposableToolComponent | undefined;
  #lastCallView: Component | undefined;
  #lastResultView: Component | undefined;
  readonly #rendererReferences = new WeakMap<DisposableToolComponent, number>();
  readonly #disposedRendererComponents = new WeakSet<DisposableToolComponent>();
  constructor(private readonly toolName: string, private readonly id: string, private args: unknown, options: ToolExecutionOptions = {}, private readonly definition?: ToolDefinition, private readonly ui: TUI = { requestRender() {} } as TUI, private readonly cwd = process.cwd()) {
    super();
    this.#showImages = options.showImages ?? true;
    this.#imageWidthCells = options.imageWidthCells ?? 60;
    this.#card.addChild(this.#body);
    this.#render();
  }
  updateArgs(args: unknown): void { this.args = args; this.#render(); }
  markExecutionStarted(): void { this.#executionStarted = true; this.#render(); this.ui.requestRender(); }
  setArgsComplete(): void { this.#argsComplete = true; this.#render(); this.ui.requestRender(); }
  updateResult(result: unknown, isPartial = false): void {
    this.#result = normalizeToolResult(result);
    this.#partial = isPartial;
    this.#render();
    this.ui.requestRender();
  }
  setExpanded(expanded: boolean): void { this.#expanded = expanded; this.#render(); }
  setShowImages(show: boolean): void { this.#showImages = show; this.#render(); }
  setImageWidthCells(width: number): void { this.#imageWidthCells = Math.max(1, Math.floor(width)); this.#render(); }
  override invalidate(): void { this.#render(); super.invalidate(); }
  dispose(): void {
    this.#replaceRendererComponent("call", undefined);
    this.#replaceRendererComponent("result", undefined);
    this.#lastCallView = undefined;
    this.#lastResultView = undefined;
  }
  #replaceRendererComponent(
    slot: "call" | "result",
    next: DisposableToolComponent | undefined,
  ): void {
    const prior = slot === "call" ? this.#callRendererComponent : this.#resultRendererComponent;
    if (prior === next) return;
    if (slot === "call") this.#callRendererComponent = next;
    else this.#resultRendererComponent = next;
    if (prior !== undefined) {
      const remaining = (this.#rendererReferences.get(prior) ?? 1) - 1;
      if (remaining > 0) this.#rendererReferences.set(prior, remaining);
      else {
        this.#rendererReferences.delete(prior);
        if (!this.#disposedRendererComponents.has(prior)) {
          this.#disposedRendererComponents.add(prior);
          prior.dispose?.();
        }
      }
    }
    if (next !== undefined) {
      this.#rendererReferences.set(next, (this.#rendererReferences.get(next) ?? 0) + 1);
    }
  }
  #context(lastComponent: Component | undefined): ToolRenderContext<Record<string, unknown>> {
    return {
      args: this.args,
      toolCallId: this.id,
      invalidate: () => { this.invalidate(); this.ui.requestRender(); },
      lastComponent,
      state: this.#rendererState,
      cwd: this.cwd,
      executionStarted: this.#executionStarted,
      argsComplete: this.#argsComplete,
      isPartial: this.#partial,
      expanded: this.#expanded,
      showImages: this.#showImages,
      isError: this.#result?.isError ?? false,
    };
  }
  #render(): void {
    this.clear();
    this.#body.clear();
    this.#leadingImages = [];
    this.#trailingImages = [];
    let last: Component | undefined;
    if (this.definition?.renderCall !== undefined) {
      try {
        const selected = toolRendererComponent(
          this.definition.renderCall(this.args as never, currentTheme(), this.#context(this.#lastCallView) as never),
        );
        this.#replaceRendererComponent("call", selected.owned);
        this.#lastCallView = selected.component;
        last = selected.component;
        if (last instanceof Image) this.#leadingImages.push(last);
        else this.#body.addChild(last);
      } catch {
        this.#replaceRendererComponent("call", undefined);
        this.#lastCallView = undefined;
        last = undefined;
      }
    } else {
      this.#replaceRendererComponent("call", undefined);
      this.#lastCallView = undefined;
    }
    if (last === undefined) {
      const summary = isJsonValue(this.args) ? toolCallSummary(this.args, 4_096) : undefined;
      const serialized = summary ?? (isJsonValue(this.args)
        ? byteTruncate(sanitizeTerminalText(JSON.stringify(this.args)), 4_096)
        : textContent(this.args) || "(no arguments)");
      const pending = this.#result === undefined || this.#partial;
      const failed = this.#result?.isError === true;
      const glyph = failed
        ? currentTheme().glyphs.failure
        : pending
          ? currentTheme().glyphs.pending
          : currentTheme().glyphs.success;
      const safeName = inlineLabel(this.toolName, "tool");
      last = new Text(currentTheme().bold(currentTheme().fg(
        "toolTitle",
        `${glyph} ${safeName} ${serialized}`,
      )), 0, 0);
      this.#body.addChild(last);
    }
    if (this.#result !== undefined && this.definition?.renderResult !== undefined) {
      try {
        const selected = toolRendererComponent(
          this.definition.renderResult(this.#result as never, { expanded: this.#expanded, isPartial: this.#partial }, currentTheme(), this.#context(this.#lastResultView) as never),
        );
        this.#replaceRendererComponent("result", selected.owned);
        this.#lastResultView = selected.component;
        if (selected.component instanceof Image) this.#trailingImages.push(selected.component);
        else this.#body.addChild(selected.component);
        this.#mountShell();
        return;
      } catch {
        this.#replaceRendererComponent("result", undefined);
        this.#lastResultView = undefined;
        /* readable fallback follows */
      }
    } else {
      this.#replaceRendererComponent("result", undefined);
      this.#lastResultView = undefined;
    }
    const output = toolResultText(this.#result, this.#showImages, this.#imageWidthCells);
    if (output !== "") {
      const lines = output.split("\n");
      const hidden = Math.max(0, lines.length - 20);
      const displayed = this.#expanded ? lines : lines.slice(-20);
      if (hidden > 0) displayed.push(this.#expanded ? "(collapse for preview)" : `... ${hidden} more lines (expand to view)`);
      this.#body.addChild(new Spacer(1));
      this.#body.addChild(new Text(currentTheme().fg("toolOutput", displayed.join("\n")), 0, 0));
    }
    for (const block of this.#result?.content ?? []) {
      if (block.type !== "image") continue;
      if (!this.#showImages) continue;
      if (block.data === undefined || block.mimeType === undefined) {
        this.#body.addChild(new Text(currentTheme().fg("warning", "[image unavailable]"), 0, 0));
        continue;
      }
      this.#trailingImages.push(new Image(
        block.data,
        block.mimeType,
        { fallbackColor: (value) => currentTheme().fg("muted", value) },
        { maxWidthCells: this.#imageWidthCells },
      ));
    }
    this.#mountShell();
  }
  #mountShell(): void {
    const framed = this.definition?.renderShell !== "self";
    const parts: Component[] = [...this.#leadingImages];
    if (this.#body.children.length > 0) {
      parts.push(framed ? this.#card : this.#body);
    }
    parts.push(...this.#trailingImages);
    if (parts.length === 0) return;
    this.addChild(new Spacer(1));
    if (framed) {
      const background = this.#result === undefined || this.#partial
        ? "toolPendingBg"
        : this.#result.isError
          ? "toolErrorBg"
          : "toolSuccessBg";
      this.#card.setBgFn((value) => currentTheme().bg(background, value));
    }
    parts.forEach((part, index) => {
      if (index > 0) this.addChild(new Spacer(1));
      this.addChild(part);
    });
  }
}

function normalizeToolResult(result: unknown): { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean } {
  if (result !== null && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    const source = result as { content: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>; details?: unknown; isError?: unknown };
    return {
      content: source.content.map((block) => ({
        type: typeof block.type === "string" ? block.type : "text",
        ...(typeof block.text === "string" ? { text: block.text } : {}),
        ...(typeof block.data === "string" ? { data: block.data } : {}),
        ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
      })),
      ...(source.details === undefined ? {} : { details: source.details }),
      isError: source.isError === true,
    };
  }
  return { content: [{ type: "text", text: textContent(result) }], isError: false };
}

function toolResultText(result: ReturnType<typeof normalizeToolResult> | undefined, showImages: boolean, imageWidthCells: number): string {
  if (result === undefined) return "";
  return result.content.map((block) =>
    block.type === "text"
      ? block.text ?? ""
      : block.type === "image" && !showImages
        ? `[image hidden, width ${imageWidthCells}]`
        : "").filter(Boolean).join("\n");
}

interface FooterSessionLike {
  cwd?: string;
  sessionManager?: {
    getCwd(): string;
    getSessionName?(): string | undefined;
    getActiveBranchUsage?(): {
      usage: NormalizedUsage;
      reportedUsage?: NormalizedUsage;
      hasUsageObservations?: boolean;
      latestAssistantUsage?: NormalizedUsage;
    };
  };
  getSessionStats?(): {
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      inputReported?: number;
      outputReported?: number;
      cacheReadReported?: number;
      cacheWriteReported?: number;
      total?: number;
      totalReported?: number;
    };
    usage?: NormalizedUsage;
    cost?: number;
    contextUsage?: {
      tokens: number | null;
      contextWindow: number;
      percent: number | null;
      source?: "provider" | "estimated";
      autoCompactionThresholdPercent?: number;
    };
  };
  state?: {
    model?: { id?: string; provider?: string; reasoning?: boolean };
    thinkingLevel?: string;
  };
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${value < 10_000 ? (value / 1_000).toFixed(1) : Math.round(value / 1_000)}k`;
  return `${value < 10_000_000 ? (value / 1_000_000).toFixed(1) : Math.round(value / 1_000_000)}M`;
}

function publicPromptLowerBound(usage: NormalizedUsage): number | undefined {
  const values = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

export class FooterComponent implements Component {
  constructor(
    private session: FooterSessionLike,
    private readonly footerData: {
      getGitBranch(): string | null;
      getExtensionStatuses?(): ReadonlyMap<string, string>;
      getAvailableProviderCount?(): number;
    },
  ) {}
  setSession(session: FooterSessionLike): void { this.session = session; }
  invalidate(): void {}
  dispose(): void {}
  render(width: number): string[] {
    const maximum = Math.max(0, width);
    const branch = this.footerData.getGitBranch();
    const name = this.session.sessionManager?.getSessionName?.();
    const location = [
      this.session.sessionManager?.getCwd() ?? this.session.cwd,
      branch,
      name,
    ].filter((value): value is string => value !== undefined && value !== "").join(" · ");
    const stats = this.session.getSessionStats?.();
    const tokens = stats?.tokens;
    const context = stats?.contextUsage;
    const branchUsage = this.session.sessionManager?.getActiveBranchUsage?.();
    const latestCacheHitRate = branchUsage?.latestAssistantUsage === undefined
      ? undefined
      : normalizedCacheHitRate(branchUsage.latestAssistantUsage);
    const statsHaveTokenUsage = stats?.usage !== undefined && (
      [
        stats.usage.inputTokens,
        stats.usage.outputTokens,
        stats.usage.totalTokens,
        stats.usage.cacheReadTokens,
        stats.usage.cacheWriteTokens,
      ].some((value) => value !== undefined)
    ) || tokens !== undefined && Object.values(tokens).some((value) => value !== undefined);
    const statsHaveUsage = statsHaveTokenUsage === true || stats?.usage?.cost !== undefined;
    const hasUsageObservations = branchUsage?.hasUsageObservations
      ?? (branchUsage === undefined
        ? statsHaveUsage
        : branchUsage.latestAssistantUsage !== undefined || Object.keys(branchUsage.usage).length > 0);
    const cacheMetric = hasUsageObservations !== true
      ? undefined
      : latestCacheHitRate === undefined
        ? "last cache n/a"
        : `last cache ${latestCacheHitRate.toFixed(1)}%`;
    const statsExactUsage: NormalizedUsage | undefined = stats === undefined
      ? undefined
      : {
          ...(stats.usage ?? {}),
          ...(tokens?.input === undefined ? {} : { inputTokens: tokens.input }),
          ...(tokens?.output === undefined ? {} : { outputTokens: tokens.output }),
          ...(tokens?.cacheRead === undefined ? {} : { cacheReadTokens: tokens.cacheRead }),
          ...(tokens?.cacheWrite === undefined ? {} : { cacheWriteTokens: tokens.cacheWrite }),
          ...(tokens?.total === undefined ? {} : { totalTokens: tokens.total }),
        };
    const useStatsUsage = branchUsage === undefined && statsHaveTokenUsage === true;
    const exactUsage = useStatsUsage ? statsExactUsage! : branchUsage?.usage ?? {};
    const branchReportedUsage = branchUsage?.reportedUsage ?? branchUsage?.usage;
    const reportedInput = useStatsUsage
      ? tokens?.input ?? tokens?.inputReported ?? stats?.usage?.inputTokens
      : branchReportedUsage?.inputTokens;
    const reportedOutput = useStatsUsage
      ? tokens?.output ?? tokens?.outputReported ?? stats?.usage?.outputTokens
      : branchReportedUsage?.outputTokens;
    const reportedCacheRead = useStatsUsage
      ? tokens?.cacheRead ?? tokens?.cacheReadReported ?? stats?.usage?.cacheReadTokens
      : branchReportedUsage?.cacheReadTokens;
    const reportedCacheWrite = useStatsUsage
      ? tokens?.cacheWrite ?? tokens?.cacheWriteReported ?? stats?.usage?.cacheWriteTokens
      : branchReportedUsage?.cacheWriteTokens;
    const reportedTotal = useStatsUsage
      ? tokens?.total ?? tokens?.totalReported ?? stats?.usage?.totalTokens
      : branchReportedUsage?.totalTokens;
    const reportedUsage: NormalizedUsage = {
      ...(reportedInput === undefined ? {} : { inputTokens: reportedInput }),
      ...(reportedOutput === undefined ? {} : { outputTokens: reportedOutput }),
      ...(reportedCacheRead === undefined ? {} : { cacheReadTokens: reportedCacheRead }),
      ...(reportedCacheWrite === undefined ? {} : { cacheWriteTokens: reportedCacheWrite }),
      ...(reportedTotal === undefined ? {} : { totalTokens: reportedTotal }),
    };
    const input = normalizedContextTokens(exactUsage);
    const inputReported = input === undefined ? publicPromptLowerBound(reportedUsage) : undefined;
    const output = exactUsage.outputTokens;
    const outputReported = output === undefined ? reportedUsage.outputTokens : undefined;
    const cost = useStatsUsage ? stats?.cost : exactUsage.cost?.total;
    const metrics = [
      input !== undefined
        ? `in ${compactCount(input)}`
        : inputReported === undefined ? undefined : `in ${compactCount(inputReported)}`,
      output !== undefined
        ? `out ${compactCount(output)}`
        : outputReported === undefined ? undefined : `out ${compactCount(outputReported)}`,
      cacheMetric,
      cost !== undefined && cost > 0 ? `$${cost.toFixed(3)}` : undefined,
      context === undefined
        ? undefined
        : `ctx ${context.percent === null ? "?" : Math.min(999, context.percent).toFixed(1)}%/${compactCount(context.contextWindow)}`,
    ].filter((value): value is string => value !== undefined);
    const model = this.session.state?.model;
    const thinking = model?.reasoning === true ? this.session.state?.thinkingLevel ?? "off" : undefined;
    const modelLabel = model?.id === undefined
      ? undefined
      : `${(this.footerData.getAvailableProviderCount?.() ?? 0) > 1 && model.provider !== undefined
        ? `(${model.provider}) `
        : ""}${model.id}${thinking === undefined ? "" : ` · ${thinking}`}`;
    const status = [...(this.footerData.getExtensionStatuses?.() ?? new Map<string, string>()).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value.replaceAll(/[\r\n\t]+/gu, " ").trim())
      .filter(Boolean)
      .join(" ");
    return [
      location,
      [...metrics, modelLabel].filter((value): value is string => value !== undefined).join(" · "),
      status,
    ].filter((value) => value !== "").map((value) => truncateToWidth(value, maximum, maximum >= 3 ? "..." : ""));
  }
}

export class LoginDialogComponent extends Container implements Focusable {
  readonly #controller = new AbortController();
  readonly #content = new Container();
  readonly #input = new Input();
  #focused = false;
  #resolve: ((value: string) => void) | undefined;
  #reject: ((error: Error) => void) | undefined;
  #cancelled = false;
  constructor(private readonly tui: TUI, providerId: string, private readonly complete: (success: boolean, message?: string) => void, providerName?: string, title?: string) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title ?? `Login to ${providerName ?? providerId}`, 1, 0));
    this.addChild(this.#content);
    this.addChild(new DynamicBorder());
    this.#input.onSubmit = (value) => {
      if (this.#resolve === undefined) return;
      this.#content.children = this.#content.children.map((child) => child === this.#input ? new Text(`> ${value}`, 0, 0) : child);
      const resolve = this.#resolve;
      this.#resolve = undefined;
      this.#reject = undefined;
      resolve(value);
      this.tui.requestRender();
    };
    this.#input.onEscape = () => this.#cancel();
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#input.focused = value; }
  get signal(): AbortSignal { return this.#controller.signal; }
  showAuth(url: string, instructions?: string): void {
    this.#replacePrompt();
    this.#content.clear();
    this.#content.addChild(new Text(url, 1, 0));
    if (instructions !== undefined) this.#content.addChild(new Text(instructions, 1, 0));
    this.tui.requestRender();
  }
  showDeviceCode(info: { verificationUri: string; userCode: string }): void {
    this.#replacePrompt();
    this.#content.clear();
    this.#content.addChild(new Text(info.verificationUri, 1, 0));
    this.#content.addChild(new Text(`Enter code: ${info.userCode}`, 1, 0));
    this.tui.requestRender();
  }
  showManualInput(prompt: string): Promise<string> { return this.#appendPrompt(prompt); }
  showPrompt(message: string, placeholder?: string): Promise<string> {
    this.#content.addChild(new Text(message, 1, 0));
    if (placeholder !== undefined && placeholder !== "") this.#content.addChild(new Text(`e.g., ${placeholder}`, 1, 0));
    return this.#appendInput();
  }
  showDetails(lines: string[]): void {
    this.#replacePrompt();
    this.#content.clear();
    for (const line of lines) this.#content.addChild(new Text(line, 1, 0));
    this.tui.requestRender();
  }
  showInfo(message: string, links: readonly { label?: string; url: string }[] = [], showCloseHint = false): void {
    this.#content.addChild(new Text(message, 1, 0));
    for (const link of links) this.#content.addChild(new Text(link.label === undefined ? link.url : `${link.label}: ${link.url}`, 1, 0));
    if (showCloseHint) this.#content.addChild(new Text("(cancel to close)", 1, 0));
    this.tui.requestRender();
  }
  showWaiting(message: string): void { this.#content.addChild(new Text(message, 1, 0)); this.tui.requestRender(); }
  showProgress(message: string): void { this.#content.addChild(new Text(message, 1, 0)); this.tui.requestRender(); }
  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) this.#cancel();
    else this.#input.handleInput(data);
  }
  #appendPrompt(prompt: string): Promise<string> { this.#content.addChild(new Text(prompt, 1, 0)); return this.#appendInput(); }
  #appendInput(): Promise<string> {
    this.#replacePrompt();
    this.#input.setValue("");
    this.#content.addChild(this.#input);
    this.tui.requestRender();
    return new Promise<string>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }
  #replacePrompt(): void {
    const reject = this.#reject;
    this.#resolve = undefined;
    this.#reject = undefined;
    this.#content.children = this.#content.children.filter((child) => child !== this.#input);
    reject?.(new Error("Login prompt was replaced"));
  }
  #cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    if (!this.#controller.signal.aborted) this.#controller.abort();
    this.#reject?.(new Error("Login cancelled"));
    this.#resolve = undefined;
    this.#reject = undefined;
    this.complete(false, "Login cancelled");
  }
}

export interface VisualTruncateResult { visualLines: string[]; skippedCount: number }
export function truncateToVisualLines(text: string, maxVisualLines: number, width: number, paddingX = 0): VisualTruncateResult {
  const available = Math.max(1, width - paddingX * 2);
  const visualLines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, available));
  const skippedCount = Math.max(0, visualLines.length - maxVisualLines);
  return { visualLines: visualLines.slice(skippedCount), skippedCount };
}

export interface RenderDiffOptions { filePath?: string }
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
  return diffText.split("\n").map((line) => line.startsWith("+") ? `\u001b[32m${line}\u001b[39m` : line.startsWith("-") ? `\u001b[31m${line}\u001b[39m` : line).join("\n");
}
