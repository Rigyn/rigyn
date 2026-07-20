# Resource catalog

Rigyn exposes one deterministic metadata snapshot through three public surfaces:

- `HarnessRuntime.resourceCatalog()` for embedding;
- `resources.list` for typed RPC clients;
- `api.getResourceCatalog()` for runtime extensions.

Runtime extensions may also call `api.getDiscoveryView()` for a flattened command, prompt, and skill subset suitable for one picker. That view is derived from the same validated snapshot and carries the corresponding truncation and omitted counts; it does not add callbacks or resource bodies. The focused [`resource-discovery`](../examples/resource-discovery/README.md) package demonstrates this extension view.

Interactive users call `/resources` for a compact report generated from the same service snapshot.

All three delegate to `HarnessService.resourceCatalog()`. The snapshot includes tool schemas and ownership, built-in/runtime/template commands, prompt metadata, skill metadata, themes, provider/model summaries, managed packages, extension status/trust/contribution counts, and diagnostics. Package and extension entries preserve `user`, `project`, and invocation-only scope rather than making temporary `--package` or `--extension` resources look persistent. Declarative project packages additionally expose their credential-free source declaration, deterministic disabled-resource filters, and immutable resolved version/revision/archive/content/manifest digests. Arrays are sorted, entry counts and bytes are bounded, and omitted counts are explicit.

The catalog is discovery metadata, not an execution API. It never contains command or tool callbacks, prompt/template contents, skill instructions, credential values, provider conversation state, model-private metadata, absolute local source paths, or private package staging paths. Blocked or untrusted extensions remain visible with their diagnostics, but their contributed tools, commands, prompts, and themes are not projected.

Consumers should check `schemaVersion` and `bounds.truncated`. A truncated catalog is valid: `bounds.omitted` reports the number of entries omitted from each section. The host validates and clones the complete result whenever it crosses an RPC or extension boundary.
