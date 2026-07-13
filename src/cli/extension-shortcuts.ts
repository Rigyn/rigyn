import type { RuntimeShortcutDescription } from "../extensions/index.js";
import { Keybindings, type KeybindingAction } from "../tui/index.js";

const RESERVED_ACTIONS = new Set<KeybindingAction>([
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.editor.external",
  "app.model.select",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.thinking.cycle",
  "app.thinking.toggle",
  "app.tools.expand",
  "app.message.followUp",
  "tui.input.submit",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.editor.deleteToLineEnd",
]);

export interface ResolvedRuntimeShortcuts {
  shortcuts: RuntimeShortcutDescription[];
  diagnostics: string[];
}

export function resolveRuntimeShortcuts(
  shortcuts: readonly RuntimeShortcutDescription[],
  keybindings: Keybindings,
): ResolvedRuntimeShortcuts {
  const active: RuntimeShortcutDescription[] = [];
  const diagnostics: string[] = [];
  for (const shortcut of shortcuts) {
    const conflicts = keybindings.actionsForKey(shortcut.shortcut);
    const reserved = conflicts.filter((action) => RESERVED_ACTIONS.has(action));
    if (reserved.length > 0) {
      diagnostics.push(`Extension ${shortcut.extensionId} shortcut ${shortcut.shortcut} was skipped because it conflicts with reserved action ${reserved.join(", ")}`);
      continue;
    }
    if (conflicts.length > 0) {
      diagnostics.push(`Extension ${shortcut.extensionId} shortcut ${shortcut.shortcut} replaces ${conflicts.join(", ")}`);
    }
    active.push({ ...shortcut });
  }
  return { shortcuts: active, diagnostics };
}
