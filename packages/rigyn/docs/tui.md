# Terminal UI

Rigyn uses an inline transcript, a word-wrapped composer, and a compact footer for workspace, session, model, reasoning, token, cache, cost, and context telemetry. Narrow terminals wrap content vertically. Completed output remains in scrollback unless `RIGYN_ALT_SCREEN=1` is selected.

The interactive mode is selected automatically for a raw TTY. `RIGYN_TUI_MODE=full`, `classic`, or `accessible` requests a mode explicitly; `RIGYN_ACCESSIBLE=1` is the accessibility shortcut and `RIGYN_ASCII=1` selects ASCII glyphs. Accessible mode emits no cursor-control sequences.

Presentation settings live in `settings.json`; `/reload` applies active settings without restarting. `/hotkeys` reports the active key map, including user overrides.

## Direct extension UI

UI is exposed on event, tool, command, and shortcut callback contexts as `context.ui`. The activation-time `ExtensionAPI` has no global UI namespace. Check `context.hasUI` before requiring interaction because print, JSON, and embedding hosts do not emulate a terminal component.

The context supports:

- `notify`, status, title, working-message, and working-indicator updates;
- text or component widgets above or below the editor;
- complete header and footer component factories;
- select, confirm, input, and external-editor dialogs;
- editor text read/write and paste;
- decoded terminal-input observation;
- autocomplete wrapping and complete editor replacement;
- resolved theme inspection, source-path discovery, and interactive theme selection;
- completed-tool expansion inspection and override;
- `custom` components and overlays.

UI registrations are generation-owned. Failed activation, reload, host reset, and shutdown restore the nearest surviving owner and dispose stale components. An extension-owned timer, watcher, socket, or other resource still needs `rigyn.onDispose`.

See [`ui-surfaces`](../examples/ui-surfaces/README.md) for widgets and overlays and [`raw-editor-ui`](../examples/raw-editor-ui/README.md) for editor replacement.

## Components

Trusted packages import components and types from `rigyn/tui`:

```js
import { Text } from "rigyn/tui";

rigyn.registerCommand("status-panel", {
  async handler(_args, context) {
    context.ui.setHeader(() => new Text("Build ready", 1, 0));
    context.ui.setWidget("build", ["No pending work"], { placement: "aboveEditor" });
  },
});
```

`context.ui.custom(factory, options)` receives the live TUI, resolved theme, active keybindings, and a `done(result)` callback. The factory returns a `Component` and may return a promise. Set `overlay: true` for an overlay and provide bounded `overlayOptions` when positioning or sizing it.

A component must render deterministically and quickly. It may implement input handling and `dispose()`. Perform I/O outside rendering, invalidate only after state changes, and release component-owned work on disposal. The host owns terminal teardown, resize, focus transfer, and final screen restoration.

## Editor and autocomplete

`context.ui.addAutocompleteProvider(factory)` wraps the current autocomplete provider for the active generation. Validate and bound completions, preserve existing behavior unless replacement is intentional, and stop asynchronous work when the generation signal aborts.

`context.ui.setEditorComponent(factory)` replaces the complete editor. The factory receives the live TUI, editor theme, and keybinding manager. A replacement must preserve submission, cancellation, paste, resize, focus, accessibility, and host keybindings. Passing `undefined` restores the previous owner.

`context.ui.onTerminalInput(handler)` can consume or rewrite terminal input before normal editing. It is a high-authority trusted hook: do not record secret input, do not trap exit/cancel behavior, and keep transformations bounded.

## Themes

`context.ui.theme` is the current resolved theme. `getAllThemes`, `getTheme`, and `setTheme` operate on validated theme objects, and discovered package themes include their source path. A successful selection in the interactive host updates the live renderer and the user's theme setting; headless hosts cannot persist a terminal selection. Terminal-control data in theme values is rejected by the theme loader.

The explicitly trusted direct TUI is the public TUI runtime backed by the active host renderer. Its dimensions, enhanced-keyboard state, color-scheme notifications and queries, background-color query, redraw count, cursor preference, and clear-on-shrink preference reflect live host state. `start()` and `stop()` pause only the extension generation's components and input listeners; they never take ownership of the process terminal. Forced redraws, input draining, and raw terminal callbacks use the existing controller and expire with the extension generation.

## Tool and session rendering

Tool rendering is declared with the tool itself:

```js
rigyn.registerTool({
  name: "example",
  label: "Example",
  description: "Return a value",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute() {
    return { content: [{ type: "text", text: "ready" }], details: {} };
  },
  renderCall(_args, _theme, renderer) {
    return new Text(renderer.isPartial ? "Example…" : "Example", 0, 0);
  },
  renderResult(result) {
    return new Text(result.content[0]?.type === "text" ? result.content[0].text : "ready", 0, 0);
  },
});
```

Renderers supplement rather than replace model-visible observations. Always return useful bounded text/image content from the tool. Missing, expired, or failing renderers fall back to the native presentation.

`registerMessageRenderer(customType, renderer)` and `registerEntryRenderer(customType, renderer)` render custom messages and append-only custom session entries. Live appends and resumed history use the same JSONL entries, stable entry IDs, and branch order. `display: false` messages never enter the transcript. The host resolves the active renderer generation on every redraw, including after reload, theme changes, and terminal resize. Missing, expired, invalid, or throwing renderers fall back to bounded terminal-safe text; renderer-only details and custom-entry data are not copied into that fallback. Transcript presentation retains at most 2,000 entries and 2 MiB.

A renderer must be a pure projection of the stored value and supplied theme so resumed sessions do not depend on lost in-memory state. Test both live append and resume, narrow and wide Unicode layouts, reload, hidden messages, and a deliberate render exception.

## Headless behavior

Notifications and simple state can be projected by supported non-TUI hosts, but custom terminal components require an interactive TUI. A command that fundamentally requires a dialog or overlay should report that requirement and stop safely when `context.hasUI` is false. Model-controlled input is never user approval; destructive actions require an actual confirmation interaction.

## Lifecycle checklist

1. Propagate callback and generation cancellation.
2. Never retain a UI context, component, or API object after reload.
3. Keep rendered data bounded and terminal-safe.
4. Make component cleanup idempotent.
5. Test narrow/wide resize, Unicode, cancellation, reload, and a render exception.
6. Test a safe headless result for every interactive command.

From the repository root, run the source example with `rigyn --extension ./packages/rigyn/examples/ui-surfaces/extensions/index.mjs`, then exercise its commands in a real PTY. Distributable packages should also test the exact packed and installed artifact.
