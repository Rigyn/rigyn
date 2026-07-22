import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Model } from "@rigyn/models";
import {
  Box,
  CancellableLoader,
  Container,
  Editor,
  getKeybindings,
  Input,
  Markdown,
  SelectList,
  Spacer,
  SettingsList,
  Text,
  type Component,
  type EditorOptions,
  type EditorTheme,
  type Focusable,
  type KeybindingsManager,
  type MarkdownTheme,
  type TUI,
} from "@rigyn/terminal";
import { wrapTextWithAnsi } from "@rigyn/terminal";

import type { ThinkingLevel } from "../core/settings-manager.js";
import type { CustomMessage, MessageRenderer, ToolDefinition, ToolRenderContext } from "../extensions/direct.js";
import type { SessionInfo, SessionTreeNode } from "../storage/types.js";
import type { TruncationResult } from "../tools/truncate.js";
import type { KeybindingAction } from "./keybindings.js";
import { currentTheme, getEditorTheme, getMarkdownTheme, getSelectListTheme, getSettingsListTheme } from "./public-theme.js";
import type { Theme } from "./theme.js";
import { stripAnsi } from "./unicode.js";

export type AppKeybinding = KeybindingAction;

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

const COMMAND_ZONE_START = "\x1b]133;A\x07";
const COMMAND_ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";

export class AssistantMessageComponent extends Container {
  #message: AssistantMessage | undefined;
  #hideThinkingBlock: boolean;
  #markdownTheme: MarkdownTheme;
  #hiddenThinkingLabel: string;
  #outputPad: number;
  #hasToolCalls = false;

  constructor(message?: AssistantMessage, hideThinkingBlock = false, theme: MarkdownTheme = getMarkdownTheme(), hiddenThinkingLabel = "Thinking...", outputPad = 1) {
    super();
    this.#hideThinkingBlock = hideThinkingBlock;
    this.#markdownTheme = theme;
    this.#hiddenThinkingLabel = hiddenThinkingLabel;
    this.#outputPad = Math.max(0, Math.floor(outputPad));
    if (message !== undefined) this.updateContent(message);
  }

