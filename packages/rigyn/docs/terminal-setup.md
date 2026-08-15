# Terminal setup

rigyn needs ordinary UTF-8 text, streaming writes, resize events, and whatever
key sequences the configured bindings use. Color, Unicode presentation,
hyperlinks, clipboard images, and inline images are optional and have text
fallbacks.

## Terminal selection

The rich viewport requires both stdin and stdout to be TTYs and stdin to support raw
mode. A real raw PTY is accepted even if a parent left `TERM=dumb`. Without
those capabilities, rigyn automatically uses bounded line output.

Process-level overrides:

| Variable | Effect |
| --- | --- |
| `RIGYN_ACCESSIBLE=1` | Emit control-sequence-free accessibility output. |
| `RIGYN_ASCII=1` | Disable Unicode presentation glyphs. |
| `TERM_COLOR=0` | Disable full-TUI color. |
| `RIGYN_HARDWARE_CURSOR=0` | Hide the positioned cursor when `showHardwareCursor` is omitted. |
| `RIGYN_CLEAR_ON_SHRINK=1` | Clear stale rows when the terminal becomes smaller. |
| `RIGYN_DEBUG_REDRAW=1` | Record bounded renderer geometry without transcript text. |
| `RIGYN_SYNC_UPDATE=0` | Disable synchronized terminal updates. |

Terminal dimensions fall back to 80 by 24 when unavailable and are capped at
500 columns by 200 rows for rendering. A locale containing `UTF-8` or `UTF8`
enables Unicode; an unspecified locale is treated as capable. Use
`RIGYN_ASCII=1` when that guess is wrong.

Baseline probes:

```sh
node -p "process.version + ' ' + process.platform + ' ' + process.arch"
printf '%s\n' "$TERM" "$TERM_PROGRAM" "$COLORTERM" "$LANG"
rigyn --version
rigyn --help
```

Run `/hotkeys` to inspect the bindings the application actually received and
`/settings` to inspect common interactive preferences. Less common terminal controls remain in `config.json`.

## Emulator capabilities

Inline images and hyperlinks are detected separately:

| Environment | Inline image protocol | OSC 8 hyperlinks |
| --- | --- | --- |
| Kitty, Ghostty, WezTerm, Warp | Kitty graphics | yes |
| iTerm2 | iTerm2 inline images | yes |
| Windows Terminal, VS Code, Alacritty | none | yes |
| tmux | none | only when tmux reports `hyperlinks` in `client_termfeatures` |
| GNU Screen | none | no |
| JetBrains/JediTerm | none | no |
| Unknown terminal | none | no |

rigyn does not currently emit Sixel. Unsupported image protocols retain a
bounded caption without printing an image URL or raw payload. Inside tmux,
image rendering is disabled even if the outer terminal has a supported
passthrough mechanism.

Bracketed paste is enabled in the rich viewport. Large pastes are represented by a
marker while editing and expanded only at submission, so their payload is not
echoed into every frame. Clipboard image paste uses fixed-argument helper
processes with bounded output rather than a shell.

## Linux and SSH

Use a UTF-8 locale and install the terminal description named by `$TERM` on the
remote host. If the remote machine does not have the outer terminal's terminfo,
choose a description it knows, commonly `xterm-256color`.

Test first with a direct local PTY, then SSH without a multiplexer, then add
tmux or an IDE terminal. A headless SSH session may not have a browser,
Wayland/X11 clipboard, or desktop URL opener. Copy an OAuth URL manually or use
an explicit device flow when the provider supports it.

Wayland clipboard images require `wl-paste`. X11 uses `xclip`. Missing helpers
do not stop text operation.

## macOS

Run the terminal, browser, and rigyn under the same desktop user when relying
on browser OAuth or clipboard access. macOS image paste uses `osascript` and a
private temporary file. iTerm2 inline images are detected independently from
clipboard support.

If a chord is captured by macOS or the terminal profile, remap it in the
terminal or change the rigyn keybinding. The application cannot act on a
sequence it never receives.

## Windows and WSL

Windows Terminal with a ConPTY-compatible shell is the most predictable native
environment for raw input, resize, Unicode, and streaming. Invoke the managed
launcher from PowerShell with:

```powershell
& "$HOME\.rigyn\bin\rigyn.cmd"
```

The shell tool still requires Bash. Git for Windows, MSYS2, or another
configured `bash.exe` can provide it. Executable lookup remains Windows-native;
do not assume a package name will acquire `.cmd` expansion inside every child
path.

Run the Linux build inside WSL. Do not share a Windows `node_modules` tree,
native image module, or standalone runtime with WSL. Keep active sessions and
repositories on a filesystem with reliable append, rename, and permission
semantics. Browser launch and clipboard behavior depend on the distribution's
desktop integration.

## tmux

Use a current tmux and configure enhanced input and RGB negotiation:

```text
set -g focus-events on
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features ',*:RGB'
```

Restart the tmux server, not only one window, after changing capabilities.
Check what the active client reports:

```sh
tmux display-message -p '#{client_termname}'
tmux display-message -p '#{client_termfeatures}'
tmux list-keys
```

If a chord works outside tmux but not inside, inspect prefix and global
bindings, then select a sequence tmux forwards. rigyn probes
`client_termfeatures` for hyperlink support with a 250 ms bound. It does not
attempt terminal image passthrough in tmux.

## Termux

Termux is best effort and is not a standalone release target. Android cannot
load a desktop Linux archive or its native dependencies. Use Termux packages
and build the source with a supported Node.js:

```sh
pkg update
pkg install nodejs-lts python clang make pkg-config ripgrep
node --version
```

The reported Node version must satisfy the repository's current `engines`
field. Native image preprocessing also requires a Termux-compatible `sharp`
and libvips build; if that module cannot install and load, normal CLI startup
is not supported.

Clipboard image paste uses `termux-clipboard-get`. Install the Termux API
package and the matching Android Termux:API companion application if that
feature is needed:

```sh
pkg install termux-api
command -v termux-clipboard-get
```

The helper must return binary image bytes. Text-only clipboard output is
reported as unsupported. Inline image protocol detection is terminal-dependent
and normally falls back to captions on Android.

## TUI fault isolation

When rendering, refresh, or input looks wrong, change one boundary at a time:

1. Reproduce outside tmux, SSH, and the IDE terminal.
2. Run `RIGYN_ACCESSIBLE=1 rigyn` to verify application behavior without
   rich terminal control sequences.
3. Disable synchronized updates with `RIGYN_SYNC_UPDATE=0`.
4. Force plain glyphs and color with
   `RIGYN_ASCII=1 TERM_COLOR=0`.
5. Compare `/hotkeys` with the bytes or mapping reported by the terminal and
   multiplexer.
6. Set `RIGYN_DEBUG_REDRAW=1` to record redraw reasons in
   `~/.rigyn/logs/rigyn-debug.log` without recording transcript rows.

Redirecting either side of an interactive run can remove TTY capabilities and
select bounded line output. Use print/JSON mode for pipelines instead of treating
that automatic fallback as a renderer failure.

The rich viewport restores raw mode, bracketed paste, cursor visibility, semantic
zones, and its active screen on normal close, handled signals, and stream
errors. If a process was terminated without cleanup and the shell remains
visually corrupted, use the terminal's reset command before starting another
debug run.

See [Installation](install.md), [platform notes](platforms.md),
[keybindings](keybindings.md), and [Terminal UI](tui.md).
