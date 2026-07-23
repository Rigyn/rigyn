# Installation and platform troubleshooting

## Requirements and distribution

The managed one-line installer requires a supported 64-bit Node.js 24.15+ or 26+ runtime and the local npm command.
It downloads rigyn only from GitHub Releases; no npm account or registry-hosted rigyn package is required. The four
rigyn archives are platform-neutral, while `@rigyn/terminal` carries the complete prebuilt macOS and Windows helper
matrix and npm selects third-party native dependency variants for the current operating system and CPU.

Check the runtime before installation:

```sh
node --version
npm --version
```

On Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/rigyn/rigyn/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rigyn/rigyn/main/install.ps1 | iex
```

Each installer obtains the latest release identity, downloads all four exact archives and `SHA256SUMS`, verifies every
archive, and only then invokes the private installer. The equivalent version-pinned manual command is:

```sh
npm exec --yes \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-terminal-0.6.0.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-models-0.6.0.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-kernel-0.6.0.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-0.6.0.tgz \
  -- rigyn self-install
rigyn --version
```

This uses npm's one-shot package executor and does not create a global npm installation or resolve rigyn from the npm
registry.

rigyn releases also provide standalone runtime archives for Linux, macOS, and Windows on x64 and arm64. A standalone
archive includes the pinned official Node.js runtime and complete production dependency graph, so Node and npm are not
installation prerequisites. Download the archive matching `process.platform`/`process.arch`, verify it against the
release `SHA256SUMS`, and extract it with `tar -xzf`. On Linux and macOS, run `bin/rigyn`; on Windows, run
`bin\rigyn.cmd`. The archive is relocatable and stores user configuration and sessions in the normal rigyn user
directories rather than beside the executable.

To install from the public source checkout instead:

```sh
git clone https://github.com/rigyn/rigyn.git
cd rigyn
npm run install:user
rigyn --version
```

The source checkout and versioned release source archive contain the native helper sources rather than generated binaries. After checking `rigyn-v<version>-source.tar.gz` against the release's `SHA256SUMS`, extract it, enter its `rigyn-v<version>` directory, and run `npm ci --ignore-scripts`, followed by `npm run build` or `npm run install:user`. On macOS, source installation requires `cc` on `PATH` (normally from the Xcode Command Line Tools). On Windows, run it from an architecture-matching MSVC developer shell with `cl` on `PATH`. The installer builds and loads the matching helper before it packages the private installation; a compiler or verification failure stops the install. Linux does not use this terminal helper and needs no helper compilation step.

The application, dependencies, configuration, sessions, credentials, cache, and temporary files live under `~/.rigyn` by default. An install copies the packaged personalization and settings templates to `~/.rigyn/agent/AGENTS.md` and `~/.rigyn/agent/settings.json` when either file is missing, without overwriting existing copies. Set `RIGYN_INSTALL_DIR` only when a different self-contained root is required. The source checkout and npm's global package directory are not used at runtime.

To verify the complete release before installation, download the wanted artifacts and `SHA256SUMS` from the same release, then check the selected lines with `sha256sum --check` (or `shasum -a 256 -c` on macOS). Pass all four product archives explicitly so npm does not resolve an internal package from a different source:

```sh
npm exec --yes \
  --package=./rigyn-terminal-0.6.0.tgz \
  --package=./rigyn-models-0.6.0.tgz \
  --package=./rigyn-kernel-0.6.0.tgz \
  --package=./rigyn-0.6.0.tgz \
  -- rigyn self-install
```

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

Terminal applications may need permission to access files outside the workspace or to control a browser. rigyn does not bypass macOS privacy controls.

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

Install and run the Linux Node.js build inside WSL; do not reuse a Windows `node_modules` directory or Windows rigyn installation. Keep active repositories in the WSL filesystem when performance matters. The Linux command remains `~/.local/bin/rigyn`.

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
rigyn config path
rigyn diagnostics
rigyn extensions doctor
```

If `rigyn` is missing, invoke the launcher by its full path and correct `PATH`. If a provider is missing from `/model`, connect it with `/login` and allow the live model catalog to refresh. If an extension is blocked, inspect trust and `extensions doctor`; do not bypass an integrity or ownership error.

To remove the private installation and all installation-owned credentials and sessions:

```sh
rigyn uninstall --yes
```

Install, self-update, and uninstall are serialized across processes. Update and uninstall refuse to mutate the
installation while another rigyn runtime is active; close the other terminal first. The default self-update verifies
the latest public GitHub release and refuses to replace the installation with an older version;
`RIGYN_UPDATE_SPEC` remains an explicit operator override for a reviewed local `rigyn-<version>.tgz` accompanied by
the other three same-version package archives. An interrupted install or
uninstall is recovered from its transaction record on the next lifecycle command. Uninstall never removes the source
checkout or arbitrary workspaces.
