# Provider model catalog maintenance

rigyn's bundled chat-model metadata has one maintained authority:
[`src/providers/maintained-model-catalog.ts`](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/src/providers/maintained-model-catalog.ts) contains the reviewed fallback entries.

Live provider discovery remains authoritative. User configuration overrides a matching fallback. Omitted fields stay unknown instead of being guessed.

Execution is still bounded when a selected model omits or reports malformed context metadata: rigyn uses a conservative 128,000-token context window internally without inserting that value into the registry, picker, session metadata, or statistics. Reviewed or live maximum-input ceilings independently constrain the provider projection, including when a caller supplies an explicit total context window. Reviewed or live output ceilings clamp explicit requests and remain enforced after completion. Provider limits that are genuinely dynamic or unpublished stay unknown instead of being inferred.

Generation is closed over the 12 built-in provider identities documented in [Providers and authentication](providers.md). A provider shard can be empty when its catalog is routed or entirely live, such as OpenCode Go or local Ollama discovery. Generic protocol transports and extension-registered providers are not default catalog providers.

After an intentional catalog change, run this command from the repository root:

```sh
npm run generate:provider-models --workspace rigyn
```

The generator is local, deterministic, and offline. It emits:

- `packages/rigyn/src/providers/builtin-models.generated.ts` for rigyn's strict direct-model API;
- `packages/models/src/models.generated.ts` and its provider shards for `@rigyn/models`.

The maintained runtime keeps every reviewed sparse entry. The direct APIs require concrete protocol, base URL, pricing, capability, context, and output-limit fields. Their generated catalog therefore contains only entries that can be represented without guessing.

Providers without a strict static entry still retain transport, authentication, and live discovery support. Their generated package shards are intentionally empty.

OpenCode Go is a routed provider: reviewed maintained metadata supplies each active model's protocol and fallback facts, while its authenticated `/zen/go/v1/models` response is an availability filter. A new live ID is excluded until its protocol metadata is reviewed; a deprecated maintained-source ID is not retained merely because a bare listing still reports it.

## Validation and projection

`npm run check:provider-models --workspace rigyn` verifies:

- a nonempty maintained catalog;
- unique `provider/id` keys and provider ownership;
- a nonempty strict projection;
- all generated content and package data hashes.

The root `npm run check` includes this gate.

Protocol and base-URL data comes from rigyn's provider descriptors. `gemini` is exposed as the canonical public provider ID `google`. Package protocol names use the package's existing API vocabulary.

Explicit reasoning efforts are projected across all seven rigyn levels; unsupported levels become `null`. Pricing tiers convert an inclusive `minimumInputTokens` value to the direct API's exclusive `inputTokensAbove` threshold.

Do not fill an omitted limit, price, modality, or capability with a placeholder. Add reviewed metadata to the maintained entry first, regenerate, and let the strict projection include it only when every required field is present.
