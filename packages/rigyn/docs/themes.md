# Themes

rigyn ships exactly two terminal themes:

- `signal` is the default operational 256-color theme. Copper-gold marks primary chrome, glacier blue marks live work, and compact lifecycle header bands distinguish pending, completed, and failed tools. Continuation rows stay neutral while a narrow state-colored rail preserves the outcome.
- `mono` is the black, white, and grayscale alternative. Its lifecycle bands use distinct gray levels and keep the same rails, glyphs, and labels without adding hue.

Color adds to state labels, glyphs, borders, and tool status text. It is never the only state cue. Both themes keep
those cues when color or Unicode is unavailable. You can select discovered user and trusted-project themes through
`/settings` or the terminal UI API.

## Semantic-token format

The recommended schema-v1 contract uses `colors` and exposes the complete token set available to Rigyn renderers and
extension-owned UI:

- Core and chrome: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, and `thinkingText`.
- Selection and messages: `selectedBg`, `userMessageBg`, `userMessageText`, `customMessageBg`, `customMessageText`, and `customMessageLabel`.
- Tools: `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, and `toolOutput`.
- Markdown: `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, and `mdListBullet`.
- Diffs: `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext`.
- Syntax: `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, and `syntaxPunctuation`.
- Modes and reasoning: `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax`, and `bashMode`.
- Viewport navigation: `scrollbarThumb`.

Every `colors` token is required except `thinkingMax` and `scrollbarThumb`. They inherit `thinkingXhigh` and `borderAccent` when omitted. A token value can
be a 256-color index from `0` through `255`, a six-digit `#RRGGBB` value, an empty foreground or background reset, or
the bare name of a `vars` entry. A variable may reference another variable by its bare name. The optional `export`
object accepts `pageBg`, `cardBg`, and `infoBg`. Omitted export colors inherit `userMessageBg`.

```json
{
  "$schema": "urn:rigyn:schema:theme:v1",
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

`schemaVersion` may be omitted for a token-shaped theme, but version `1` is recommended. `base` may be `dark` or
`light` and defaults to `dark`. It supplies inherited role styling around the token palette.

## Role-based compatibility format

The older `styles` form remains supported. It requires `schemaVersion: 1` and at least one role. Roles are `title`,
`muted`, `accent`, `info`, `link`, `code`, `border`, `editor`, `editorActive`, `working`, `user`, `assistant`,
`success`, `warning`, `error`, `selection`, `userMessage`, `toolPending`, `toolRunning`, `toolSuccess`, and
`toolError`, and `scrollbar`. Each role may set `foreground`, `background`, `bold`, and `italic`. Unspecified roles
inherit from `base`.

```json
{
  "$schema": "urn:rigyn:schema:theme:v1",
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

Names start with a lowercase letter. The remaining characters may be lowercase letters, digits, dots, underscores, or
hyphens. `dark` and `light` are retired compatibility aliases. `mono` and `signal` are built-ins. Custom themes
cannot use any of these four names.

Place custom themes in a user or trusted-project resource directory, declare them in a package, return `themePaths`
from `resources_discover`, or pass `--theme FILE_OR_DIRECTORY`. `--no-themes` disables automatic custom-theme
discovery. Valid custom names are added without replacing the built-in `mono` or `signal` themes. The runtime reads
at most 1 MiB from each theme file. Programmatic loose-resource loaders can set `maxFileBytes` from 1 byte through
16 MiB.

The `theme` setting may name a built-in or discovered custom theme. `/settings` edits this one value and does not show
duplicate light and dark rows. To use terminal color-scheme detection, set the same `theme` property to a
`LIGHT/DARK` pair in `config.json`. The pair remains visible as the current value in `/settings`, where selecting
one theme returns to fixed-theme mode. Use 256-color indexes for predictable remote-terminal behavior and RGB values
for richer local terminals. Rendering falls back to the detected color capability. Review foreground and background
contrast, and preserve text or structural cues for every state.
