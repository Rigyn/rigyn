# Test and release rigyn

Read [Development from source](../../../../docs/development.md), [Local diagnostics](../../../../docs/diagnostics.md), and [Release policy](../../../../docs/releasing.md) before running broad or release-impacting work.

## Diagnose first

A request to diagnose rigyn authorizes non-mutating status commands in the requested Rigyn home and workspace. It does
not authorize automatic ingestion of raw logs, crash reports, or session content. Use the installed command help and
version-matched [Local diagnostics](../../../../docs/diagnostics.md) guide instead of guessing flags.

1. Run `rigyn --version`, `rigyn --help`, and the relevant `rigyn COMMAND --help` before collecting evidence.
2. Start with non-content probes: `rigyn logs --json` locates continuous-log metadata plus the fixed redraw,
   diagnostics, crash-report, and session paths without reading those private artifacts,
   `rigyn stats --json` reads only bounded aggregate snapshots, and `rigyn diagnostics` emits a bounded support
   document without reading logs, crash reports, credentials, or sessions. Give diagnostics a new explicit path only
   when an owner-only file is needed; it never replaces a file.
3. Validate only the implicated non-executable surface with `rigyn config validate --json` or
   `rigyn sessions doctor --json`. Project configuration requires existing trust.
4. Run `rigyn extensions doctor --json --offline` only when extension behavior is implicated and the user explicitly
   authorizes executing the already-trusted extension runtime. It may initialize runtime state, and trusted extension
   code can perform its own side effects. Never grant project trust merely to diagnose it. Omit `--offline` only when
   network-dependent extension behavior is necessary and separately authorized.
5. If those reports are insufficient, ask before opening private content. Use the paths returned by
   `rigyn logs --json`, select only the relevant bounded log region or crash record, and inspect an exact session only
   when its conversation evidence is necessary. Never bulk-read these directories or edit a live session JSONL file.
6. Before sharing any artifact, redact credentials, local paths, URLs, request identifiers, prompts, model or reasoning
   text, tool input/output, source content, and other operational context. A redacted session export still requires
   human review.

Do not add prompt, model text, reasoning, tool input/output, credentials, raw provider bodies, or arbitrary headers to
continuous logs while fixing a diagnosis gap. Keep all free-form error and warning text, cancellation reasons, and
in-doubt explanations out of continuous records; preserve only fixed codes, normalized categories, counts, booleans,
durations, and allowlisted transport metadata. Reduce media types to a validated bare value, accept transport codes
and request identifiers only when they match the bounded opaque-token grammar, and omit nonconforming values. Treat
the exact run failure in the active UI or private V4 session journal, and fatal messages or stacks in private crash
reports, as separate private evidence. Access either surface only with explicit, scoped authorization.

## Focused verification

Use Node.js 26.7.0 or newer. Run a focused application test from `packages/rigyn`:

```sh
node --import ./test/setup.mjs --import tsx --test test/path/to/focused.test.ts
```

For a source contract, also run the applicable checks:

```sh
npm run typecheck --workspace rigyn
npm run typecheck:test --workspace rigyn
git diff --check
```

Build sibling workspaces before testing built exports. Use an isolated `RIGYN_HOME` and `--offline` when a test must not read personal settings, credentials, sessions, packages, or caches. Offline mode does not sandbox extension or tool code.

Test terminal input, resize, paste, scroll, and cancellation in a real PTY. Test provider transports with deterministic fixtures before any live call. Run paid or credentialed live tests only after explicit authorization for the provider, model, and cost.

## Broad verification

Before handing off a repository change, return to the repository root and run:

```sh
npm run check
```

For high-risk or release work, also run the source-risk and credential-free release gates documented by the repository:

```sh
npm run test:coverage:risk
npm run benchmark:release-offline
```

Record exact pass, fail, and skip counts. A skipped platform or credential case is not a pass; state why it could not run.

## Package verification

For an extension package, follow the exact source, packed-archive, install, `/refresh`, behavior, removal, and cleanup sequence in [Extensions](extensions.md). Test the installed artifact rather than inferring behavior from source.

For rigyn itself, use the private source installer only when verifying launchers, ownership markers, platform helpers, update, or uninstall behavior. Use a temporary home and installation root. Confirm that installation preserves user `AGENTS.md` and `config.json`, and that uninstall removes only marker-owned files.

## Release boundary

Do not commit, tag, push, publish, delete releases, or rewrite history without explicit user authorization. Do not run release staging from an unclean or untested tree.

When authorized, follow the current release guide exactly. Verify synchronized workspace versions, the lockfile, source version, changelog, tag, source archive, package archives, standalone targets, checksums, manifest, SBOM, and provenance. Build artifacts from the exact release commit and never move or reuse a published tag.

Report the release commit and tag, every generated artifact, verification evidence, platform skips, and any remaining publication step. A local build alone is not a published release.
