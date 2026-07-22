# @rigyn/terminal

`@rigyn/terminal` is the raw-terminal interface used by Rigyn. It combines a cell-accurate differential renderer with keyboard decoding, multiline editing, overlays, ANSI-safe layout, terminal images, autocomplete, and reusable components.

The package writes directly to the active terminal. It does not require a screen framework or own application state outside the interval between `TUI.start()` and `TUI.stop()`.

## Start an application

```ts
import { Editor, ProcessTerminal, TUI, Text } from "@rigyn/terminal";

const terminal = new ProcessTerminal();
const app = new TUI(terminal);

app.addChild(new Text("Ready", 0, 0));

const editor = new Editor(app, {
  borderColor: (value) => value,
  selectList: {
    selectedPrefix: (value) => value,
    selectedText: (value) => value,
    description: (value) => value,
    scrollInfo: (value) => value,
    noMatch: (value) => value,
  },
});

editor.onSubmit = (value) => app.addChild(new Text(value, 0, 0));
app.addChild(editor);
app.setFocus(editor);
app.start();

process.once("SIGINT", () => app.stop());
```

`ProcessTerminal` enables raw input, bracketed paste, extended keyboard reporting when available, resize notifications, and terminal progress reporting. `stop()` restores every mode enabled by `start()`.

## Components and rendering

A component implements three operations:

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}
```

Each returned string is one physical terminal row. Non-image rows must remain within the supplied width in terminal cells. ANSI and OSC control sequences do not consume cells; CJK characters and emoji can consume more than one. Use `visibleWidth`, `sliceByColumn`, `truncateToWidth`, and `wrapTextWithAnsi` instead of string length or ordinary slicing.

The package includes:

- `Container`, `Box`, `Text`, `Spacer`, and `TruncatedText` for composition.
- `Editor` and `Input` for multiline and single-line editing.
- `SelectList` and `SettingsList` for interactive choices.
- `Markdown` for lists, tables, quotes, fenced code, links, and styled inline content.
- `Loader` and `CancellableLoader` for active work.
- `Image` for Kitty and iTerm2 image placement with a text fallback.

The renderer compares physical rows, redraws only affected regions, contains style and hyperlink state at row boundaries, and tracks terminal scrollback separately from logical content. Kitty image placements are deleted before changed reserved rows are redrawn.

## Input and keybindings

`StdinBuffer` separates batched input without splitting CSI, OSC, DCS, APC, extended-key, mouse, or bracketed-paste sequences. `parseKey` and `matchesKey` normalize legacy input, modifyOtherKeys, and extended keyboard events.

Application keybindings are managed through `KeybindingsManager`. User overrides are validated against `TUI_KEYBINDINGS`, and conflicting assignments are available through `getConflicts()`.

The editor supports Unicode grapheme movement, word navigation, history, undo, a kill ring, multiline paste markers, forced and trigger-driven autocomplete, viewport scrolling, and an IME-positioned hardware cursor.

## Overlays

```ts
const handle = app.showOverlay(component, {
  width: "60%",
  maxHeight: "70%",
  anchor: "center",
  margin: 1,
});

handle.setHidden(true);
handle.setHidden(false);
handle.focus();
handle.unfocus();
handle.hide();
```

Overlays support absolute or percentage sizing, nine anchors, offsets, margins, responsive visibility, and non-capturing presentation. Focus ownership survives temporary base controls and dynamic visibility without routing input to a hidden component. Permanently removing an overlay also repairs dependent focus ancestry.

## Terminal capabilities

Image, true-color, and hyperlink support is detected from the active terminal environment. Call `getCapabilities()` to inspect it. Tests and embedding hosts can use `setCapabilities()` and `resetCapabilitiesCache()` to provide a known capability set.

Terminal color-scheme notifications and background-color queries are exposed by `TUI`. Responses are consumed before ordinary input routing. Cell-size reports update image layout without swallowing unrelated keystrokes.

## Native release gate

The sources in `native/` provide two platform helpers:

- macOS modifier-state detection for terminal input that cannot encode Shift+Return directly.
- Windows virtual-terminal input activation after Node enters raw mode.

GitHub release artifacts for macOS and Windows must contain the matching x64 and arm64 N-API binary under `native/<platform>/prebuilds/<platform>-<arch>/`. The four required paths are declared in `native/targets.json`.

On a macOS or Windows release worker, `npm run native:build` compiles the helper for the worker's current architecture and `npm run native:verify` loads it and exercises its exported function. Linux still validates both sources and the complete four-target manifest, but cannot load another operating system's binary. The release workflow collects the four matching-runner outputs into one package tree, and `npm run native:verify -- --release` validates their presence and executable headers before staging. The staged archive verifier installs `@rigyn/terminal` and loads the matching packed helper again on macOS and Windows.

## Verification

```sh
npm run check
npm run native:build       # macOS or Windows release worker
npm run native:verify
npm run native:verify -- --release
```

`npm run check` performs strict declaration typechecking, builds the package, and runs the repository-owned semantic regression suite.
