# Themes

Themes are declarative JSON resources for terminal presentation. They do not execute code. Select a discovered theme through `/settings`; extensions can inspect and change the active theme through the terminal UI API.

## Minimal theme

```json
{
  "$schema": "./resources/schemas/theme-v1.json",
  "schemaVersion": 1,
  "name": "quiet-night",
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

`schemaVersion` is `1`. Names use lowercase letters followed by lowercase letters, digits, dots, underscores, or hyphens. `base` is `dark` or `light`; unspecified roles inherit from that base. Variables hold a 256-color index, a six-digit RGB value, another variable reference, or an empty foreground reset.

Style roles include text and chrome (`title`, `muted`, `accent`, `border`, `editor`), conversation roles (`user`, `assistant`, `userMessage`), status roles (`working`, `success`, `warning`, `error`), and tool states (`toolPending`, `toolRunning`, `toolSuccess`, `toolError`). A style can set foreground, background, bold, and italic where supported.

## Loading and portability

Place user or trusted project themes in their normal resource directories, declare them in a package, return `themePaths` from `resources_discover`, or pass `--theme FILE_OR_DIRECTORY`. `--no-themes` disables automatic theme discovery.

Use 256-color indexes for predictable remote-terminal behavior and RGB values for richer local terminals. Rendering falls back according to detected color capability; never encode meaning by color alone. Test the theme with long tool output, warnings, selections, Markdown, and a terminal with Unicode disabled.
