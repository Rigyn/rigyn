export default function activate(rigyn) {
  let stopInput;
  rigyn.onDispose(() => stopInput?.());

  rigyn.registerCommand("example-terminal-workbench", {
    description: "Exercise terminal input, editor text, themes, and tool expansion",
    async handler(args, context) {
      if (!context.hasUI) { context.ui.notify("This command requires the terminal UI.", "warning"); return; }
      stopInput?.();
      stopInput = context.ui.onTerminalInput((data) => data === "\u001b\u0005" ? { consume: true } : { data });

      const before = context.ui.getEditorText();
      context.ui.setEditorText(before);
      context.ui.pasteToEditor("workbench");
      await context.ui.editor("Edit workbench text", context.ui.getEditorText());

      const requested = args.trim();
      const themes = context.ui.getAllThemes();
      if (requested !== "" && context.ui.getTheme(requested) !== undefined) context.ui.setTheme(requested);
      context.ui.setToolsExpanded(!context.ui.getToolsExpanded());
      context.ui.notify(JSON.stringify({ themes: themes.map((theme) => theme.name), editorFactory: typeof context.ui.getEditorComponent() }), "info");
    },
  });
}
