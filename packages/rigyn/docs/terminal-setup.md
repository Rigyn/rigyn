# Terminal setup

rigyn needs a terminal that preserves streaming output, resize events, ordinary UTF-8 text, and the key sequences you plan to use. Color, Unicode glyphs, clipboard images, and inline images are optional capabilities with fallbacks.

## Baseline checks

```sh
node -p "process.version + ' ' + process.platform + ' ' + process.arch"
printf '%s\n' "$TERM" "$COLORTERM"
rigyn --version
rigyn --help
```

Start once outside a multiplexer before debugging tmux, SSH, or IDE-terminal behavior. Run `/hotkeys` to see active bindings and `/settings` to select presentation options.

## Linux and SSH

Use a UTF-8 locale and a terminal description installed on the remote host. When `$TERM` names a terminal unknown to that host, select a compatible description such as `xterm-256color`. A headless session may lack Secret Service, clipboard helpers, and a browser; copy OAuth URLs manually or use a provider-supported device flow. Keep local credential and session directories private.

## macOS

Launch rigyn from the same desktop user session as the browser and terminal when using browser OAuth, Keychain, or clipboard integration. iTerm-compatible image display is detected separately from basic text operation. If a shortcut is captured by a global macOS binding, change the terminal mapping rather than expecting the application to receive it.

## Windows

Windows Terminal with a ConPTY-compatible shell gives the most reliable resize, Unicode, and streaming behavior. Use native Windows paths. Run the managed launcher from PowerShell as `& "$HOME\.rigyn\bin\rigyn.cmd"`. Git Bash may provide the command shell, but package and editor commands still resolve to native executables rather than implicit `.cmd` shell expansion.

## WSL and Termux

Install and run the Linux build inside WSL; do not share a Windows `node_modules` tree. Store active sessions on a filesystem with normal append and rename semantics. Termux is best effort and needs its own Node.js and native build packages. Clipboard support depends on the platform helper being installed.

## tmux

Use a current tmux release and enable enhanced input and color negotiation:

```text
set -g focus-events on
set -g extended-keys on
set -as terminal-features ',*:RGB'
```

Restart the tmux server after changing these options. If a chord fails only inside tmux, inspect tmux bindings and choose a chord it forwards. Inline image passthrough is terminal-specific; text markers remain usable when passthrough is unavailable.

See [Installation](install.md), [platform notes](platforms.md), and [keybindings](keybindings.md) for deeper troubleshooting.
