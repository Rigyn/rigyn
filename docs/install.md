# Installation and platform troubleshooting

## Requirements and distribution

Rigyn requires a supported 64-bit Node.js 24.15+ or 26+ runtime and npm. This runtime floor guarantees SQLite 3.51.3 or newer for durable WAL sessions; startup refuses an older bundled SQLite instead of risking the session database. The published artifact is Node-native: npm installs one platform-neutral Rigyn archive plus the native dependency variants for the current operating system and CPU. Official release verification covers Linux, macOS, and Windows on x64 and arm64.

Check the runtime before installation:

```sh
node --version
npm --version
```

After the first npm package release, install the private per-user copy:

```sh
npx --yes rigyn@latest self-install
rigyn --version
```

Until then, install from the public source checkout:

```sh
git clone https://github.com/Rigyn/rigyn.git
cd rigyn
node scripts/install-user.mjs
rigyn --version
```

The application, dependencies, configuration, sessions, credentials, cache, and temporary files live under `~/.rigyn` by default. Set `RIGYN_INSTALL_DIR` only when a different self-contained root is required. The source checkout and npm's global package directory are not used at runtime.

Verify downloaded release files with the published `SHA256SUMS` before installing an archive directly.

## Linux

The installer writes the managed command to `~/.local/bin/rigyn`. If it is not found, add this directory to the login shell path and open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

On minimal distributions, install Node.js 24.15+ or 26+ and standard C/C++ build tools before retrying npm. Native dependencies normally use prebuilt binaries; a source fallback needs a compiler toolchain and Python.

If browser OAuth cannot open a desktop browser, copy the displayed URL into a browser on the same machine. Device-code providers can be completed on another device when the provider explicitly supports that flow.

## macOS

Use a supported Node.js build matching the Mac CPU (`arm64` on Apple silicon, `x64` on Intel). Confirm with:

```sh
node -p "process.platform + ' ' + process.arch"
```

The command path is `~/.local/bin`, as on Linux. If a native dependency falls back to compilation, install the Command Line Tools with `xcode-select --install`, then retry from a clean npm cache only after reviewing the original failure.

Terminal applications may need permission to access files outside the workspace or to control a browser. Rigyn does not bypass macOS privacy controls.

## Windows

Run installation from PowerShell with a supported native arm64 or x64 Node.js build matching Windows. The launcher is:

```powershell
& "$HOME\.rigyn\bin\rigyn.cmd" --version
```

Add `$HOME\.rigyn\bin` to the user `Path` if `rigyn` is not found in a new terminal. The installer deliberately does not edit the registry or PowerShell profile.

PowerShell execution policy does not apply to the `.cmd` launcher. If native package installation fails, confirm that Node and npm report the expected architecture:

```powershell
node -p "process.platform + ' ' + process.arch"
npm config get cache
```

Windows Terminal is recommended for Unicode and color. ConPTY-compatible terminals provide the most reliable streaming and resize behavior.

## WSL

Install and run the Linux Node.js build inside WSL; do not reuse a Windows `node_modules` directory or Windows Rigyn installation. Keep active repositories in the WSL filesystem when performance matters. The Linux command remains `~/.local/bin/rigyn`.

Browser launch and clipboard integration depend on the WSL distribution, desktop integration, and terminal. Copy an OAuth URL manually when automatic opening is unavailable. Paths passed to tools are Linux paths and retain the invoking WSL user's access.

## Termux

Termux is a best-effort environment rather than a release-matrix target because Android uses a different native runtime from standard Linux. Install its Node.js, compiler, Python, and ripgrep packages, then confirm Node is at least 24 before attempting installation:

```sh
pkg update
pkg install nodejs-lts python clang make pkg-config ripgrep
node --version
```

Native image processing may require Termux-compatible libvips packages or a local build. If npm cannot install or load `sharp`, image preprocessing and normal CLI startup cannot be considered supported on that device. Do not force-install a desktop Linux native archive on Android.

## tmux and terminal behavior

Use a recent tmux and a terminal definition with 256 colors. A typical tmux configuration is:

```text
set -g focus-events on
set -g extended-keys on
set -as terminal-features ',*:RGB'
```

Restart the tmux server after changing terminal capabilities. If shortcuts arrive incorrectly, compare `rigyn` outside tmux, inspect `/hotkeys`, and remove conflicting tmux bindings. Inline image protocols may require terminal-specific passthrough; text markers remain available when image display is unsupported.

## Common diagnostics

```sh
node -p "process.version + ' ' + process.platform + ' ' + process.arch"
rigyn --version
rigyn --help
rigyn config
rigyn extensions doctor
```

If `rigyn` is missing, invoke the launcher by its full path and correct `PATH`. If a provider is missing from `/model`, connect it with `/login` and allow the live model catalog to refresh. If an extension is blocked, inspect trust and `extensions doctor`; do not bypass an integrity or ownership error.

To remove the private installation and all installation-owned credentials and sessions:

```sh
rigyn uninstall --yes
```

Install, self-update, and uninstall are serialized across processes. Update and uninstall refuse to mutate the installation while another Rigyn runtime is active; close the other terminal first. An interrupted install or uninstall is recovered from its transaction record on the next lifecycle command. Uninstall never removes the source checkout or arbitrary workspaces.
