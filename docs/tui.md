# Terminal UI

Rigyn keeps the released inline workbench geometry: transcript first, a word-wrapped composer between two horizontal rules, and a compact footer for workspace, session, model, reasoning, token, cache, cost, and context telemetry. User messages use the existing full-width row with a small `You ›` label. Model, session, tree, and settings pickers remain compact and bottom-anchored in the transcript region, use a bracketed title and a compact selection marker, and return to the unchanged draft when closed. Narrow terminals wrap reasoning summaries and picker help downward instead of extending content off-screen.

The interactive mode is selected automatically for a raw TTY. Set `RIGYN_TUI_MODE=full`, `classic`, or `accessible` to request a mode explicitly; `RIGYN_ACCESSIBLE=1` is the accessibility shortcut. Accessible mode emits no cursor-control sequences. Set `RIGYN_ASCII=1` for ASCII glyphs. The full interface stays inline by default so completed output remains in terminal scrollback; `RIGYN_ALT_SCREEN=1` opts into an alternate screen.

Picker help is generated from the active key map rather than fixed default keys. Run `/hotkeys` to inspect the complete current map and edit `~/.config/rigyn/keybindings.json` (or the equivalent XDG configuration path) to remap it. Command decks show the most relevant actions; `/hotkeys` remains the complete reference.

## Extension TUI

Rigyn exposes a bounded structural UI to runtime extensions. Extensions describe lines, semantic roles, focus behavior, and key handling; the host owns terminal escape sequences, screen restoration, resizing, and input decoding.

This is the supported extension surface. The internal `TuiController` and live-surface renderer are implementation details and may change without becoming a separate UI SDK.

The native transcript presents each tool inside the released horizontal separators with a narrow transparent status rail. The header carries the operation, target, lifecycle state, and decisive metadata without a background slab or duplicated call/result label. Running tools keep a small recent live tail so streaming output cannot take over the screen. After completion, Rigyn displays all canonical output retained by the tool layer by default, including complete stored reads, searches, shell output, and edit diffs; no expansion shortcut is required. Canonical output is bounded before presentation to 2,000 lines and 50 KiB. When shell output exceeds that bound, the result states what was retained and includes the full-output path when one exists. Structured live progress distinguishes stdout, stderr, partial errors, and truncation. Provider reasoning summaries wrap independently down the terminal instead of growing sideways. A registered tool renderer replaces the call or result slots it returns; missing, invalid, expired, or failed slots use the native host presentation.

The focused runnable example is [`examples/custom-overlay.mjs`](../examples/custom-overlay.mjs).

## Where UI is available

Runtime command and shortcut contexts expose `context.ui`. Top-level `api.ui` can establish generation-owned notices, status text, widgets, keyed headers and footers, working-message/indicator visibility, and a terminal title during activation.

`context.ui.getTheme()` returns the selected theme and bounded available names. `context.ui.setTheme(name)` changes only the live host selection; it does not silently rewrite user configuration. Both are interactive operations: TUI and negotiated RPC hosts implement them, while print, JSON, and embedding hosts reject them.

`setHeader(key, text)` and `setFooter(key, text)` pin bounded, terminal-safe text outside the scrolling transcript. Reusing a key replaces that extension-owned region; passing `undefined` clears it. On very small terminals the host caps chrome lines so the editor and at least one content row remain usable.

Custom components require the full interactive TUI. Text, JSON, print, and RPC modes do not emulate an interactive component. RPC supports correlated dialogs, working state, editor text, and theme selection, but explicitly rejects terminal-only custom components. Use ordinary notifications or structural session entries when a workflow must also work over RPC.

## Autocomplete and editor behavior

`api.ui.registerAutocompleteProvider(provider)` adds one provider to the host's deterministic provider chain. On Tab, each provider receives a frozen `{ text, cursor }` snapshot and an abort signal. Cursor and completion ranges are grapheme indexes. Results contain `{ start, end, value, label?, detail? }`; the host deduplicates them, caps the combined list at 256, rejects malformed or oversized items, and applies a choice only if the editor snapshot is unchanged. Reload aborts pending providers before their late results can mutate input.

`api.ui.registerEditorMiddleware(middleware)` composes synchronous structural editor behavior. Middleware receives a normalized key event, a frozen `{ text, cursor }` snapshot, and its generation signal. It returns `{ action: "pass" }`, `{ action: "handled" }`, or `{ action: "replace", text, cursor? }`. Replacements are terminal-safe, bounded by the editor limit, and flow through later middleware in extension order. Interrupt, exit, suspend, model/session commands, overlays, and capturing components stay host-owned and never enter middleware.

