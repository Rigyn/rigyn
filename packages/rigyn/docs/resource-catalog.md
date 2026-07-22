# Resource catalog

`buildHarnessResourceCatalog()` is the public low-level projection helper exported by `rigyn` and `rigyn/service`. A host supplies its current tools, ownership lookup, skills, providers, runtime commands, extension catalog, package records, and diagnostics. The helper returns one deterministic, callback-free `HarnessResourceCatalog`. `parseHarnessResourceCatalog()` validates and detaches a catalog received across an application boundary.

The full catalog is not currently a method on `HarnessRuntime`, `EmbeddingHarness`, or the RPC protocol. Applications that own the required source objects build it explicitly. Direct extensions call `rigyn.getCommands()` for the ordered invokable extension-command, prompt-template, and skill-command list, or `rigyn.getDiscoveryView()` for a richer bounded metadata snapshot. They may contribute package-relative skills, prompts, and custom themes through the `resources_discover` event. The focused [`dynamic-package`](../examples/dynamic-package/README.md) demonstrates that contribution path.

Interactive `/resources` is a compact status report for the active extension bundle. It is not a serialized `HarnessResourceCatalog` and should not be parsed as one.

## Full catalog contract

The full projection can include tool schemas and ownership, built-in/runtime/template commands, prompt metadata, skill metadata, custom themes, provider/model summaries, managed packages, extension status/trust/contribution counts, and diagnostics. Package and extension entries preserve `user`, `project`, and invocation-only scope rather than making temporary `--extension` resources look persistent. Declarative project packages can additionally expose their credential-free source declaration, deterministic disabled-resource filters, and immutable resolved version/revision/archive/content/package digests.

Arrays are sorted, entry counts and bytes are bounded, and omitted counts are explicit. Consumers must check `schemaVersion` and `bounds.truncated`. A truncated catalog is valid: `bounds.omitted` reports the number of entries omitted from each section.

The catalog is discovery metadata, not an execution API. It never contains command or tool callbacks, prompt/template contents, skill instructions, credential values, provider conversation state, model-private metadata, absolute local source paths, or private package staging paths. Blocked or untrusted extensions remain visible with their diagnostics, but their contributed tools, commands, prompts, and custom themes are not projected.

Validate untrusted or persisted data with `parseHarnessResourceCatalog()` before use. The parser rejects unknown fields, invalid bounds, inconsistent omitted counts, and callback-bearing or otherwise non-data values.
