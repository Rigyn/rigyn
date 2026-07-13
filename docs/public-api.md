# Public Node.js API policy

Rigyn publishes ESM for Node.js 24.15+ and 26+. The supported import boundary is the package `exports` map; paths inside `dist/` are implementation details even when they are physically present in an archive.

The supported public entry points are:

```text
rigyn
rigyn/auth
rigyn/config
rigyn/context
rigyn/core
rigyn/embedding
rigyn/extensions
rigyn/images
rigyn/interfaces
rigyn/net
rigyn/process
rigyn/prompts
rigyn/providers
rigyn/service
rigyn/storage
rigyn/testing
rigyn/tools
rigyn/tui
rigyn/package.json
```

Public subpaths have these stability classes:

| Stability class | Subpaths | Intended use |
| --- | --- | --- |
| Application stable | `rigyn`, `rigyn/embedding`, `rigyn/interfaces` | Task-level embedding and RPC clients. Prefer these boundaries for applications. |
| Advanced stable | `rigyn/auth`, `rigyn/config`, `rigyn/context`, `rigyn/core`, `rigyn/extensions`, `rigyn/images`, `rigyn/net`, `rigyn/process`, `rigyn/prompts`, `rigyn/providers`, `rigyn/service`, `rigyn/storage`, `rigyn/tools`, `rigyn/tui` | Low-level composition. These APIs can carry more host authority and require the caller to own lifecycle and invariants. |
| Test stable | `rigyn/testing` | Deterministic fixtures. Supported for tests, but not presented as production provider transports. |
| Metadata stable | `rigyn/package.json` | Package metadata only. |

All four classes are covered by the compatibility rules below; “advanced” and “test” describe scope, not permission for silent breaking changes. No exported subpath is currently experimental. A future experimental entry point must say so in both its public declarations and documentation.

The machine-readable source of this list is [`release/public-subpaths.json`](../release/public-subpaths.json), and the release check requires it to exactly match `package.json`.

Each JavaScript entry point is ESM-only and Node-only and has a matching TypeScript declaration entry. No entry point is browser-safe. Browser clients should use the local RPC process or a reviewed loopback extension bridge. A browser-safe protocol/types package is a conditional non-goal until a concrete client requires it; do not bundle credential or filesystem authority into browser code.

Adding an export is compatible within a minor release. Removing or renaming an entry point, export, method, required field, or accepted value is a breaking API change. Before 1.0, such a change requires a minor version increase plus a `Breaking` section and migration instructions in the changelog. Patch releases must remain backward compatible. After 1.0, breaking changes require a major version.

Experimental behavior is not exempt merely because its TypeScript type is broad. An API is experimental only when its public documentation and declaration both say so. Deep imports, unpublished source paths, and test helpers outside `rigyn/testing` have no compatibility guarantee.
