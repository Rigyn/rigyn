# Installation and platform troubleshooting

## Requirements and distribution

The managed one-line installer needs neither Node.js nor npm. It detects Linux, macOS, or Windows and x64 or arm64.
It downloads the matching standalone runtime only from GitHub Releases, verifies it against `SHA256SUMS`, and rejects
unsafe archive paths before switching the per-user launcher.

The archive includes the pinned Node.js runtime, production dependencies, and the matching terminal helper. Windows
archives also include the matching kernel Job Object launcher used for bounded process-tree cancellation. Running the
installer again stages and replaces the current version from verified release bytes. This can repair a stale or
damaged runtime.

Linux and macOS need `curl`, `tar`, and one of `sha256sum`, `shasum`, or `openssl`. Current Windows installations
include PowerShell, `Get-FileHash`, and `tar.exe`.

On Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/rigyn/rigyn/v0.1.0/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rigyn/rigyn/v0.1.0/install.ps1 | iex
```

For a portable manual copy, download `rigyn-v<version>-<platform>-<arch>.tar.gz` and `SHA256SUMS` from the same
release. Verify the exact archive line, extract it with `tar -xzf`, then run `bin/rigyn` on Linux or macOS or
`bin\rigyn.cmd` on Windows. A portable archive stores configuration and sessions in the normal rigyn user directories
rather than beside the executable.

To remove a portable copy, close its processes and delete the extracted archive directory. The managed
`rigyn uninstall --yes` command intentionally refuses to claim or delete an arbitrary portable directory. Its
configuration and sessions remain under `~/.rigyn` until you intentionally remove or reuse that user state.

To build from the public source checkout instead, install Node.js 26.7.0 or newer and npm:

```sh
git clone https://github.com/rigyn/rigyn.git
cd rigyn
npm run install:user
rigyn --version
```

The source checkout and versioned source archive contain native helper source code, not generated binaries. First
check `rigyn-v<version>-source.tar.gz` against the release's `SHA256SUMS`. Extract it, enter its
`rigyn-v<version>` directory, and run `npm ci --ignore-scripts`. Then run `npm run build` or
`npm run install:user`.

On macOS, a source installation requires `cc` and `swiftc` on `PATH`, normally from the Xcode Command Line Tools. On
Windows, use an architecture-matching MSVC developer shell with `cl` on `PATH`. The installer builds and exercises
both the terminal helper and kernel Job Object launcher before packaging the private installation. A compiler or
verification failure stops the install. Linux does not compile these platform helpers.

By default, the managed standalone installation has one per-user root on every platform:

```text
~/.rigyn/           configuration, credentials, sessions, logs, diagnostics, crash reports, and resources
~/.rigyn/bin/       managed launcher
~/.rigyn/runtime/   versioned standalone runtimes
```

On Linux and macOS, `~/.local/bin/rigyn` is only a command symlink to the launcher in this root. Ordinary updates
under `~/.rigyn/runtime` retain other version directories.

Installation creates an empty, user-owned `~/.rigyn/AGENTS.md` and copies the packaged portable, non-null
`~/.rigyn/config.json` baseline only when each file is missing. The baseline exposes stable editable defaults and
leaves environment-, provider-, model-, path-, and provider-budget-derived values to the runtime; the linked schema
documents every supported key. Runtime execution does not use the source checkout or npm's global package directory.

Rerun the one-line installer to update a standalone installation. The new version is fully downloaded and verified
before the launcher changes, and previous version directories are retained. `rigyn self-update` in a standalone
runtime prints the exact installer command; source-built private installations continue to use the marker-verified
`rigyn self-update` implementation.

On Linux and macOS, runtime replacement and managed uninstall use bounded transaction records under the same
`~/.rigyn` lifecycle lock. If the installer or uninstaller is stopped after isolating a runtime, rerun the one-line
installer. It validates the recorded paths and installation identity, restores the last complete state, removes only
verified staging residue, and then starts the requested install again.

The standalone and source-built installers both use `~/.rigyn`, but they have different ownership records. Do not
install one over the other. Source uninstall removes the complete private root, including saved state, so preserve
`~/.rigyn` before switching distributions.

On Linux or macOS, close every running rigyn process and make a private backup of user-owned state. Do not copy
`bin`, `runtime`, `app`, installation markers, lifecycle locks, or staging directories:

```sh
set -eu
umask 077
test -d "$HOME/.rigyn"
rigyn_state_backup=$(mktemp -d "${TMPDIR:-/tmp}/rigyn-state.XXXXXX")
for name in AGENTS.md config.json auth.json models.json models-store.json sessions extensions skills prompts themes tools npm git extension-data; do
  if [ -e "$HOME/.rigyn/$name" ]; then cp -Rp "$HOME/.rigyn/$name" "$rigyn_state_backup/$name"; fi
