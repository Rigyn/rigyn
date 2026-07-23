# Extension packages

rigyn extensions are ordinary trusted Node.js packages. A package declares direct factory entry points and optional resources in `package.json`; each factory receives the public `ExtensionAPI` from `rigyn/extensions`.

Start with [`examples/starter`](../examples/starter/README.md). Copy it into a new workspace directory instead of editing the bundled example.

## Package shape

```text
my-extension/
  package.json
  README.md
  extensions/index.mjs
  skills/review/SKILL.md       # optional
  prompts/review.md            # optional
  themes/ocean.json            # optional custom theme
  test/runtime.test.mjs        # recommended
```

A complete declaration is:

```json
{
  "name": "@example/my-extension",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": { "rigyn": ">=0.4.0 <0.7.0" },
  "rigyn": {
    "extensions": ["extensions/index.mjs"],
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

The `rigyn` object consumes the `extensions`, `skills`, `prompts`, and `themes` string arrays. Paths are package-relative, normalized, and constrained to the package root. Missing paths, symlink escapes, and unsupported resource formats are rejected or reported by resource resolution. Declare only the documented keys; unrecognized `rigyn` keys are not extension configuration. rigyn ships the built-in `mono` and `signal` themes; package declarations add reviewed custom themes without replacing them.

`peerDependencies.rigyn` is the enforced host-compatibility range. rigyn validates it before package activation and does not install a nested host runtime. `engines.rigyn` remains optional report metadata for older packages, but it is not an activation gate. Test the packed artifact against every supported rigyn release before publishing.

When a declaration is omitted, the matching conventional directory is discovered if present. Explicit declarations are preferable for published packages because the packed file set is then obvious. Hierarchical `.gitignore`, `.ignore`, and `.fdignore` rules apply during package inventory.

Runtime files may be JavaScript, TypeScript, or their standard ESM/CommonJS variants. Every runtime entry must default-export one factory:

```js
export default function activate(rigyn) {
  rigyn.registerCommand("hello", {
    description: "Show a greeting",
    async handler(_args, context) {
      context.ui.notify("Hello from the extension.", "info");
    },
  });
}
```

## Install and run

Install a local package:

```text
rigyn install ./my-extension
```

Other immutable sources are supported:

```text
rigyn install "npm:@example/my-extension@1.2.3"
rigyn install "npm:file:///absolute/path/my-extension-1.2.3.tgz"
rigyn install "git:https://github.com/example/my-extension.git#0123456789abcdef0123456789abcdef01234567"
```

Git package URLs are credential-free. HTTPS credential helpers are disabled, so private HTTPS repositories are intentionally unavailable; use a real SSH host URL with an agent or a default key instead. SSH keeps the normal key and `known_hosts` locations but ignores user/system SSH configuration, aliases, `ProxyJump`, `ProxyCommand`, and local commands. Git LFS filters and submodules are disabled. A short moving ref resolves a same-named branch before a tag, then rigyn verifies that checkout still matches the advertised commit before activation.

Use `-l` for the trusted project scope. Lifecycle scripts are disabled by default; `--allow-scripts` is accepted only by install and update commands and should be used only after reviewing the complete dependency tree.

After changing package code, run `/reload`. rigyn sends `session_shutdown` to the current generation, activates a candidate, and replaces the current generation only after preparation succeeds. If candidate activation fails, the candidate is disposed and the previous generation receives `session_start` again.

Useful commands:

```text
rigyn list --json
rigyn extensions doctor
rigyn extensions show PACKAGE_ID
rigyn update PACKAGE_ID
rigyn remove PACKAGE_ID
```

For one invocation without persisting package settings, use `rigyn --extension /absolute/path/to/index.mjs` or point `--extension` at a package source that resolves to direct entries. Invocation loading never enables dependency lifecycle scripts.

## Declarative project package set

A trusted workspace may declare a reviewed package set in `.rigyn/packages.json`:

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "id": "local-review",
      "source": { "kind": "local", "path": "packages/review" },
      "disabledResources": ["command:internal-review"]
    },
    {
      "id": "published-review",
      "source": { "kind": "npm", "package": "@example/review", "selector": "^1.2.0" }
    },
    {
      "id": "git-review",
      "source": { "kind": "git", "repository": "https://github.com/example/review.git", "ref": "main" }
    }
  ]
}
```