`api.registerEditorRenderer(renderer)` replaces only the bounded visual editor block. `render(view, context)` receives the host-owned text, grapheme cursor, label, input mode, blocked state, dimensions, and semantic theme. It returns structural lines/spans plus a required display-cell cursor. Renderers are consulted in reverse extension load order: the most recently loaded active renderer gets the first opportunity, returning `undefined` falls through to earlier renderers, and exhausting the chain uses the native editor. Rigyn validates and sanitizes each returned block, rejects ANSI/control data and invalid geometry, falls back to the native editor on failure, and removes the renderer with its extension generation. The renderer cannot handle keys, change the draft, submit input, or access terminal streams.

The runnable [`input-assist`](../examples/input-assist/README.md) example demonstrates both contracts.

## Structural blocks

A render function returns a block:

```js
{
  lines: [
    {
      spans: [
        { text: "Build", role: "title" },
        { text: " · ready", role: "success" }
      ],
      fill: true
    }
  ],
  cursor: { row: 0, column: 5 }
}
```

Each line contains spans. A span has text and an optional semantic role. Supported roles are `title`, `muted`, `accent`, `info`, `link`, `code`, `border`, `editor`, `editorActive`, `working`, `user`, `assistant`, `success`, `warning`, `error`, `selection`, `userMessage`, `toolPending`, `toolRunning`, `toolSuccess`, and `toolError`.

Extensions never supply trusted ANSI. The host strips control sequences, applies the active theme, clips each line to the provided cell width, and validates the cursor. Width and cursor columns are terminal cells, not UTF-16 indexes: a wide CJK character or emoji may occupy two cells.

Blocks are bounded to protect the render loop. The default limits are 128 lines, 256 KiB of source text, and 256 spans per line. Render only the visible state; keep large data in the extension and summarize it for the component.

`fill: true` paints the remaining row with the first span's role. Omit it for a transparent structural line.

## Semantic component kit

Extension packages can import four render-only builders from `rigyn/tui`:

```js
import { uiMarkdown, uiPanel, uiStack, uiText } from "rigyn/tui";

const view = uiPanel(uiStack([
  uiText("Build ready", { role: "success" }),
  uiMarkdown("Press **Enter** to continue", { role: "muted" }),
]), { title: "Status" });

await context.ui.custom(() => view, { overlay: true });
```

- `uiText(text, options)` creates wrapped or clipped semantic text lines.
- `uiStack(children, options)` vertically composes views with an optional bounded gap.
- `uiPanel(child, options)` adds a compact semantic border, title, and zero or one cell of padding. It follows the host's Unicode capability and falls back to ASCII borders.
- `uiMarkdown(markdown, options)` uses the same bounded Markdown parser and semantic highlighting as the transcript.

Each builder returns a `RuntimeUiView`, which is a render-only subset of `RuntimeUiComponent`. Return it directly from `ui.custom` or `ui.showOverlay`, call its `render(context)` from a tool/session renderer, or wrap it in a parent component that owns `handleKey` and other lifecycle hooks. Nested views do not receive host handles and cannot independently claim focus or outlive the parent generation. A stack propagates at most the first child cursor, and every kit view drops its cursor while the host says it is unfocused.

The kit applies the existing control stripping, semantic-role validation, grapheme cell-width logic, clipping, and structural sanitizer. Source text is capped at 256 KiB, output at 128 lines and 256 spans per line, and render width at the host's 500-cell maximum. A lower `maxLines` or render-context height clips earlier and leaves a visible `…` row when content was omitted. Options and output are deterministic; unsupported keys, roles, padding, or unbounded child output fail validation instead of exposing a raw-terminal escape hatch.

## Component contract

`ui.custom(factory, options, signal)` mounts one component and resolves when it closes. The factory receives a host and returns:

```js
{
  render(context) {},
  handleKey(event) {},
  invalidate() {},
  dispose() {}
}
```

- `render(context)` is required. Treat it as a pure projection of current component state.
- `handleKey(event)` is optional. Return `true` only when the key was consumed.
- `invalidate()` is called when host state invalidates the component.
- `dispose()` releases timers, listeners, and other resources exactly once.

The render context contains:

- `width` and `height`, the component's current cell bounds;
- `focused`, whether it owns input;
- `expanded`, the host's current expansion state;
- `theme.name`, `theme.color`, and `theme.unicode` capability hints.

The component host contains:

- `signal`, aborted when the component closes or its extension generation ends;
- `requestRender()`, used after component-owned state changes;
- `close(value)`, which disposes the component and resolves `ui.custom` with `value`.

Do not render in a timer directly. Change state and call `requestRender()`. Register cleanup with `host.signal` or `dispose()`.

## Keys and focus

Key events are normalized data:

