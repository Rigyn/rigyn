# Themes

rigyn ships exactly two terminal themes:

- `mono` is the default black, white, and grayscale theme.
- `signal` is an operational 256-color theme. It distinguishes active reasoning and tools, success, failure, warnings, diffs, selections, messages, and status chrome.

Color augments the existing state labels, glyphs, borders, and tool status text; it is never the only state cue. Both themes retain those cues when color or Unicode is unavailable. Discovered user and trusted-project custom themes remain supported and can be selected through `/settings` or the terminal UI API.

## Semantic-token format

The recommended schema-v1 contract uses `colors` and exposes every semantic token consumed by the runtime:

- Core and chrome: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, and `thinkingText`.
- Selection and messages: `selectedBg`, `userMessageBg`, `userMessageText`, `customMessageBg`, `customMessageText`, and `customMessageLabel`.
- Tools: `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, and `toolOutput`.
- Markdown: `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, and `mdListBullet`.
- Diffs: `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext`.
- Syntax: `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, and `syntaxPunctuation`.
- Modes and reasoning: `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax`, and `bashMode`.

Every `colors` token is required except `thinkingMax`, which inherits `thinkingXhigh` when omitted. A token value is a 256-color index from `0` through `255`, a six-digit `#RRGGBB` value, an empty foreground/background reset, or the bare name of an entry in `vars`. Variables may reference another variable by its bare name. The optional `export` object accepts `pageBg`, `cardBg`, and `infoBg`; omitted export colors inherit `userMessageBg`.

```json
{
  "$schema": "./resources/schemas/theme-v1.json",
  "schemaVersion": 1,
  "name": "reviewed-night",
  "base": "dark",
  "vars": {
    "active": 81,
    "positive": 114,
    "negative": 203,
    "panel": 236,
    "panelAlias": "panel"
  },
  "colors": {
    "accent": "active",
    "border": 241,
    "borderAccent": "active",
    "borderMuted": 241,
    "success": "positive",
    "error": "negative",
    "warning": 221,
    "muted": 245,
    "dim": 242,
    "text": 252,
    "thinkingText": 117,
    "selectedBg": 24,
    "userMessageBg": "panelAlias",
    "userMessageText": 255,
    "customMessageBg": 235,
    "customMessageText": 252,
    "customMessageLabel": 177,
    "toolPendingBg": 235,
    "toolSuccessBg": 22,
    "toolErrorBg": 52,
    "toolTitle": "active",
    "toolOutput": 252,
    "mdHeading": 117,
    "mdLink": "active",
    "mdLinkUrl": 245,
    "mdCode": 215,
    "mdCodeBlock": 252,
    "mdCodeBlockBorder": 241,
    "mdQuote": 250,
    "mdQuoteBorder": 75,
    "mdHr": 241,
    "mdListBullet": "active",
    "toolDiffAdded": "positive",
    "toolDiffRemoved": "negative",
    "toolDiffContext": 245,
    "syntaxComment": 245,
    "syntaxKeyword": "active",
    "syntaxFunction": 117,
    "syntaxVariable": 252,
    "syntaxString": "positive",
    "syntaxNumber": 221,
    "syntaxType": 177,
    "syntaxOperator": 215,
    "syntaxPunctuation": 245,
    "thinkingOff": 242,
    "thinkingMinimal": 117,
    "thinkingLow": "active",
    "thinkingMedium": 75,
    "thinkingHigh": 221,
    "thinkingXhigh": 213,
    "thinkingMax": "negative",
    "bashMode": 177
  },
  "export": {
    "pageBg": 233,
    "cardBg": "panel",
    "infoBg": 235
  }
}
```

`schemaVersion` may be omitted for a token-shaped theme, but declaring version `1` is recommended. `base` may be `dark` or `light` and defaults to `dark`; it supplies inherited role styling around the complete token palette.

## Role-based compatibility format

The older `styles` form remains supported. It requires `schemaVersion: 1` and at least one role. Roles are `title`, `muted`, `accent`, `info`, `link`, `code`, `border`, `editor`, `editorActive`, `working`, `user`, `assistant`, `success`, `warning`, `error`, `selection`, `userMessage`, `toolPending`, `toolRunning`, `toolSuccess`, and `toolError`. Each role may set `foreground`, `background`, `bold`, and `italic`; unspecified roles inherit from `base`.

```json
{
  "$schema": "./resources/schemas/theme-v1.json",
  "schemaVersion": 1,
  "name": "reviewed-legacy",
  "base": "dark",
  "vars": {
    "primary": "#8AB4F8",
    "subtle": 245
  },
  "styles": {
    "accent": { "foreground": "$primary", "bold": true },
    "muted": { "foreground": "$subtle" },
    "selection": { "background": "#263247" },
    "error": { "foreground": "#FF7B72", "bold": true }
  }
}
```

Role-based variables use `$name` references, unlike the bare aliases in the semantic-token format.

## Naming, loading, and selection

Names use lowercase letters followed by lowercase letters, digits, dots, underscores, or hyphens. `dark` and `light` are retired compatibility aliases, and `mono` and `signal` are built-ins; all four names are reserved from custom themes.

Place custom themes in user or trusted-project resource directories, declare them in a package, return `themePaths` from `resources_discover`, or pass `--theme FILE_OR_DIRECTORY`. `--no-themes` disables automatic custom-theme discovery. The built-in theme list contains `mono` and `signal`; validated custom names are added without replacing either built-in.

The `theme` setting may name a built-in or discovered custom theme. A `LIGHT/DARK` pair may select two themes according to terminal color-scheme detection. Use 256-color indexes for predictable remote-terminal behavior and RGB values for richer local terminals. Rendering falls back according to detected color capability. Review foreground/background contrast and preserve textual or structural cues for every state.
