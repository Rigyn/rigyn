import { Text } from "rigyn/tui";

class DismissibleOverlay extends Text {
  constructor(done) { super("Example overlay · press Enter or Escape", 1, 1); this.done = done; }
  handleInput(data) { if (data === "\r" || data === "\x1b") this.done(); }
}

const snippets = [
  { value: "TODO: ", label: ":todo", description: "Insert a task marker" },
  { value: "NOTE: ", label: ":note", description: "Insert a note marker" },
  { value: "REVIEW: ", label: ":review", description: "Insert a review marker" },
];

function snippetPrefix(lines, cursorLine, cursorCol) {
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
  return before.match(/(?:^|\s)(:[a-z]*)$/u)?.[1];
}

export default function activate(rigyn) {
  rigyn.on("session_start", (_event, context) => {
    if (!context.hasUI) return;
    context.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":"])],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        if (options.signal.aborted) return null;
        const prefix = snippetPrefix(lines, cursorLine, cursorCol);
        if (prefix === undefined) return await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const query = prefix.slice(1);
        const items = snippets.filter((item) => item.label.slice(1).startsWith(query));
        return items.length === 0
          ? await current.getSuggestions(lines, cursorLine, cursorCol, options)
          : { items, prefix };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  rigyn.registerCommand("example-ui-panel", {
    description: "Mount a status, header, and widget",
    async handler(_args, context) {
      context.ui.setStatus("example-ui", "example active");
      context.ui.setHeader(() => new Text("Example extension header", 1, 0));
      context.ui.setWidget("example-ui", ["Example widget"], { placement: "aboveEditor" });
    },
  });
  rigyn.registerCommand("example-ui-overlay", {
    description: "Open a dismissible custom overlay",
    async handler(_args, context) {
      if (!context.hasUI) { context.ui.notify("This command requires the terminal UI.", "warning"); return; }
      await context.ui.custom((_tui, _theme, _keybindings, done) => new DismissibleOverlay(done), {
        overlay: true,
        overlayOptions: { width: 48, anchor: "center" },
      });
    },
  });
}
