# Platform notes

Rigyn requires Node.js 24.15 or a current Node.js 26-or-newer release. The source and packed-artifact checks run on Linux, macOS, and Windows.

## Linux

When `secret-tool` is executable, credentials can use Secret Service. Otherwise interactive setup creates an encrypted fallback store with a private local key. Clipboard images use available Wayland/X11/WSL/Termux helpers in bounded fallback order. Kitty and iTerm image protocols are detected separately from clipboard support.

If a desktop keyring is unavailable in SSH or a minimal container, keep the configuration and state directories private and provide the documented credential-key mechanism. Project trust and workspace path boundaries are not process isolation.

## macOS

The system `security` command backs Keychain storage. The native clipboard and iTerm/Kitty-capable terminals are supported. If an external editor or browser login opens in the wrong desktop context, launch Rigyn from the same user session as the terminal.

## Windows

The encrypted fallback key is protected with DPAPI. Process cancellation uses Windows process-tree handling, and Git Bash discovery supplies a shell where available. Use native absolute paths in configuration; path validation rejects ambiguous device and alternate-data-stream forms at protected boundaries.

PowerShell, Windows Terminal, and Git Bash have different key and quoting behavior. Package-manager wrapper commands are JSON argv arrays, never shell strings.

## WSL

The harness runs as a Linux process and stores Linux-side state by default. Clipboard acquisition can call Windows helpers when detected. Avoid placing the SQLite database on a filesystem that does not provide normal locking and permission behavior.

## Termux and remote terminals

Termux clipboard helpers are supported when installed. Remote terminals may not advertise image protocols or browser callbacks; device OAuth and text/image fallbacks remain available where the provider supports them. `tmux` and terminal multiplexers can consume key combinations before the TUI sees them, so use `/hotkeys` and adjust the terminal or harness keybinding map when necessary.

## Containers and remote execution

Running the entire process in a reviewed container is an operating-system boundary. Workspace trust, tool allowlists, and path containment are application policies, not substitutes for one. An explicitly configured external execution backend must be established successfully or the requested boundary fails closed; see [Execution backends](execution-backends.md).