done
rigyn uninstall --yes
# Run the new installer, then restore the selected entries.
cp -Rp "$rigyn_state_backup/." "$HOME/.rigyn/"
```

On Windows PowerShell:

```powershell
$ErrorActionPreference = "Stop"
$rigynHome = Join-Path $HOME ".rigyn"
if (-not (Test-Path -LiteralPath $rigynHome -PathType Container)) {
    throw "rigyn state was not found: $rigynHome"
}
$rigynStateBackup = Join-Path ([IO.Path]::GetTempPath()) ("rigyn-state-" + [Guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $rigynStateBackup)
foreach ($name in @("AGENTS.md", "config.json", "auth.json", "models.json", "models-store.json", "sessions", "extensions", "skills", "prompts", "themes", "tools", "npm", "git", "extension-data")) {
    $source = Join-Path $rigynHome $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $rigynStateBackup $name) -Recurse
    }
}
rigyn uninstall --yes
# Run the new installer, then restore the selected entries.
Copy-Item -Path "$rigynStateBackup\*" -Destination "$HOME\.rigyn" -Recurse -Force
```

Restore the selected entries only after the new installer succeeds. Keep the backup until `rigyn` starts and your
configuration, credentials, and sessions are present.

## Linux

The installer writes the managed command to `~/.local/bin/rigyn`. If it is not found, add this directory to the login shell path and open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Minimal distributions may need `curl`, `tar`, and `sha256sum` installed first. Node.js, npm, a compiler, and Python
are needed only for a source build.

If browser OAuth cannot open a desktop browser, copy the displayed URL into a browser on the same machine. You may
complete a device-code flow on another device only when the provider supports it.

## macOS

The installer detects Apple silicon (`arm64`) or Intel (`x64`) automatically. A source build must use a supported
Node.js build matching that CPU. Confirm a source runtime with:

```sh
node -p "process.platform + ' ' + process.arch"
```

The command path is `~/.local/bin`, as on Linux. If a native dependency falls back to compilation, inspect the
original failure first. Install the Command Line Tools with `xcode-select --install`, then retry from a clean npm
cache.

Terminal applications may need permission to access files outside the workspace or to control a browser. rigyn does not bypass macOS privacy controls.

## Windows

Run installation from PowerShell. The installer detects native arm64 or x64 and creates this launcher:

```powershell
& "$HOME\.rigyn\bin\rigyn.cmd" --version
```

Add `$HOME\.rigyn\bin` to the user `Path` if `rigyn` is not found in a new terminal. The installer deliberately does not edit the registry or PowerShell profile.

PowerShell execution policy does not apply to the `.cmd` launcher. A source build must use a Node.js runtime matching
Windows and the current CPU:

```powershell
node -p "process.platform + ' ' + process.arch"
npm config get cache
```

Windows Terminal is recommended for Unicode and color. ConPTY-compatible terminals provide the most reliable streaming and resize behavior.

## WSL

Run the Linux installer inside WSL; do not reuse a Windows runtime or Windows rigyn installation. Keep active
repositories in the WSL filesystem when performance matters. The Linux command remains `~/.local/bin/rigyn`.

Browser launch and clipboard integration depend on the WSL distribution, desktop integration, and terminal. Copy an
OAuth URL manually when automatic opening is unavailable. Tools receive Linux paths and run with the invoking WSL
user's access.

## Optional search binaries

The `find` tool first uses `fd` from Rigyn's private `bin` directory, then checks `PATH`. When `fd` is absent and
offline mode is disabled, Rigyn accepts only reviewed official fd archives. Linux, macOS, and Windows archives are
pinned separately for `x64` and `arm64`; every download is size-bounded and checked against the upstream release
SHA-256 before archive inspection or extraction. Unsupported operating-system or CPU combinations remain disabled
instead of falling back to an unreviewed asset.

The fd 10.4.2 release does not publish an Intel macOS archive. On Intel macOS,
Rigyn retains the last official archive for that target, fd 10.3.0, verifies its
published digest, and reports that target-specific pin during installation. An
already installed private or `PATH` fd still takes precedence and produces no
fallback notice.

The `grep` tool uses the executable shipped by the pinned `@vscode/ripgrep`
dependency. If that packaged executable is unavailable, Rigyn checks `PATH`
for `rg`; it does not download a separate ripgrep archive at runtime.

## Termux

Termux is a best-effort environment, not a release-matrix target. Android uses a different native runtime from
standard Linux. Install the Node.js, compiler, Python, and ripgrep packages, then confirm Node is at least 26.7.0:

```sh
pkg update
pkg install nodejs-lts python clang make pkg-config ripgrep
node --version
```

Native image processing may require Termux-compatible libvips packages or a local build. If npm cannot install and
load `sharp`, normal CLI startup is not supported on that device. Do not install a desktop Linux native archive on
Android.

## tmux and terminal behavior

Use a recent tmux and a terminal definition with 256 colors. A typical tmux configuration is:

```text
set -g focus-events on
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features ',*:RGB'
```

Restart the tmux server after changing terminal capabilities. If shortcuts arrive incorrectly, compare rigyn inside
and outside tmux. Inspect `/hotkeys` and remove conflicting tmux bindings. Inline images may require terminal-specific
passthrough. Text markers remain available when image display is unsupported.

## Common diagnostics

```sh
rigyn --version
rigyn --help
rigyn config path
rigyn diagnostics
rigyn extensions doctor
```

If `rigyn` is missing, invoke the launcher by its full path and correct `PATH`. If a provider is missing from
`/model`, connect it with `/login` and let the live model catalog refresh. If an extension is blocked, inspect trust
and run `extensions doctor`. Do not bypass an integrity or ownership error.

To fully remove either managed installation form:

```sh
rigyn uninstall --yes
```

This command removes the managed launcher, runtime, personal instructions, settings, OAuth and API-key profiles,
sessions, logs, cache, and the rest of `~/.rigyn`. On Linux and macOS it also removes the managed
`~/.local/bin/rigyn` command link. It does not remove a source checkout, project workspace, unmanaged command, or a
separate Rigyn home selected through `RIGYN_HOME`.

Source install, self-update, and uninstall are serialized across processes. Update and uninstall refuse to change the
installation while another rigyn runtime is active, so close the other terminal first. Source self-update verifies
the latest public GitHub release and refuses an implicit downgrade.

`RIGYN_UPDATE_SPEC` is an explicit operator override for a reviewed local `rigyn-<version>.tgz` accompanied by the
other three same-version package archives. After an interrupted install or uninstall, the next lifecycle command
recovers from the transaction record. Uninstall never removes the source checkout or arbitrary workspaces.

## Bash overflow artifacts

When displayed Bash output is truncated, Rigyn attempts to save the complete output in the private temporary artifact
named by the tool result, up to 64 MiB per file. It reserves that full allowance before writing, across Rigyn
processes, and admits at most 128 active or closed artifacts and 512 MiB of reserved or stored payload. Output is
written under an internal active name and becomes a named `.log` artifact only after a successful close. Active files
are not pruned or exposed. A later process removes an active file only when its creator PID is definitely dead; a
live or indeterminate creator is retained.

If private storage, admission, or the retention lock is unavailable, the command still returns its bounded tail,
marks the complete output unavailable and truncated, drops the raw in-memory backlog, and reports no artifact path.
If a file reaches 64 MiB, the result marks the published artifact truncated. Cleanup runs opportunistically at startup, allocation,
successful close, and finalization. Closed artifacts older than 7 days are eligible for removal, but Rigyn does not
run a wall-clock cleanup service, so the seven-day age is not an exact deletion deadline.

A successful installed-copy uninstall removes only the spill root beneath that exact installation's `tmp` directory;
it cannot purge another installation or a source/direct run using a different temporary root. If the selected path is
a link, has the wrong type or owner, is not private on Linux or macOS, contains an unrecognized entry, or has a live or
indeterminate retention-lock owner, uninstall stops before removing the installation. Inspect the path instead of
bypassing the ownership check.

On Windows, Node exposes reparse-point status but no portable API for proving an arbitrary directory's effective ACL.
Rigyn therefore rejects reparse points and validates exact names, types, bounded control records, and file identities;
it trusts the installed per-user root and its `tmp` directory to remain writable only by that Windows account. Keep
the installation under the account's normal private profile and do not grant other users write access to it.
