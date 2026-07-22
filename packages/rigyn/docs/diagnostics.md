# Local diagnostics

Run a credential-free local support probe with:

```sh
rigyn diagnostics
```

The command writes one JSON document to standard output. To create a private file instead:

```sh
rigyn diagnostics ./rigyn-support.json
```

File creation is exclusive and owner-only. An existing file is never replaced.

The bundle contains the Rigyn and Node versions, operating-system identity, project-trust status, configuration key names, file metadata, extension and skill summaries, bounded loader diagnostics, and elapsed time for each local probe. Timings use a monotonic process clock and are visibility aids, not cross-machine performance benchmarks.

The collector never opens the credential store or session JSONL files for content. It reads bounded configuration, manifest, contribution, and skill-frontmatter data for static validation, but it does not include configuration values, descriptions, instructions, templates, themes, or runtime code in the bundle, and it never executes extension code. Paths below the workspace become `<workspace>` and paths below the home directory become `~`. Known secret shapes, authenticated URL user information, and credential-like query parameters are redacted again before serialization.

Treat the output as private operational data anyway: installed package IDs, skill names, platform details, and project-resource names can reveal how a machine is configured. Review the JSON before sharing it.

Useful fields:

- `configuration.*.status` separates absent, ignored, valid, and invalid files without copying their values.
- `paths.*.kind`, `mode`, and `ownerOnly` expose common ownership and symlink problems.
- `resources.*Diagnostics` identify malformed or shadowed resources through bounded codes, messages, and normalized paths.
- `timingsMs` shows which static probe was slow.
- `errors` isolates a failed probe while preserving the rest of the bundle.
