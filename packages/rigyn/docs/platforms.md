# Platform notes

Building or running rigyn from source requires Node.js 26.7.0 or newer; standalone
archives include their own runtime. The source and packed-artifact checks run on Linux, macOS, and Windows. Release
verification covers x64 and arm64. macOS runners load the matching TUI and Keychain helpers; Windows runners load the
matching TUI helper and kernel Job Object launcher from the installed archive.

The CLI uses Linux Secret Service after a non-destructive write/read/delete probe. Windows stores an encrypted
credential envelope in `auth.json.enc`; its random key is protected for the current user with DPAPI in `auth.json.key`.
macOS uses Keychain Services through the packaged `rigyn-keychain-helper`; its bounded stdin/stdout protocol never puts
secrets in process arguments or environment variables. Initial setup uses the owner-only, atomically written
`auth.json` fallback when a stronger backend cannot be created. A durable nonsecret `auth.json.backend` marker pins a
successfully selected stronger backend; later outages fail closed rather than silently creating a second store.
Existing plaintext credentials are removed only after the selected backend verifies every copied value.

## Linux

Keep the Rigyn home private in desktop, SSH, and container environments. Clipboard images use available
Wayland/X11/WSL/Termux helpers in bounded fallback order. Kitty and iTerm image protocols are detected separately
from clipboard support. Project trust and workspace path boundaries are not process isolation.

## macOS

The native clipboard and iTerm/Kitty-capable terminals are supported. If an external editor or browser login opens
in the wrong desktop context, launch rigyn from the same user session as the terminal.

## Windows

Process cancellation launches each shell inside a kernel-owned Windows Job Object so cleanup terminates the complete
process tree even after the shell exits. Git Bash discovery supplies a shell where available.
Use native absolute paths in configuration; path validation rejects ambiguous device and alternate-data-stream forms
at protected boundaries.

PowerShell, Windows Terminal, and Git Bash have different key and quoting behavior. Package-manager and
external-editor commands must resolve to a native executable or an interpreter plus script path. rigyn does not pass
`.cmd` and `.bat` wrappers through `cmd.exe`. Package-manager wrapper commands are JSON argument arrays, not shell
strings.

## WSL

The harness runs as a Linux process and stores Linux-side state by default. Clipboard acquisition can call detected
Windows helpers. Keep live session JSONL files on a filesystem with reliable append and rename behavior. Do not edit
an active session file from Windows.

## Termux and remote terminals

Termux clipboard helpers are supported when installed. Remote terminals may not advertise image protocols or browser
callbacks. Device OAuth and text or image fallbacks remain available when the provider supports them. `tmux` and
other multiplexers can consume keys before the TUI sees them. Use `/hotkeys` and adjust the terminal or rigyn
keybinding when needed.

## Containers and remote execution

Running the entire process in a reviewed container creates an operating-system boundary. Workspace trust, tool
allowlists, and path containment are application policies, not substitutes for that boundary. A requested external
execution backend must start successfully or fail closed. See [Execution backends](execution-backends.md).