```js
{
  key: "text",
  text: "x",
  ctrl: false,
  alt: false,
  shift: false
}
```

Named keys include `escape`, `enter`, `newline` (Ctrl+J), arrows, page keys, and editing keys. Text input uses `key: "text"` with `text`. A component should return `false` for keys it does not own so the host can route them normally.

Only one capturing component is focused at a time. Focusing an overlay raises it above its siblings. A non-capturing overlay can remain visible without intercepting editor input.

## Inline components and overlays

Without `overlay: true`, `ui.custom` owns the runtime component area in the normal layout. With `overlay: true`, it composes over the current frame:

```js
const result = await ui.custom(factory, {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: 44,
    maxHeight: 10,
    margin: 1
  }
});
```

Overlay anchors are the nine combinations of top/center/bottom and left/center/right. `width`, `maxHeight`, `row`, and `col` accept positive cell counts or percentages such as `"60%"`. `minWidth`, margins, and offsets use cells. A `visible(terminalWidth, terminalHeight)` predicate can hide a layout that does not fit.

`overlayOptions` may be a function when the mount needs one initial dynamic calculation. The resolved options remain stable for that mount; responsive rendering belongs in `render(context)` and `visible`.

`ui.showOverlay(factory, options, signal)` is the non-blocking form. It returns a handle immediately:

```js
const handle = ui.showOverlay(factory, {
  overlayOptions: { anchor: "top-right", width: 28, nonCapturing: true }
});

handle.focus();
handle.unfocus();
handle.hide();
await handle.result;
```

The handle operations have distinct meanings:

- `setHidden(true)` removes the overlay from layout but keeps it mounted; `setHidden(false)` shows it again;
- `hide()` is a deprecated permanent alias for `close()` and remains available for compatibility;
- `focus()` gives it input and raises it;
- `unfocus()` transfers input to the next eligible surface; pass `{ target: null }` to return input to the editor;
- `close()` ends the mount, runs `dispose()`, and settles `result`.

Calling operations on a closed handle is safe and has no effect.

## Tool and session renderers

`api.registerToolRenderer(name, renderer)` structurally renders a custom tool call and result. Renderers receive validated call/result state plus the same render context. Return `undefined` to use the native host fallback for that slot. A tool can publish a replaceable result with `context.reportProgress({ type: "result", content, isError, metadata? })`; `renderResult` then receives `view.isPartial === true`. The terminal result arrives through the same renderer with `isPartial` absent or false. Render both states from the supplied view and do not retain the partial view as independent state.

`api.session.registerRenderers(schemaVersion, renderers)` gives durable extension state and messages a stable representation after resume. A renderer must depend only on the stored event and render context; do not depend on in-memory activation state that will be absent after restart.

All renderer output passes through the same text, width, role, cursor, byte, and line validation as custom components. A renderer failure is isolated and falls back to the host presentation.

## Lifecycle rules

Components, overlays, shortcuts, renderers, status, widgets, headers, footers, and titles belong to one extension generation. `/reload` stages a new generation, commits it atomically, then aborts and disposes the old generation. A failed candidate leaves the old UI active.

Autocomplete providers, editor middleware, working-state overrides, and theme-change listeners follow the same generation boundary. The `theme_change` lifecycle event contains `previous`, `current`, bounded `available`, and `reason` (`selection` or `catalog`). Updating the definition of the selected custom theme invalidates the live render and emits a catalog change even when its name stays the same.

Practical rules:

1. Stop asynchronous work when `host.signal` or the command signal aborts.
2. Make `dispose()` idempotent even though the host calls it once.
3. Do not retain a UI handle or API object after its generation ends.
4. Keep `render()` deterministic and fast; perform I/O outside it.
5. Use `requestRender()` only after state changes.
6. Use durable session state when UI must survive a restart.

## Focused example

Run the example from the Rigyn package root (source checkout or installed package):

```sh
rigyn --offline --extension ./examples/custom-overlay.mjs
```

Then enter `/overlay-demo`. The example mounts a passive status overlay and an interactive centered overlay, updates structural state on text keys, and closes cleanly on Enter or Escape.

## Testing checklist

Exercise a component in a real PTY as well as a unit test:

- narrow and wide terminal widths;
- resize while focused and hidden;
- Unicode and control-sequence input;
- Escape/cancellation and extension reload;
- focus transfer between two overlays;
- `nonCapturing` editor input;
- a render exception and structural-limit violation;
- session restart for durable renderers.

For a distributable package, keep its PTY tests with that package. The source repository additionally exercises deterministic fake terminals and real `script(1)` scenarios under `test/tui` and `test/cli`; those internal tests are not part of the published artifact.
