# Package authoring and local gallery

An extension package can be rooted at an explicit `extension.json` or use the npm convention described below. Start by copying [`examples/package-starter`](../examples/package-starter/README.md), keep the package focused, and add only the manifest contributions and runtime authority that the workflow needs.

The tested [extension capability matrix](extension-capabilities.md) maps each public authoring surface to its supported hosts, documentation, examples, and conformance tests.

For agent-assisted work, run `/build-extension <request>` in the TUI. The bundled authoring skill requires a user-visible acceptance contract, routes to the smallest relevant example, verifies APIs against this installed version, and finishes through focused tests plus the normal install/reload/remove path. It has a dedicated local-dashboard checklist, so browser requests are evaluated as session products rather than static page scaffolds.

## Local gallery

The repository examples below are protocol references, not preinstalled optional products. Public package discovery uses the strict metadata contract in [Package discovery index](package-gallery.md); installation still goes through this package manager.

| Example | What it demonstrates | Network or credential requirement |
| --- | --- | --- |
| [Package starter](../examples/package-starter/README.md) | Minimal manifest, runtime entry, slash command, and startup status | None |
| [Custom tool](../examples/custom-tool/README.md) | Narrow tool schema and deterministic model-visible observation | None |
| [Custom provider](../examples/custom-provider/README.md) | Provider-neutral streaming adapter and model catalog | None |
| [Brokered provider](../examples/brokered-provider/README.md) | Exact-origin authenticated requests without exposing credentials | Provider API when adapted |
| [Session notes](../examples/session-notes/README.md) | Durable namespaced state, interactive editor, and restart-safe renderer | None |
| [State migration](../examples/state-migration/README.md) | Append-only schema migration with compare-and-append and old renderers | None |
| [Tool lifecycle](../examples/tool-lifecycle/README.md) | Scoped tool-call guard and tool-result transform | None |
| [Custom compaction](../examples/custom-compaction/README.md) | Bounded deterministic compaction override and completion event | None |
| [Dynamic tools](../examples/dynamic-tools/README.md) | Session-local active-tool loader applied at provider-turn boundaries | None |
| [MCP stdio](../examples/mcp-stdio/README.md) | Fixed external MCP process, protocol handshake, bounds, cancellation, and disposal | Local child process |
| [Reference package](../examples/reference-package/README.md) | Integrated tool, provider, command, shortcut, flag, events, state, skill, prompt, and theme | None |
| [Shared events](../examples/shared-events/README.md) | Bounded JSON coordination between two in-process runtime entries | None |
| [Reload safety](../examples/reload-safety/README.md) | Candidate-first repeated activation, rollback probe, and disposal | None |
| [Custom overlay](../examples/custom-overlay.mjs) | Focused structural TUI component | None |

Install a local example from its own directory, inspect it, and remove it when finished. Examples live under `examples/` in a source checkout and under `~/.rigyn/app/node_modules/rigyn/examples/` in the default self-contained install; replace `~/.rigyn` with a custom `RIGYN_INSTALL_DIR`. This form works from either location:

```sh
rigyn install .
rigyn list
rigyn extensions show custom-tool-example
rigyn extensions doctor
rigyn remove custom-tool-example
```

Use `-l` on package commands for a trusted project-scoped install. User-scope installation is the safer default for a package you want in several workspaces.

## Sources and one-run packages

Managed installs accept local directories, registry packages, local npm archives, and Git repositories:

```sh
rigyn install ./my-package
rigyn install npm:@example/harness-tools@1.2.3
rigyn install git:https://github.com/example/harness-tools.git#v1
rigyn install ssh://git@github.com/example/harness-tools.git#v1
rigyn install git:git@github.com:example/harness-tools.git#v1
```

Git refs may follow `#` or the repository path's final `@`; provenance normalizes them to `#`. HTTPS sources must not embed credentials. SSH sources use the user's SSH configuration, keys, and agent in non-interactive batch mode. They never fall back to password prompts. Local and remote packages are copied into a private managed directory, so later source edits do not silently change an active package.