Declarations are ignored without project trust. IDs are unique lowercase identifiers; local paths are normalized workspace-relative paths outside `.rigyn`; Git repositories must be credential-free HTTPS or SSH locations. Resource filters use `runtime:`, `skill:`, `prompt:`, `theme:`, or `command:` followed by a package-relative resource key or command name. Filters are literal and exact: `*`, `?`, and brackets are not globs, and a basename does not match the same name in another directory. For migrated `extension.json` packages, prompt, command, and theme keys are their declared IDs or names rather than their file paths.

The declaration is intentionally separate from its generated `.rigyn/packages.lock.json`:

```text
rigyn packages check
rigyn packages update --all
rigyn packages update local-review
rigyn packages reconcile
```

`update` is the only operation that follows a moving selector, branch, or local edit. It resolves selected declarations, records exact versions or revisions plus archive, manifest, and content digests, activation-tests the complete candidate set, and commits the installed set and lock together. Partial updates refuse to bless an unrelated declaration addition, removal, or edit.

Normal startup and `reconcile` consume only the immutable lock. A healthy local install is not refreshed merely because its source directory changed. If repair is required, the exact source must still reproduce the locked digests or reconciliation fails. The complete `.rigyn/packages` directory is staged and swapped as one recoverable transaction; cancellation or activation failure preserves the previous lock and installed set. Dependency lifecycle scripts remain disabled for every declarative operation. Do not hand-edit the generated lock.

New updates write project lock schema 2. Schema 2 uses locale-independent code-unit ordering, embeds canonical production dependency locks, includes empty directories in content identity, and rejects package-content names that are not portable across the supported filesystems: case or NFC-equivalent collisions, Windows device basenames, colons and other Windows-invalid characters, and trailing dots or spaces. Historical public package IDs remain unchanged; a Windows-reserved or trailing-dot ID is mapped to a collision-free private install-directory name. Modern packages with multiple runtime files receive deterministic path-derived extension IDs for every runtime, while a single runtime keeps the package ID.

A schema 1 lock from the shipped extension-package system remains read-only: normal startup can activate it, but repair and partial update require `packages update --all`. That command migrates `extension.json` packages without rewriting their source manifest. It honors `enabled`, host compatibility, declared integrity, arbitrary skill/prompt/command/theme/runtime paths, static declaration metadata, and the shared extension ID of multiple legacy runtime entries. If unchanged legacy syntax cannot be represented by the hardened authoring grammar, the schema 2 lock records `"declarationGrammar": "legacy"`; this marker preserves exact v1 SSH-user and resource-filter parsing without loosening ordinary schema 2 locks. An unchanged `extension.json` remains authoritative even when the source also carries unrelated modern `package.json` metadata. Legacy `permissions` are strictly parsed, but a declarative project package is trusted in-process code; project trust, not the legacy permission object, is the authority boundary.

Schema 2 is a one-way lifecycle upgrade. An older host that only understands schema 1 cannot consume or safely downgrade a schema 2 lock. Use version control to restore both the declaration, lock, and matching installed state if a host downgrade is required; never edit the schema number.

Production dependency replay is split into a portable anchor and a local platform attestation. The lock digest covers every required installed byte and rejects omitted-development roots or extraneous content. Required non-host peers are installed and attested; optional peers remain optional. A `rigyn` peer is checked against the running host version and removed from the install inventory so extensions cannot install a second host runtime. Optional, OS-gated, CPU-gated, and libc-gated packages may legitimately be absent on one platform and present on another, so their installed bytes are digested immediately after controlled `npm ci`. The exact digest is written to package provenance and to one append-only, mode-`0600` record keyed by canonical workspace, lock digest, package ID, and a stable OS/architecture/libc-family/Node-ABI fingerprint under rigyn's manager-private state beside the operation-lease root. Linux fingerprints distinguish glibc from musl; other operating systems use a deterministic non-Linux libc marker. A different digest for the same lock and platform fails closed; a deliberate declaration update creates a new lock identity. Startup requires the installed bytes, provenance, and external record to agree, so deleting optional bytes and rewriting the excluded in-package provenance cannot select an older attested digest. This protects against workspace drift or a writer limited to the project tree, not an attacker who can also modify rigyn's private agent state.

All npm resolution and replay commands run without the ambient process environment. rigyn supplies only executable/system path variables plus a private HOME, empty npm user/global configuration, cache, and temporary directory inside the quota-monitored staging root. Ambient `.npmrc`, registry tokens, lifecycle scripts, and update/audit/fund helpers are unavailable. Git materialization likewise uses isolated configuration, empty hooks/templates and filters, non-interactive credentials, an explicit protocol allowlist, and no submodules. Materialization is monitored while commands run and is terminated if it exceeds 4,096 filesystem entries, 64 MiB, or the depth bound; partial staging state is removed.

