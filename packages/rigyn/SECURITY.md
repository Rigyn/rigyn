# Security policy

## Reporting a vulnerability

Use the repository's private vulnerability-reporting form under **Security → Report a vulnerability**. Include the affected version, operating system, a minimal reproduction, impact, and any known mitigations. Do not place credentials, private source, exploit details, or user data in a public issue.

If private reporting is unavailable, open a public issue that asks a maintainer to establish a private channel. Describe only the affected component and general impact until that channel exists.

Maintainers should acknowledge a complete report within seven days, establish severity and next steps, and coordinate disclosure with the reporter. A fix may be released without advance public detail when disclosure would increase user risk.

## Supported versions

rigyn is a pre-1.0 project. Security fixes target the latest published minor line. Older pre-release lines may require upgrading rather than receiving a backport. The release notes identify security-relevant migrations or mitigations.

## Security boundary

Runtime extensions and managed packages are trusted local code. They have the invoking user's operating-system access and the complete extension API once enabled. Project-local executable resources stay blocked until the workspace is trusted, but trust is not a process sandbox and package metadata does not define secondary capability tiers. Prefer brokered provider requests when direct credentials are unnecessary. Credential-store handles remain private, and no credential may be included in logs, reports, extension messages, session exports, or vulnerability reproductions. Terminal-input listeners, editor replacement, and custom TUI components expose keyboard and terminal authority, so loading a package that uses them must be treated as granting interactive-terminal control.

For installation and environment-specific diagnostics, see the [installation guide](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/docs/install.md).
