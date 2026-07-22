# Themes

Rigyn ships one built-in terminal theme: `mono`. It is the active default and uses only black, white, and grayscale terminal colors. Discovered user and trusted-project custom themes remain supported and can be selected through `/settings` or the terminal UI API.

## Custom theme format

```json
{
  "$schema": "./resources/schemas/theme-v1.json",
  "schemaVersion": 1,
  "name": "reviewed-night",
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

`schemaVersion` is `1`. Names use lowercase letters followed by lowercase letters, digits, dots, underscores, or hyphens; `dark`, `light`, and `mono` are reserved and cannot be custom-theme names. `base` may be `dark` or `light` (default `dark`); it selects the inheritance base for unspecified custom roles and does not expose another bundled theme. Variables hold a 256-color index, a six-digit RGB value, another variable reference, or an empty foreground reset.

Style roles include text and chrome (`title`, `muted`, `accent`, `border`, `editor`), conversation roles (`user`, `assistant`, `userMessage`), status roles (`working`, `success`, `warning`, `error`), and tool states (`toolPending`, `toolRunning`, `toolSuccess`, `toolError`). A style can set foreground, background, bold, and italic where supported.

## Loading and selection

Place custom themes in user or trusted-project resource directories, declare them in a package, return `themePaths` from `resources_discover`, or pass `--theme FILE_OR_DIRECTORY`. `--no-themes` disables automatic custom-theme discovery. The built-in theme list contains only `mono`; discovered custom names are added to that list.

The `theme` setting may name `mono` or a discovered custom theme. A `LIGHT/DARK` pair may select two custom themes according to terminal color-scheme detection; it does not add another bundled palette. Use 256-color indexes for predictable remote-terminal behavior and RGB values for richer local terminals. Rendering falls back according to detected color capability; never encode meaning by color alone.