## Transaction and trust model

Install and update use a private staging directory. rigyn validates bounds, package structure, declared resources, production dependencies, and the exact runtime entries; activation is tested before code or settings are committed. A failure rolls back the staged package and preserves the installed version byte-for-byte. A multi-package update stages and activation-tests the complete selected set before committing any member, and reverses earlier swaps if a later filesystem commit fails.

Runtime code is trusted in-process code. It can use Node.js and any declared production dependency. Project-scoped code is not imported until project trust succeeds. Review the source, package metadata, dependency graph, install scripts, network destinations, and process boundaries before trusting a package.

An activation generation owns all registrations. Failed activation, timeout, successful reload, package replacement, and host close make its API stale before cleanup starts. `rigyn.onDispose` callbacks run once in reverse registration order. Cleanup failures are isolated and reported; later callbacks still run.

## Dependencies and host imports

Put runtime dependencies in `dependencies`; keep tests and build tools in `devDependencies`. Do not ship package-local `node_modules`.

A loaded extension may import the package root and stable host subpaths published by the installed rigyn version, including:

```text
rigyn/extensions
rigyn/providers
rigyn/storage
rigyn/tui
```

Use `rigyn` as a peer and development dependency when TypeScript declarations or standalone tests need it. The host aliases imports to its own installed copy, so an extension must not bundle a second rigyn runtime.

## Author verification

Run the author pipeline from the package root:

```text
rigyn extensions author validate .
rigyn extensions author inspect .
rigyn extensions author smoke .
rigyn extensions author reload .
rigyn extensions author report .
rigyn extensions author pack . ./artifacts
```

`validate` does not import runtime code. `smoke` activates and disposes a staged copy. `reload` activates a second candidate before disposing the first. `report` combines the non-mutating checks. `pack` writes an archive only to the explicit destination and validates that exact archive through the normal package path.

Also test malformed input, cancellation, activation failure, repeated reload, cleanup, and the exact installed artifact. A passing source test does not prove that an npm archive contains every declared file.

## Focused examples

| Package | Contract |
| --- | --- |
| [`starter`](../examples/starter/README.md) | Command and model-callable tool |
| [`lifecycle-events`](../examples/lifecycle-events/README.md) | Event observation and generation disposal |
| [`command-controls`](../examples/command-controls/README.md) | Typed flags, commands, and normalized shortcuts |
| [`tool-rendering`](../examples/tool-rendering/README.md) | Built-in tool replacement and TUI renderers |
| [`input-guard`](../examples/input-guard/README.md) | Interactive input transformation and tool-call blocking |
| [`ui-surfaces`](../examples/ui-surfaces/README.md) | Status, header, widget, and overlay components |
| [`context-compaction`](../examples/context-compaction/README.md) | Prompt transformation, context usage, and compaction |
| [`messages-bus`](../examples/messages-bus/README.md) | In-process topics, custom messages, and message rendering |
| [`model-controls`](../examples/model-controls/README.md) | Current-model inspection and thinking selection |
| [`provider-override`](../examples/provider-override/README.md) | Generation-owned provider replacement |
| [`raw-editor-ui`](../examples/raw-editor-ui/README.md) | Trusted primary-editor replacement through `rigyn/tui` |
| [`session-jsonl`](../examples/session-jsonl/README.md) | Read-only current-session tree inspection |
| [`session-control`](../examples/session-control/README.md) | New, fork, and switch flow controls |
| [`session-metadata`](../examples/session-metadata/README.md) | Session names, custom entries, labels, and entry rendering |
| [`subprocess-workers`](../examples/subprocess-workers/README.md) | Bounded argv-based process delegation |
| [`dynamic-package`](../examples/dynamic-package/README.md) | Runtime-discovered skill and prompt paths |
| [`provider-hooks`](../examples/provider-hooks/README.md) | Provider request plus trusted complete request/response header hooks |
| [`runtime-catalog`](../examples/runtime-catalog/README.md) | Active tools, model selection, command/resource discovery, and user-message delivery |
| [`session-lifecycle`](../examples/session-lifecycle/README.md) | Session guards, compaction, tree events, and navigation |
| [`provider-catalog`](../examples/provider-catalog/README.md) | Custom provider, managed OAuth callbacks, and refreshed catalog |
| [`terminal-workbench`](../examples/terminal-workbench/README.md) | Terminal input, editor helpers, custom themes, and tool expansion |
| [`project-trust`](../examples/project-trust/README.md) | Restricted interactive project-trust decision |

Each example has one `package.json` declaration and one direct factory entry. Combine only the contracts the product actually needs.
