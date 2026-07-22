import type { SettingsManager, ThinkingLevel, TransportSetting } from "../core/settings-manager.js";
import type { AgentSession } from "../service/agent-session.js";
import type { TuiController } from "../tui/controller.js";
import type { TuiOperatorPreferences, TuiSettingItem } from "../tui/types.js";

const BOOLEAN_VALUES = ["on", "off"] as const;

function booleanItem(
  id: string,
  label: string,
  description: string,
  enabled: boolean,
): TuiSettingItem {
  return { id, label, description, value: enabled ? "on" : "off", values: BOOLEAN_VALUES };
}

function numericValues(current: number, choices: readonly number[]): string[] {
  return [...new Set([current, ...choices])].sort((left, right) => left - right).map(String);
}

export function tuiOperatorPreferences(settings: SettingsManager): TuiOperatorPreferences {
  return {
    hideThinkingBlock: settings.getHideThinkingBlock(),
    showCacheMissNotices: settings.getShowCacheMissNotices(),
    externalEditor: settings.getExternalEditorCommand(),
    treeFilterMode: settings.getTreeFilterMode(),
    editorPaddingX: settings.getEditorPaddingX(),
    outputPad: settings.getOutputPad(),
    autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
    showHardwareCursor: settings.getShowHardwareCursor(),
    showImages: settings.getShowImages(),
    imageWidthCells: settings.getImageWidthCells(),
    clearOnShrink: settings.getClearOnShrink(),
    codeBlockIndent: settings.getCodeBlockIndent(),
  };
}

export function interactiveSettingItems(
  settings: SettingsManager,
  session: Pick<AgentSession,
    "autoCompactionEnabled" | "steeringMode" | "followUpMode" | "thinkingLevel" | "getAvailableThinkingLevels">,
  themes: readonly string[],
): TuiSettingItem[] {
  const selectedTheme = settings.getThemeSetting() ?? "dark";
  const thinkingLevels = [...new Set([session.thinkingLevel, ...session.getAvailableThinkingLevels()])];
  const availableThemes = [...new Set([selectedTheme, ...themes])].sort((left, right) => left.localeCompare(right));
  return [
    booleanItem("auto-compact", "Automatic compaction", "Compact context before the model limit is reached", session.autoCompactionEnabled),
    booleanItem("show-images", "Show terminal images", "Render supported image attachments in the transcript", settings.getShowImages()),
    { id: "image-width", label: "Image width", description: "Maximum terminal image width in cells", value: String(settings.getImageWidthCells()), values: numericValues(settings.getImageWidthCells(), [40, 60, 80, 100, 120]) },
    booleanItem("auto-resize-images", "Resize large images", "Resize oversized image inputs before provider upload", settings.getImageAutoResize()),
    booleanItem("block-images", "Block image inputs", "Reject image inputs instead of sending them to providers", settings.getBlockImages()),
    booleanItem("skill-commands", "Skill commands", "Expose discovered skills as slash commands", settings.getEnableSkillCommands()),
    { id: "steering-mode", label: "Steering queue", description: "How queued steering messages are delivered", value: session.steeringMode, values: ["one-at-a-time", "all"] },
    { id: "follow-up-mode", label: "Follow-up queue", description: "How queued follow-up messages are delivered", value: session.followUpMode, values: ["one-at-a-time", "all"] },
    { id: "transport", label: "Provider transport", description: "Preferred streaming transport for compatible providers", value: settings.getTransport(), values: ["auto", "sse", "websocket", "websocket-cached"] },
    { id: "thinking-level", label: "Reasoning level", description: "Default reasoning effort for the active model", value: session.thinkingLevel, values: thinkingLevels.length === 0 ? ["off"] : thinkingLevels },
    { id: "theme", label: "Theme", description: "Active terminal color theme", value: selectedTheme, values: availableThemes.length === 0 ? [selectedTheme] : availableThemes },
    booleanItem("hide-thinking", "Hide reasoning blocks", "Collapse model reasoning content in the transcript", settings.getHideThinkingBlock()),
    booleanItem("cache-miss-notices", "Cache miss notices", "Show provider prompt-cache miss diagnostics", settings.getShowCacheMissNotices()),
    booleanItem("collapse-changelog", "Compact update notice", "Use a one-line startup notice after updates; /changelog stays complete", settings.getCollapseChangelog()),
    { id: "double-escape", label: "Double-Escape action", description: "Action opened by pressing Escape twice", value: settings.getDoubleEscapeAction(), values: ["tree", "fork", "none"] },
    { id: "tree-filter", label: "Session tree filter", description: "Entries shown by default in the session tree", value: settings.getTreeFilterMode(), values: ["default", "no-tools", "user-only", "labeled-only", "all"] },
    booleanItem("hardware-cursor", "Hardware cursor", "Use the terminal cursor for the editor insertion point", settings.getShowHardwareCursor()),
    { id: "project-trust", label: "Default project trust", description: "Default decision for unrecognized project resources", value: settings.getDefaultProjectTrust(), values: ["ask", "always", "never"] },
    { id: "editor-padding", label: "Editor padding", description: "Horizontal editor padding in terminal cells", value: String(settings.getEditorPaddingX()), values: ["0", "1", "2", "3"] },
    { id: "output-padding", label: "Output padding", description: "Horizontal transcript padding in terminal cells", value: String(settings.getOutputPad()), values: ["0", "1"] },
    { id: "autocomplete-rows", label: "Autocomplete rows", description: "Maximum visible autocomplete suggestions", value: String(settings.getAutocompleteMaxVisible()), values: numericValues(settings.getAutocompleteMaxVisible(), [3, 5, 8, 10, 15, 20]) },
    booleanItem("quiet-startup", "Quiet startup", "Hide nonessential startup details", settings.getQuietStartup()),
    booleanItem("clear-on-shrink", "Clear after terminal shrink", "Clear stale cells after the terminal becomes smaller", settings.getClearOnShrink()),
    booleanItem("terminal-progress", "Terminal progress", "Show terminal-level progress diagnostics", settings.getShowTerminalProgress()),
    booleanItem("anthropic-usage-warning", "Anthropic usage warning", "Warn when Anthropic reports extra billed usage", settings.getWarnings().anthropicExtraUsage !== false),
  ];
}

