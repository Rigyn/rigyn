# Public Node.js API policy

rigyn publishes ESM for Node.js 24.15+ and 26+. The supported import boundary is the package `exports` map; paths inside `dist/` are implementation details even when they are physically present in an archive.

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
rigyn/rpc-entry
rigyn/modes
rigyn/net
rigyn/process
rigyn/prompts
rigyn/providers
rigyn/service
rigyn/sdk
rigyn/storage
rigyn/testing
rigyn/tools
rigyn/tui
rigyn/package.json
```

Public subpaths have these stability classes:

| Stability class | Subpaths | Intended use |
| --- | --- | --- |
| Application stable | `rigyn`, `rigyn/embedding`, `rigyn/interfaces`, `rigyn/modes`, `rigyn/sdk` | Task-level embedding, ready-made modes, composition, and RPC clients. Prefer these boundaries for applications. |
| Executable stable | `rigyn/rpc-entry` | Starts the newline-delimited RPC process directly. Importing this entry runs the process; it is not a library namespace. |
| Advanced stable | `rigyn/auth`, `rigyn/config`, `rigyn/context`, `rigyn/core`, `rigyn/extensions`, `rigyn/images`, `rigyn/net`, `rigyn/process`, `rigyn/prompts`, `rigyn/providers`, `rigyn/service`, `rigyn/storage`, `rigyn/tools`, `rigyn/tui` | Low-level composition. These APIs can carry more host authority and require the caller to own lifecycle and invariants. |
| Test stable | `rigyn/testing` | Deterministic fixtures. Supported for tests, but not presented as production provider transports. |
| Metadata stable | `rigyn/package.json` | Package metadata only. |

All five classes are covered by the compatibility rules below; “advanced” and “test” describe scope, not permission for silent breaking changes. No exported subpath is currently experimental. A future experimental entry point must say so in both its public declarations and documentation.

`rigyn/images` contains two deliberately separate surfaces: the clipboard/preprocessing helpers used by chat prompts and the image-generation provider/catalog/registry API. Image generation does not share or mutate the chat provider registry. See [Image generation](image-generation.md) for the credential, failure, retry, and lifecycle contracts.

The machine-readable source of this list is [`release/public-subpaths.json`](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/release/public-subpaths.json), and the release check requires it to exactly match `package.json`.

The package export map above describes ordinary Node.js consumers. Managed extension runtime entries may value-import all 20 code-bearing library entry points: `rigyn`, `rigyn/auth`, `rigyn/config`, `rigyn/context`, `rigyn/core`, `rigyn/embedding`, `rigyn/extensions`, `rigyn/images`, `rigyn/interfaces`, `rigyn/modes`, `rigyn/net`, `rigyn/process`, `rigyn/prompts`, `rigyn/providers`, `rigyn/service`, `rigyn/sdk`, `rigyn/storage`, `rigyn/testing`, `rigyn/tools`, and `rigyn/tui`. The executable `rigyn/rpc-entry` and metadata-only `rigyn/package.json` entries are intentionally excluded from extension imports. rigyn resolves library specifiers to the running host, which keeps one canonical host instance when an installed extension lives outside rigyn's dependency tree. Managed runtimes cannot value-import an unlisted subpath or a deeper internal `rigyn/*` path; type-only authoring imports remain governed by TypeScript and the package export map.

Each JavaScript entry point is ESM-only and Node-only and has a matching TypeScript declaration entry. No entry point is browser-safe. Browser clients should use the local RPC process or a reviewed loopback extension bridge. A browser-safe protocol/types package is a conditional non-goal until a concrete client requires it; do not bundle credential or filesystem authority into browser code.

Adding an export is compatible within a minor release. Removing or renaming an entry point, export, method, required field, or accepted value is a breaking API change. Before 1.0, such a change requires a minor version increase plus a `Breaking` section and migration instructions in the changelog. Patch releases must remain backward compatible. After 1.0, breaking changes require a major version.

The root also exposes a documented set of generic coding-agent aliases and thin adapters. See [Generic coding-agent API compatibility](generic-api-compatibility.md) for the classification and the few deliberate native-contract differences.

Experimental behavior is not exempt merely because its TypeScript type is broad. An API is experimental only when its public documentation and declaration both say so. Deep imports, unpublished source paths, and test helpers outside `rigyn/testing` have no compatibility guarantee.

## Named-export conformance

[`release/public-named-export-inventory.json`](../release/public-named-export-inventory.json) is the fixed compatibility baseline for every named binding on the 20 code-bearing entry points. It classifies each binding as a runtime value or a type-only declaration. Release tests fail on additions, removals, runtime/type classification changes, missing declarations, duplicate names, or an `any`/compiler-error type.

The distribution conformance test imports every entry point from the built package and compares its exact namespace keys with that baseline. It then uses every unique runtime identity: classes are exercised through inheritance (and exported error classes are constructed), constants are read according to their runtime kind, and ordinary functions are invoked in an isolated offline process with bounded settlement. Functions that own sessions, subprocesses, terminal state, keychain probing, or interactive modes instead receive deterministic contract fixtures with asserted results or owned cancellation behavior. The same test asks the TypeScript checker to resolve every runtime and type-only symbol from the built declarations.

This evidence supplements focused behavioral suites; it does not claim that a generic invalid-input probe replaces feature-specific tests. The route-level evidence inventory remains in [`release/public-runtime-export-inventory.json`](../release/public-runtime-export-inventory.json), while the named-export test prevents a public binding from being covered only by a filename or test-title substring.