  updateContent(message: AssistantMessage): void {
    this.#message = message;
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
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]!;
      if (block.type === "text" && block.text.trim() !== "") {
        this.addChild(new Markdown(block.text.trim(), this.#outputPad, 0, this.#markdownTheme));
        continue;
      }
      if (block.type !== "thinking") continue;
      const thinking: string[] = [];
      while (index < content.length && content[index]?.type === "thinking") {
        const value = (content[index] as Extract<AssistantMessage["content"][number], { type: "thinking" }>).thinking.trim();
        if (value !== "") thinking.push(value);
        index += 1;
      }
      index -= 1;
      if (thinking.length === 0) continue;
      if (this.#hideThinkingBlock) this.addChild(new Text(this.#hiddenThinkingLabel, this.#outputPad, 0));
      else this.addChild(new Markdown(thinking.join("\n\n"), this.#outputPad, 0, this.#markdownTheme));
    }
    const stopReason = this.#message?.stopReason;
    if (stopReason === "length") this.addChild(new Text("Error: Model stopped at the maximum output token limit. The response may be incomplete.", this.#outputPad, 0));
    else if (!this.#hasToolCalls && stopReason === "aborted") this.addChild(new Text(this.#message?.errorMessage && this.#message.errorMessage !== "Request was aborted" ? this.#message.errorMessage : "Operation aborted", this.#outputPad, 0));
    else if (!this.#hasToolCalls && stopReason === "error") this.addChild(new Text(`Error: ${this.#message?.errorMessage ?? "Unknown error"}`, this.#outputPad, 0));
  }
}

export class UserMessageComponent extends Container {
  readonly #text: string;
  readonly #markdownTheme: MarkdownTheme;
  #outputPad: number;

  constructor(text: string, theme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
    super();
    this.#text = text;
    this.#markdownTheme = theme;
    this.#outputPad = Math.max(0, Math.floor(outputPad));
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
    const box = new Box(this.#outputPad, 1);
    box.addChild(new Markdown(this.#text, 0, 0, this.#markdownTheme, undefined, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    }));
    this.addChild(box);
  }
}

class ExpandableSummary extends Box {
  #expanded = false;
  readonly value: string;
  readonly body: Markdown;
  constructor(message: unknown, theme?: MarkdownTheme) {
    super(1, 0); this.value = textContent(message); this.body = new Markdown("", 0, 0, theme ?? getMarkdownTheme());
    this.addChild(this.body); this.#update();
  }
  setExpanded(expanded: boolean): void { this.#expanded = expanded; this.#update(); }
  #update(): void { this.body.setText(this.#expanded ? this.value : this.value.split("\n").find(Boolean) ?? ""); }
}

export class BranchSummaryMessageComponent extends ExpandableSummary {}
export class CompactionSummaryMessageComponent extends ExpandableSummary {}
export class SkillInvocationMessageComponent extends ExpandableSummary {}

export class CustomMessageComponent extends Container {
  readonly #message: CustomMessage<unknown>;
  readonly #renderer: MessageRenderer | undefined;
  readonly #markdownTheme: MarkdownTheme;
  #expanded = false;

  constructor(message: CustomMessage<unknown>, renderer?: MessageRenderer, theme: MarkdownTheme = getMarkdownTheme()) {
    super();
    this.#message = message;
    this.#renderer = renderer;
    this.#markdownTheme = theme;
    this.#rebuild();
  }
  setExpanded(expanded: boolean): void { if (this.#expanded !== expanded) { this.#expanded = expanded; this.#rebuild(); } }
  override invalidate(): void { this.#rebuild(); super.invalidate(); }
  #rebuild(): void {
    this.clear();
    if (this.#renderer !== undefined) {
      try {
        const rendered = this.#renderer(this.#message, { expanded: this.#expanded }, currentTheme());
        if (rendered !== undefined) { this.addChild(rendered); return; }
      } catch { /* renderer failures use the readable fallback */ }
    }
    const box = new Box(1, 1);
    box.addChild(new Text(`[${this.#message.customType}]`, 0, 0));
    const value = typeof this.#message.content === "string"
      ? this.#message.content
      : this.#message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    box.addChild(new Markdown(value, 0, 0, this.#markdownTheme));
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
    for (const [action, handler] of this.actionHandlers) if (this.keybindings.matches(data, action)) { handler(); return; }
    if (data === "\u001b" && this.onEscape !== undefined) { this.onEscape(); return; }
    if (data === "\u0004" && this.onCtrlD !== undefined) { this.onCtrlD(); return; }
    if (data === "\u0016" && this.onPasteImage !== undefined) { this.onPasteImage(); return; }
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

  constructor(title: string, _placeholder: string | undefined, onSubmit: (value: string) => void, onCancel: () => void, options?: ExtensionInputOptions) {
    super();
    this.#baseTitle = title;
    this.#onSubmit = onSubmit;
    this.#onCancel = onCancel;
    this.#title = new Text(title, 1, 0);
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.#title);
    this.addChild(new Spacer(1));
    this.addChild(this.#input);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.#countdown = options?.tui !== undefined && (options.timeout ?? 0) > 0
      ? new Countdown(options.timeout!, options.tui, (seconds) => this.#title.setText(`${this.#baseTitle} (${seconds}s)`), onCancel)
      : undefined;
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#input.focused = value; }
  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.confirm") || data === "\n") this.#onSubmit(this.#input.getValue());
    else if (keys.matches(data, "tui.select.cancel")) this.#onCancel();
    else this.#input.handleInput(data);
  }
  dispose(): void { this.#countdown?.dispose(); }
}

export class ExtensionEditorComponent extends Container implements Focusable {
  readonly #editor: Editor;
  readonly #tui: TUI;
  readonly #keybindings: KeybindingsManager;
  readonly #onCancel: () => void;
  readonly #externalEditorCommand: string | undefined;
  #focused = false;
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
    this.#editor.onSubmit = onSubmit;
    this.addChild(this.#editor);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#editor.focused = value; }
  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) { this.#onCancel(); return; }
    if (this.#keybindings.matches(data, "app.editor.external" as never)) { void this.#openExternalEditor(); return; }
    this.#editor.handleInput(data);
  }
  async #openExternalEditor(): Promise<void> {
    const command = this.#externalEditorCommand ?? process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "nano");
    const [executable, ...args] = command.trim().split(/\s+/u);
    if (executable === undefined || executable === "") return;
    const file = join(tmpdir(), `rigyn-extension-editor-${process.pid}-${Date.now()}.md`);
    try {
      await writeFile(file, this.#editor.getText(), "utf8");
      this.#tui.stop();
      const status = await new Promise<number | null>((resolve) => {
        const child = spawn(executable, [...args, file], { stdio: "inherit", shell: process.platform === "win32" });
        child.once("error", () => resolve(null));
        child.once("close", resolve);
      });
      if (status === 0) this.#editor.setText((await readFile(file, "utf8")).replace(/\n$/u, ""));
    } finally {
      await unlink(file).catch(() => undefined);
      this.#tui.start();
      this.#tui.requestRender(true);
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
  constructor(title: string, options: string[], onSelect: (value: string) => void, onCancel: () => void, config?: ExtensionSelectorOptions) {
    super();
    const titleText = new Text(title, 1, 0);
    this.#toggle = config?.onToggleToolsExpanded;
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(titleText);
    this.addChild(new Spacer(1));
    this.#list = selection(title, options, onSelect, onCancel);
    this.addChild(this.#list);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.#countdown = config?.tui !== undefined && (config.timeout ?? 0) > 0
      ? new Countdown(config.timeout!, config.tui, (seconds) => titleText.setText(`${title} (${seconds}s)`), onCancel)
      : undefined;
  }
  handleInput(data: string): void {
    if (getKeybindings().matches(data, "app.tools.expand")) this.#toggle?.();
    else if (data === "j") this.#list.handleInput("\x1b[B");
    else if (data === "k") this.#list.handleInput("\x1b[A");
    else this.#list.handleInput(data);
  }
  dispose(): void { this.#countdown?.dispose(); }
}

class ValueSelector<T extends string> extends Container {
  readonly list: SelectList;
  constructor(values: readonly T[], current: T | undefined, onSelect: (value: T) => void, onCancel: () => void) {
    super(); this.list = selection("", values, (value) => onSelect(value as T), onCancel);
    const index = current === undefined ? 0 : values.indexOf(current); this.list.setSelectedIndex(Math.max(0, index)); this.addChild(this.list);
  }
  handleInput(data: string): void { this.list.handleInput(data); }
  getSelectList(): SelectList { return this.list; }
}

export class ThinkingSelectorComponent extends ValueSelector<ThinkingLevel> {
  constructor(current: ThinkingLevel, levels: ThinkingLevel[], onSelect: (level: ThinkingLevel) => void, onCancel: () => void) { super(levels, current, onSelect, onCancel); }
}
export class ShowImagesSelectorComponent extends ValueSelector<"show" | "hide"> {
  constructor(current: boolean, onSelect: (show: boolean) => void, onCancel: () => void) { super(["show", "hide"], current ? "show" : "hide", (value) => onSelect(value === "show"), onCancel); }
}
export class ThemeSelectorComponent extends ValueSelector<string> {
  constructor(current: string, onSelect: (theme: string) => void, onCancel: () => void, onPreview: (theme: string) => void) {
    super(["dark", "light", "mono"], current, onSelect, onCancel); this.list.onSelectionChange = (item) => onPreview(item.value);
  }
}

export class UserMessageSelectorComponent extends ValueSelector<string> {
  constructor(messages: Array<{ id: string; text: string }>, onSelect: (id: string) => void, onCancel: () => void, initial?: string) {
    super(messages.map((message) => message.id), initial, onSelect, onCancel);
  }
  getMessageList(): SelectList { return this.list; }
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
    else if (keys.matches(data, "tui.select.cancel")) { this.#close(); this.#onCancel(); }
    else { this.#search.handleInput(data); this.#filter(); }
  }
  dispose(): void { this.#close(); }
  #close(): void { if (!this.#closed) { this.#closed = true; this.#controller.abort(); } }
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
  constructor(mode: "login" | "logout", providers: AuthSelectorProvider[], onSelect: (id: string, authType: "oauth" | "api_key") => void, onCancel: () => void, initialSearchInput?: string) {
    super();
    this.#providers = [...providers];
    this.#filtered = [...providers];
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.addChild(new DynamicBorder());
    this.addChild(new Text(mode === "login" ? "Select provider to configure:" : "Select provider to logout:", 1, 0));
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
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up")) { if (this.#filtered.length > 0) this.#selected = Math.max(0, this.#selected - 1); this.#renderList(); }
    else if (keys.matches(data, "tui.select.down")) { if (this.#filtered.length > 0) this.#selected = Math.min(this.#filtered.length - 1, this.#selected + 1); this.#renderList(); }
    else if (keys.matches(data, "tui.select.confirm") || data === "\n") this.#select();
    else if (keys.matches(data, "tui.select.cancel")) this.#onCancel();
    else { this.#search.handleInput(data); this.#filter(); }
  }
  #select(): void { const selected = this.#filtered[this.#selected]; if (selected !== undefined) this.#onSelect(selected.id, selected.authType); }
  #filter(): void {
    const query = this.#search.getValue();
    this.#filtered = query === "" ? [...this.#providers] : this.#providers.filter((entry) => searchMatch(`${entry.name} ${entry.id} ${entry.authType} ${entry.method?.name ?? ""}`, query));
    this.#selected = Math.max(0, Math.min(this.#selected, this.#filtered.length - 1));
    this.#renderList();
  }
  #renderList(): void {
    this.#listContainer.clear();
    if (this.#filtered.length === 0) this.#listContainer.addChild(new Text("  No matching providers", 0, 0));
    else this.#filtered.slice(0, 8).forEach((provider, index) => this.#listContainer.addChild(new Text(`${index === this.#selected ? "→" : " "} ${provider.name} [${provider.authType === "oauth" ? "subscription" : "API key"}]`, 0, 0)));
  }
}

type SessionsLoader = (onProgress?: (loaded: number, total: number) => void) => Promise<SessionInfo[]>;
class PublicSessionList implements Component, Focusable {
  readonly #search = new Input();
  #sessions: SessionInfo[] = [];
  #filtered: SessionInfo[] = [];
  #selected = 0;
  #focused = false;
  onSelect?: (path: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#search.focused = value; }
  setSessions(sessions: SessionInfo[]): void { this.#sessions = [...sessions]; this.#filter(); }
  getSelectedSessionPath(): string | undefined { return this.#filtered[this.#selected]?.path; }
  invalidate(): void {}
  render(width: number): string[] {
    const rows = this.#filtered.length === 0
      ? ["  No sessions found"]
      : this.#filtered.slice(Math.max(0, this.#selected - 5), Math.max(0, this.#selected - 5) + 10).map((session) => {
          const index = this.#filtered.indexOf(session);
          return `${index === this.#selected ? "→" : " "} ${(session.name ?? session.firstMessage) || session.id}`.slice(0, width);
        });
    return [...this.#search.render(width), ...rows];
  }
  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up")) { if (this.#filtered.length > 0) this.#selected = this.#selected === 0 ? this.#filtered.length - 1 : this.#selected - 1; }
    else if (keys.matches(data, "tui.select.down")) { if (this.#filtered.length > 0) this.#selected = this.#selected === this.#filtered.length - 1 ? 0 : this.#selected + 1; }
    else if (keys.matches(data, "tui.select.confirm") || data === "\n") { const selected = this.#filtered[this.#selected]; if (selected !== undefined) this.onSelect?.(selected.path); }
    else if (keys.matches(data, "tui.select.cancel")) this.onCancel?.();
    else if (keys.matches(data, "app.exit")) this.onExit?.();
    else { this.#search.handleInput(data); this.#filter(); }
  }
  #filter(): void {
    const query = this.#search.getValue();
    this.#filtered = query === "" ? [...this.#sessions] : this.#sessions.filter((session) => searchMatch(`${session.name ?? ""} ${session.firstMessage} ${session.cwd} ${session.path}`, query));
    this.#selected = Math.max(0, Math.min(this.#selected, this.#filtered.length - 1));
  }
}

export class SessionSelectorComponent extends Container implements Focusable {
  readonly #currentLoader: SessionsLoader;
  readonly #allLoader: SessionsLoader;
  readonly #requestRender: () => void;
  readonly #list = new PublicSessionList();
  readonly #header = new Text("Resume Session (Current Folder)", 0, 0);
  #scope: "current" | "all" = "current";
  #focused = false;
  constructor(currentLoader: SessionsLoader, allLoader: SessionsLoader, onSelect: (path: string) => void, onCancel: () => void, onExit: () => void, requestRender: () => void, _options?: { renameSession?: (path: string, currentName: string | undefined) => Promise<void>; showRenameHint?: boolean; keybindings?: KeybindingsManager }, _currentSessionFilePath?: string) {
    super();
    this.#currentLoader = currentLoader;
    this.#allLoader = allLoader;
    this.#requestRender = requestRender;
    this.#list.onSelect = onSelect;
    this.#list.onCancel = onCancel;
    this.#list.onExit = onExit;
    this.addChild(new DynamicBorder());
    this.addChild(this.#header);
    this.addChild(this.#list);
    this.addChild(new DynamicBorder());
    void this.#load("current");
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.#list.focused = value; }
  handleInput(data: string): void {
    if (getKeybindings().matches(data, "app.session.toggleScope")) {
      this.#scope = this.#scope === "current" ? "all" : "current";
      void this.#load(this.#scope);
    } else this.#list.handleInput(data);
  }
  getSessionList(): PublicSessionList { return this.#list; }
  async #load(scope: "current" | "all"): Promise<void> {
    this.#header.setText(scope === "current" ? "Resume Session (Current Folder) · Loading…" : "Resume Session (All) · Loading…");
    this.#requestRender();
    try {
      const sessions = await (scope === "current" ? this.#currentLoader : this.#allLoader)(() => this.#requestRender());
      if (scope !== this.#scope) return;
      this.#list.setSessions(sessions);
      this.#header.setText(scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)");
    } catch (error) {
      if (scope === this.#scope) this.#header.setText(`Failed to load sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#requestRender();
  }
}

interface TreeNodeLike { entry?: { id?: string; [key: string]: unknown }; id?: string; label?: string; children?: TreeNodeLike[] }
function flattenTree(nodes: readonly TreeNodeLike[], depth = 0): Array<{ id: string; label: string }> {
  const result: Array<{ id: string; label: string }> = [];
  for (const node of nodes) {
    const id = node.entry?.id ?? node.id;
    if (typeof id === "string") result.push({ id, label: `${"  ".repeat(depth)}${node.label ?? id}` });
    result.push(...flattenTree(node.children ?? [], depth + 1));
  }
  return result;
}

export class TreeSelectorComponent extends Container implements Focusable {
  readonly #list: SelectList;
  #focused = false;
  onCopy?: (text: string | undefined) => void;
  constructor(tree: SessionTreeNode[] | TreeNodeLike[], current: string | null, terminalHeight: number, onSelect: (id: string) => void, onCancel: () => void, _onLabelChange?: (id: string, label: string | undefined) => void, initialSelectedId?: string, _initialFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all") {
    super();
    const values = flattenTree(tree as TreeNodeLike[]);
    this.#list = new SelectList(values.map((entry) => ({ value: entry.id, label: entry.label })), Math.max(5, Math.floor(terminalHeight / 2)), getSelectListTheme());
    const selected = values.findIndex((entry) => entry.id === (initialSelectedId ?? current));
    if (selected >= 0) this.#list.setSelectedIndex(selected);
    this.#list.onSelect = (item) => onSelect(item.value);
    this.#list.onCancel = onCancel;
    this.addChild(new DynamicBorder());
    this.addChild(new Text("Session Tree", 1, 0));
    this.addChild(this.#list);
    this.addChild(new DynamicBorder());
    if (values.length === 0) setTimeout(onCancel, 100).unref?.();
  }
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; }
  handleInput(data: string): void { this.#list.handleInput(data); }
  getTreeList(): SelectList { return this.#list; }
}

export interface SettingsConfig { [key: string]: unknown }
export interface SettingsCallbacks { onCancel(): void; [key: string]: unknown }
export class SettingsSelectorComponent extends Container {
  readonly #list: SettingsList;
  constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
    super(); const items = Object.entries(config).map(([id, value]) => ({ id, label: id, currentValue: String(value) }));
    this.#list = new SettingsList(items, 16, getSettingsListTheme(), () => undefined, callbacks.onCancel, { enableSearch: true }); this.addChild(this.#list);
  }
  getSettingsList(): SettingsList { return this.#list; }
}

export class BashExecutionComponent extends Container {
  #output = "";
  readonly #text = new Text("", 1, 0);
  #expanded = false;
  #status: "running" | "complete" | "cancelled" | "error" = "running";
  #exitCode: number | undefined;
  #truncation: TruncationResult | undefined;
  #fullOutputPath: string | undefined;
  constructor(private readonly command: string, private readonly ui: TUI, private readonly exclude = false) { super(); this.addChild(this.#text); this.#render(); }
  appendOutput(chunk: string): void { this.#output += stripAnsi(chunk).replace(/\r\n|\r/gu, "\n"); this.#render(); this.ui.requestRender(); }
  setComplete(exitCode: number | undefined, cancelled: boolean, truncationResult?: TruncationResult, fullOutputPath?: string): void {
    this.#exitCode = exitCode;
    this.#status = cancelled ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? "error" : "complete";
    this.#truncation = truncationResult;
    this.#fullOutputPath = fullOutputPath;
    this.#render();
    this.ui.requestRender();
  }
  setExpanded(expanded: boolean): void { this.#expanded = expanded; this.#render(); }
  getOutput(): string { return this.#output; }
  getCommand(): string { return this.command; }
  override invalidate(): void { this.#render(); super.invalidate(); }
  #render(): void {
    const lines = this.#output.split("\n");
    const hidden = Math.max(0, lines.length - 20);
    const shown = this.#expanded ? lines : lines.slice(-20);
    const status: string[] = [];
    if (this.#status === "running") status.push("Running…");
    else if (this.#status === "cancelled") status.push("(cancelled)");
    else if (this.#status === "error") status.push(`(exit ${this.#exitCode ?? "unknown"})`);
    if (hidden > 0) status.push(this.#expanded ? "(collapse for preview)" : `... ${hidden} more lines (expand to view)`);
    if (this.#truncation?.truncated === true && this.#fullOutputPath !== undefined) status.push(`Output truncated. Full output: ${this.#fullOutputPath}`);
    const marker = this.exclude ? "!!" : "$";
    this.#text.setText([`${marker} ${this.command}`, ...(this.#output === "" ? [] : shown), ...status].join("\n"));
  }
}

export interface ToolExecutionOptions { showImages?: boolean; imageWidthCells?: number }
export class ToolExecutionComponent extends Container {
  readonly #body = new Container();
  readonly #rendererState: Record<string, unknown> = {};
  #result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean } | undefined;
  #partial = true;
  #expanded = false;
  #showImages: boolean;
  #imageWidthCells: number;
  #executionStarted = false;
  #argsComplete = false;
  constructor(private readonly toolName: string, private readonly id: string, private args: unknown, options: ToolExecutionOptions = {}, private readonly definition?: ToolDefinition, private readonly ui: TUI = { requestRender() {} } as TUI, private readonly cwd = process.cwd()) {
    super();
    this.#showImages = options.showImages ?? true;
    this.#imageWidthCells = options.imageWidthCells ?? 60;
    this.addChild(this.#body);
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
  #context(lastComponent: Component | undefined): ToolRenderContext<Record<string, unknown>, unknown> {
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
    this.#body.clear();
    let last: Component | undefined;
    if (this.definition?.renderCall !== undefined) {
      try {
        last = this.definition.renderCall(this.args as never, currentTheme(), this.#context(undefined) as never);
        this.#body.addChild(last);
      } catch { last = undefined; }
    }
    if (last === undefined) {
      last = new Text(`${this.toolName} ${JSON.stringify(this.args)}`, 0, 0);
      this.#body.addChild(last);
    }
    if (this.#result !== undefined && this.definition?.renderResult !== undefined) {
      try {
        const rendered = this.definition.renderResult(this.#result as never, { expanded: this.#expanded, isPartial: this.#partial }, currentTheme(), this.#context(last) as never);
        if (rendered !== undefined) { this.#body.addChild(rendered); return; }
      } catch { /* readable fallback follows */ }
    }
    const output = toolResultText(this.#result, this.#showImages, this.#imageWidthCells);
    if (output !== "") {
      const lines = output.split("\n");
      const hidden = Math.max(0, lines.length - 20);
      const displayed = this.#expanded ? lines : lines.slice(-20);
      if (hidden > 0) displayed.push(this.#expanded ? "(collapse for preview)" : `... ${hidden} more lines (expand to view)`);
      this.#body.addChild(new Text(displayed.join("\n"), 0, 0));
    }
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
  return result.content.map((block) => block.type === "text" ? block.text ?? "" : block.type === "image" ? (showImages ? `[image ${block.mimeType ?? "unknown"}, width ${imageWidthCells}]` : "[image hidden]") : "").filter(Boolean).join("\n");
}

export class FooterComponent implements Component {
  constructor(private session: { cwd?: string; getSessionStats?(): unknown }, private readonly footerData: { getGitBranch(): string | null }) {}
  setSession(session: { cwd?: string; getSessionStats?(): unknown }): void { this.session = session; }
  setAutoCompactEnabled(_enabled: boolean): void {}
  invalidate(): void {}
  dispose(): void {}
  render(width: number): string[] {
    const branch = this.footerData.getGitBranch(); const value = [this.session.cwd, branch].filter(Boolean).join(" · ");
    return [value.slice(0, Math.max(0, width))];
  }
}

export class LoginDialogComponent extends Container implements Focusable {
  readonly #controller = new AbortController();
  readonly #content = new Container();
  readonly #input = new Input();
  #focused = false;
  #resolve: ((value: string) => void) | undefined;
  #reject: ((error: Error) => void) | undefined;
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
    this.#content.clear();
    this.#content.addChild(new Text(url, 1, 0));
    if (instructions !== undefined) this.#content.addChild(new Text(instructions, 1, 0));
    this.tui.requestRender();
  }
  showDeviceCode(info: { verificationUri: string; userCode: string }): void {
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
    if (this.#reject !== undefined) this.#reject(new Error("Login prompt was replaced"));
    this.#input.setValue("");
    this.#content.addChild(this.#input);
    this.tui.requestRender();
    return new Promise<string>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }
  #cancel(): void {
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
