# Platform notes

Rigyn requires Node.js 24.15 or a current Node.js 26-or-newer release. The source and packed-artifact checks run on Linux, macOS, and Windows. Release verification covers x64 and arm64, and macOS/Windows runners load the matching TUI helper from the installed archive.

## Linux

Source and portable runs can use Secret Service when `secret-tool` is executable and a functional user-session service answers a bounded probe. The required D-Bus and desktop-session environment is preserved without forwarding loader-injection variables. If the service is absent, interactive setup creates an encrypted fallback store with a private local key. Self-contained installs use that installation-local encrypted store by design. Clipboard images use available Wayland/X11/WSL/Termux helpers in bounded fallback order. Kitty and iTerm image protocols are detected separately from clipboard support.

If a desktop keyring is unavailable in SSH or a minimal container, keep the configuration and state directories private. Interactive use can create the local fallback, or a deliberately headless source runtime can receive a 32-byte hexadecimal or unpadded-base64url key through `RIGYN_CREDENTIAL_KEY`; do not put that value in project configuration or shell history. Project trust and workspace path boundaries are not process isolation.

## macOS

Source and portable runs can use the current user's Keychain through the system `security` command after a bounded functional probe. Self-contained installs use their installation-local encrypted store. The native clipboard and iTerm/Kitty-capable terminals are supported. If an external editor or browser login opens in the wrong desktop context, launch Rigyn from the same user session as the terminal.

## Windows

The encrypted fallback key is protected with DPAPI. Process cancellation uses Windows process-tree handling, and Git Bash discovery supplies a shell where available. Use native absolute paths in configuration; path validation rejects ambiguous device and alternate-data-stream forms at protected boundaries.

PowerShell, Windows Terminal, and Git Bash have different key and quoting behavior. Package-manager and external-editor commands must resolve to native executables (or an interpreter plus script path); `.cmd` and `.bat` wrappers are not passed through `cmd.exe`. Package-manager wrapper commands are JSON argv arrays, never shell strings.

## WSL

The harness runs as a Linux process and stores Linux-side state by default. Clipboard acquisition can call Windows helpers when detected. Keep live session JSONL files on a filesystem that provides ordinary append and rename semantics; avoid editing an active session file from the Windows side.

## Termux and remote terminals

Termux clipboard helpers are supported when installed. Remote terminals may not advertise image protocols or browser callbacks; device OAuth and text/image fallbacks remain available where the provider supports them. `tmux` and terminal multiplexers can consume key combinations before the TUI sees them, so use `/hotkeys` and adjust the terminal or harness keybinding map when necessary.

## Containers and remote execution

Running the entire process in a reviewed container is an operating-system boundary. Workspace trust, tool allowlists, and path containment are application policies, not substitutes for one. An explicitly configured external execution backend must be established successfully or the requested boundary fails closed; see [Execution backends](execution-backends.md).
