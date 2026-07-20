# Security policy

## Reporting a vulnerability

Use the repository's private vulnerability-reporting form under **Security → Report a vulnerability**. Include the affected version, operating system, a minimal reproduction, impact, and any known mitigations. Do not place credentials, private source, exploit details, or user data in a public issue.

If private reporting is unavailable, open a public issue that asks a maintainer to establish a private channel. Describe only the affected component and general impact until that channel exists.

Maintainers should acknowledge a complete report within seven days, establish severity and next steps, and coordinate disclosure with the reporter. A fix may be released without advance public detail when disclosure would increase user risk.

## Supported versions

Rigyn is a pre-1.0 project. Security fixes target the latest published minor line. Older pre-release lines may require upgrading rather than receiving a backport. The release notes identify security-relevant migrations or mitigations.

## Security boundary

Runtime extensions and managed packages are trusted local code. They have the invoking user's operating-system access once enabled. Project-local executable resources stay blocked until the workspace is trusted, but trust is not a process sandbox. Ordinary provider integrations keep credential values behind the broker. A separately reviewed package may declare `credentialAccess` to receive the active access credential, but refresh tokens and store handles remain private, and no credential may be included in logs, reports, extension messages, session exports, or vulnerability reproductions. The still-higher `unsafeTerminal` permission exposes raw input and arbitrary terminal-protocol output, so it must be treated as keyboard and terminal takeover authority.

For installation and environment-specific diagnostics, see [`docs/install.md`](docs/install.md).
