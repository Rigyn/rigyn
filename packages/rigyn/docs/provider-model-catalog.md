# Provider model catalog maintenance

Rigyn's bundled chat-model metadata has one maintained authority:
[`src/providers/maintained-model-catalog.ts`](../src/providers/maintained-model-catalog.ts). It contains 157
conservative fallback entries. Live provider discovery remains authoritative, user configuration overrides a matching
fallback, and omitted fields stay unknown rather than being guessed.

From the repository root, run `npm run generate:provider-models --workspace rigyn` after an intentional catalog
change. The local generator does not use the network. It deterministically emits:

- `packages/rigyn/src/providers/builtin-models.generated.ts` for Rigyn's strict direct-model API;
- `packages/models/src/models.generated.ts` and its provider shards for `@rigyn/models`.

The maintained runtime keeps all 157 sparse entries. The direct APIs require concrete protocol, base URL, pricing,
capability, context, and output-limit fields, so their generated catalog contains only the 11 entries that can be
represented losslessly. Providers without a strict static entry retain their transport, authentication, and live
discovery support; their generated package shards are intentionally empty.

## Validation and projection

`npm run check:provider-models --workspace rigyn` verifies the maintained count, unique `provider/id` keys, provider
ownership, exact strict-projection count, all generated content, and package data hashes. The root `npm run check`
includes this gate.

Protocol and base-URL data comes from Rigyn's provider descriptors. `gemini` is exposed as the canonical public
provider ID `google`; package protocol names use the package's existing API vocabulary. Explicit reasoning efforts are
projected across all seven Rigyn levels, with unsupported levels represented by `null`. Pricing tiers convert an
inclusive `minimumInputTokens` value to the direct API's exclusive `inputTokensAbove` threshold.

Do not fill an omitted limit, price, modality, or capability with a placeholder. Add reviewed metadata to the
maintained entry first, regenerate, and let the strict projection include it only when every required field is present.