function enabled(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`Expected on or off, received ${value}`);
}

function integer(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function applyInteractiveSetting(
  item: Pick<TuiSettingItem, "id">,
  value: string,
  settings: SettingsManager,
  session: Pick<AgentSession,
    "setAutoCompactionEnabled" | "setSteeringMode" | "setFollowUpMode" | "setThinkingLevel">,
  terminal: Pick<TuiController, "setTheme" | "setDoubleEscapeAction" | "setOperatorPreferences">,
): void {
  switch (item.id) {
    case "auto-compact": session.setAutoCompactionEnabled(enabled(value)); return;
    case "show-images": settings.setShowImages(enabled(value)); break;
    case "image-width": settings.setImageWidthCells(integer(value, 1, 500)); break;
    case "auto-resize-images": settings.setImageAutoResize(enabled(value)); return;
    case "block-images": settings.setBlockImages(enabled(value)); return;
    case "skill-commands": settings.setEnableSkillCommands(enabled(value)); return;
    case "steering-mode": session.setSteeringMode(value as "all" | "one-at-a-time"); return;
    case "follow-up-mode": session.setFollowUpMode(value as "all" | "one-at-a-time"); return;
    case "transport": settings.setTransport(value as TransportSetting); return;
    case "thinking-level": settings.setDefaultThinkingLevel(value as ThinkingLevel); session.setThinkingLevel(value); return;
    case "theme": settings.setTheme(value); terminal.setTheme(value); return;
    case "hide-thinking": settings.setHideThinkingBlock(enabled(value)); break;
    case "cache-miss-notices": settings.setShowCacheMissNotices(enabled(value)); break;
    case "collapse-changelog": settings.setCollapseChangelog(enabled(value)); return;
    case "double-escape": settings.setDoubleEscapeAction(value as "tree" | "fork" | "none"); terminal.setDoubleEscapeAction(value as "tree" | "fork" | "none"); return;
    case "tree-filter": settings.setTreeFilterMode(value as "default" | "no-tools" | "user-only" | "labeled-only" | "all"); break;
    case "hardware-cursor": settings.setShowHardwareCursor(enabled(value)); break;
    case "project-trust": settings.setDefaultProjectTrust(value as "ask" | "always" | "never"); return;
    case "editor-padding": settings.setEditorPaddingX(integer(value, 0, 3)); break;
    case "output-padding": settings.setOutputPad(integer(value, 0, 1) as 0 | 1); break;
    case "autocomplete-rows": settings.setAutocompleteMaxVisible(integer(value, 3, 20)); break;
    case "quiet-startup": settings.setQuietStartup(enabled(value)); return;
    case "clear-on-shrink": settings.setClearOnShrink(enabled(value)); break;
    case "terminal-progress": settings.setShowTerminalProgress(enabled(value)); return;
    case "anthropic-usage-warning": settings.setWarnings({ ...settings.getWarnings(), anthropicExtraUsage: enabled(value) }); return;
    default: throw new Error(`Unknown interactive setting: ${item.id}`);
  }
  terminal.setOperatorPreferences(tuiOperatorPreferences(settings));
}