Use repeatable `--package` flags to try complete packages without changing user or project installation state:

```sh
rigyn --package npm:@example/harness-tools -p "Use the package to inspect this project"
rigyn --package ./my-package
```

Temporary packages contribute runtime extensions, skills, prompts, and themes for that process. They are removed when the runtime closes. `--extension` remains the lighter option for a single local `.ts`, `.mts`, `.js`, or `.mjs` entry.

## Trusted project declarations and immutable locks

A project may declare a repeatable package set in `.rigyn/packages.json`. The file is ignored—without parsing or fetching—until the exact workspace is trusted. Sources use an explicit schema rather than command-line source strings:

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "id": "review-tools",
      "source": { "kind": "npm", "package": "@example/review-tools", "selector": "^2.0.0" },
      "disabledResources": ["command:dangerous-command"]
    },
    {
      "id": "git-tools",
      "source": { "kind": "git", "repository": "https://example.com/git-tools.git", "ref": "main" }
    },
    {
      "id": "local-tools",
      "source": { "kind": "local", "path": "packages/local-tools" }
    }
  ]
}
```

Local paths must be normalized, workspace-relative, real directories outside `.rigyn`, and contained by the workspace boundary. Git repositories must be credential-free HTTPS or SSH remotes. npm declarations accept registry package names and selectors. Filters are deterministic disabled-resource keys: `runtime:`, `skill:`, `prompt:`, `command:`, or `theme:`. They are combined with `packageResources` filters; neither source can silently re-enable a resource disabled by the other.

Use three explicit operations:

```sh
rigyn packages check
rigyn packages update --all     # intentionally resolve every moving source
rigyn packages update NAME      # intentionally resolve selected declarations
rigyn packages reconcile        # install only the existing immutable lock
```

`update` resolves sources in private staging, validates manifests and host compatibility, records exact npm versions plus archive digests, exact Git revisions, local/source content digests, and manifest digests in `.rigyn/packages.lock.json`, then commits the installed set and lock with rollback. A partial update reuses a lock entry only when that entry's declaration is byte-for-byte canonical-equivalent; new or changed unrelated declarations require their own update or `--all`.

Normal startup and `/reload` reconcile a trusted declaration only from its existing lock. A healthy installed copy is left untouched, so local edits, tags, ranges, and branches are never followed implicitly. A missing or changed installed copy is rebuilt from the exact locked npm version or Git revision and verified against its digests; a changed local source fails closed until an intentional update. The complete declarative set lives under `.rigyn/packages`, separate from imperative project installs under `.rigyn/extensions`, and is swapped atomically. Interrupted transactions recover the old set unless the new lock was durably committed.

Declarative reconciliation never enables dependency lifecycle scripts. Use an imperative, separately reviewed transaction when a dependency requires `--allow-scripts`. Lock and catalog metadata contain no absolute local path, registry token, HTTPS credential, or SSH secret. The resource catalog exposes safe declaration, filter, lock, and provenance metadata without exposing private staging paths.

## npm convention packages

An npm-oriented package may omit `extension.json`. Rigyn then derives a strict manifest from `package.json`. With no `rigyn` object, these directories are discovered by convention when present:

```text
extensions/   .ts, .mts, .js, and .mjs runtime entries (excluding .d.ts)
skills/       skill roots containing SKILL.md, or declared Markdown skills
prompts/      Markdown prompt templates
themes/       JSON theme definitions
```

Use `rigyn` when the packed artifact needs explicit paths, globs, exclusions, or a host compatibility range:

```json
{
  "name": "@example/review-tools",
  "version": "1.2.3",
  "type": "module",
  "files": ["dist", "skills", "prompts"],
  "rigyn": {
    "hostVersion": ">=0.1.0 <0.2.0",
    "extensions": ["dist/extensions"],
    "skills": ["skills", "!skills/internal/**"],
    "prompts": ["prompts/*.md"],
    "themes": []
  },
  "peerDependencies": {
    "rigyn": ">=0.1.0 <0.2.0"
  }
}
```

The only accepted `rigyn` keys are `extensions`, `skills`, `prompts`, `themes`, and `hostVersion`; unknown keys fail installation. Resource fields are arrays of package-relative paths or globs. `!` or `-` removes matches and `+` explicitly adds them. Paths cannot be absolute or escape the package root. Declaring a field replaces discovery for that resource type, so an empty array intentionally disables it. Runtime selection accepts only JavaScript or TypeScript entries, skills resolve to `SKILL.md` roots or declared Markdown files, prompts accept Markdown, and themes accept validated JSON definitions.

Runtime modules receive the host API during activation and should not import a separate agent SDK. For TypeScript authoring, use type-only imports from `rigyn/extensions`, keep `rigyn` as a development/peer dependency rather than bundling another runtime copy, and publish compiled JavaScript unless the documented scoped TypeScript transform is sufficient. Always inspect `npm pack --dry-run` and test the exact archive: files omitted by `files` or `.npmignore` do not exist after installation.

Runtime modules that need durable files use the host-created `api.dataPaths.user` or `api.dataPaths.workspace` directory. Installed builds keep these roots under harness state rather than inside the package, so an upgrade cannot overwrite them. Package removal currently leaves owned data intact for a later reinstall; remove it explicitly only as a separate user-approved data operation. These paths are not a credential store.

The starter ships an installation-safe public-loader test. From `examples/package-starter` run:

```sh
node --test activation.test.mjs
rigyn --package . --offline --list-models
```

A copied package must make its documented local test command work from a normal shell. A public-loader test may import `rigyn/extensions` only when the host is a resolvable development dependency; it must not rely on `RIGYN_INSTALL_DIR` or other process-local installation variables. When the host package is intentionally not installed into the extension project, keep unit tests dependency-free and use `rigyn --package . --offline --list-models` plus the managed install/reload/remove flow for loader verification.

Package `dependencies`, `optionalDependencies`, and `peerDependencies` are installed into that package's private module tree. Development dependencies are unavailable at runtime. Dependency lifecycle scripts and npm bin links are disabled by default. After reviewing every production dependency, opt in for one install, update, or invocation-only package transaction:

```sh
rigyn install npm:@example/reviewed-native-tools --allow-scripts
rigyn update reviewed-native-tools --allow-scripts
rigyn --package npm:@example/reviewed-native-tools --allow-scripts
```

The opt-in is not saved. npm runs only against a synthetic staged dependency workspace with the same sanitized environment, timeout, and output bounds used by the default installer. Generated `.bin` links remain in staging and are not copied into the active package. Source-package scripts such as `prepare`, `prepack`, and `postpack` are always disabled; `--allow-scripts` enables only production dependency lifecycle scripts.

Set package-manager wrappers as argv arrays in configuration. No shell parses these values:

```jsonc
{
  "npmCommand": ["mise", "exec", "node@24", "--", "npm"],
  "gitCommand": ["/usr/bin/git"]
}
```

On Windows, use a native executable or invoke a JavaScript wrapper through `node.exe`; `.cmd` and `.bat` package-manager wrappers are rejected rather than passed through `cmd.exe`.

Exact npm versions and full Git commit IDs are immutable pins. `update --all` reports and skips them; provide a new source to `update PACKAGE_ID SOURCE` when intentionally changing a pin. Moving npm tags/ranges, Git branches/tags, and local sources remain updateable.

Deliberate interoperability limits are explicit: Git submodules and Git LFS are not materialized; SSH authentication must succeed non-interactively; dependency specs must be registry versions, tags, or ranges; pre-bundled `node_modules`, npm aliases, and workspace/file/Git dependencies are rejected. Lifecycle-dependent production dependencies require the explicit per-transaction `--allow-scripts` opt-in. Runtime entries may be JavaScript or TypeScript. The scoped transform loader supports ordinary package TypeScript, including enums, parameter properties, relative modules, and CJS/ESM interop, but it does not type-check. Project-specific transforms such as JSX, legacy decorators, or compiler path aliases must be compiled into a self-contained published artifact. The default npm subprocess does not inherit registry tokens or the user's npmrc; a configured wrapper may broker private-registry access without exposing credentials to the harness.

## Compatibility and versions

- `extension.json` currently requires `schemaVersion: 1`. Unknown manifest fields fail validation instead of being ignored.
- Give every released package a `version`, preferably SemVer. The manifest parser accepts a bounded version identifier, so SemVer discipline is the author's responsibility.
- Declare the supported host range in `extension.json`. Incompatible packages fail before any runtime entry is imported:

  ```json
  {
    "compatibility": { "hostVersion": ">=0.1.0 <0.2.0" }
  }
  ```

  Convention packages may put the same range at `package.json` → `rigyn.hostVersion`.
- Treat a runtime API change as a compatibility boundary. Keep an offline activation or round-trip test so incompatibility is visible before release.
- Use stable tool, provider, command, state-key, and schema names. When durable state changes shape, register a new session-state schema version and retain a renderer for old records.

## Integrity and provenance

The optional manifest `integrity` object maps normalized package-relative paths to lowercase SHA-256 digests:

```json
{
  "integrity": {
    "runtime/index.mjs": "<64 lowercase hexadecimal characters>"
  }
}
```

At release time, include every executable runtime entry and every declarative file whose exact bytes matter. A declared mismatch makes the extension invalid. Recompute hashes only after reviewing the final release contents.

Integrity detects changed bytes; it does not prove who authored a package. Managed npm installs additionally record the resolved package version and archive digest, Git installs record the resolved revision, and all managed installs record source and manifest provenance. `rigyn list` reports a locally modified managed manifest. Keep a release tag or registry version immutable so that provenance remains meaningful.

## Trust checklist

Runtime extensions are ordinary trusted Node.js modules. They have the invoking user's filesystem, process, environment, and network access; the runtime API is an authoring contract, not a sandbox. Provider credentials remain behind the host-owned `api.auth.fetch` request broker and are not returned to extension code. Host validation and redaction reduce accidental disclosure through harness-managed output and persistence, but they cannot contain malicious extension code or prevent it from reading other data available to the invoking process. Before installation:

1. Read `extension.json`, every runtime entry, and production dependency declaration. Before using `--allow-scripts`, also inspect the resolved dependency lifecycle scripts and native build chain.
2. Confirm that tool schemas are closed and narrow, commands use argv execution rather than shell interpolation, and outputs are bounded.
3. Confirm that provider network access uses narrow exact origins through `api.auth.fetch`, without duplicate global fetches or caller-supplied authorization headers.
4. Confirm that durable entries use only the extension namespace and that renderers depend on stored data rather than process memory.
5. Run the package's offline tests, install it in a disposable user or project scope, exercise failure and cancellation paths, and inspect `rigyn extensions doctor`.

Project runtime code remains blocked until the workspace is trusted. User and explicit runtime extensions are trusted by the person loading them. Production dependencies execute as code too, so fewer dependencies reduce review and supply-chain surface.

## Release checklist

1. Validate a clean copy with `rigyn install ./path/to/package`, `rigyn list`, `rigyn extensions show PACKAGE_ID`, and `rigyn extensions doctor`.
2. Test activation, reload, cancellation, malformed input, duplicate registration, session restart, and uninstall where applicable.
3. Update the package version, compatibility statement, and integrity digests together.
4. Pack only required files and inspect the archive before publishing or tagging it.
5. Install that exact archive or tag once, run its documented smoke test, then publish it immutably.

The developer CLI automates the repeatable parts without installing into user or project package roots:

```sh
rigyn extensions author report .
rigyn extensions author pack . ./artifacts
```

See [Package discovery index](package-gallery.md) for the exact check semantics and public metadata schema.

See [Extensions](extensions.md) for the complete manifest and runtime API and [Extension TUI](tui.md) for structural interactive components.
