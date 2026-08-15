# @rigyn/models

`@rigyn/models` is rigyn's standalone provider layer. It provides canonical model and message types, streaming transports, authentication and OAuth contracts, model catalogs, token and cost accounting, image-generation primitives, and provider-neutral diagnostics.

The package does not depend on the agent runtime or terminal UI. Provider SDK and wire-protocol details stop at this boundary. Consumers receive one normalized event stream.

![rigyn package dependency layers](assets/package-layers.svg)

## Model collection

Create a collection, register the providers your application needs, then resolve available models:

```ts
import { createModels } from "@rigyn/models";
import { openaiProvider } from "@rigyn/models/providers/openai";

const models = createModels({ credentials });
models.setProvider(openaiProvider());

const available = await models.getAvailable("openai");
const model = available[0];
if (!model) throw new Error("No authenticated OpenAI model is available");

const stream = models.streamSimple(model, {
  systemPrompt: "Answer concisely.",
  messages: [{ role: "user", content: "Inspect this project", timestamp: Date.now() }],
}, {
  reasoning: "medium",
  cacheRetention: "short",
});

for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

const message = await stream.result();
```

`Models` owns provider selection, credential resolution, model refresh, authentication checks, and completion helpers.

`MutableModels` also supports provider registration, replacement, and removal. `createProvider()` can route different models through different protocol implementations without guessing from model names.

Text-model metadata keeps three limits distinct: `contextWindow` is the total context window, optional
`maxInputTokens` is an independently published prompt ceiling, and `maxTokens` is the maximum generated output.
Consumers must not infer a missing input or output ceiling; live provider metadata or a reviewed host catalog can
supply one when the service publishes it.

## Canonical stream contract

All text providers emit `AssistantMessageEvent` values:

- `start`;
- text and thinking `*_start`, `*_delta`, and `*_end` events;
- tool-call `toolcall_start`, `toolcall_delta`, and `toolcall_end` events;
- one terminal `done` or `error` event.

`AssistantMessageEventStream.result()` resolves to the final assistant message represented by the event sequence.
Tool-call deltas are the authoritative argument fragments; their in-progress `partial` arguments remain empty until `toolcall_end` supplies the parsed final value.

In-progress snapshots use `stopReason: "pending"` until the provider establishes an outcome. A terminal `done` or `error` event must replace it with `stop`, `length`, `toolUse`, `error`, or `aborted`.

Provider-specific continuation material stays in `providerState`. Replay it only through a compatible API, provider, and model boundary.

Usage can report uncached input, output, optional provider cache-read and cache-write counters, one-hour cache writes, reasoning tokens, totals, and calculated cost. An omitted cache counter remains unavailable; a reported zero remains zero. A transport can report a response model or response ID without changing the caller's selected model.

## Provider transports

Built-in factories are limited to `openai-codex`, `openai`, `anthropic`, `google`, `openrouter`, `github-copilot`, `xai`, `deepseek`, `kimi-code`, `ollama`, `opencode`, and `opencode-go`. They are independent of static model rows. OpenCode Go accepts a distinct `OPENCODE_GO_API_KEY` first and the official shared `OPENCODE_API_KEY` environment fallback second; stored credential identity remains caller-owned. Direct Moonshot and OpenCode Kimi Chat requests deep-copy tool schemas and add explicit property types required by Moonshot's wire validator without mutating caller schemas or changing other model routes. OpenCode Go's mixed-protocol model selection is owned by rigyn's routed runtime, so the direct package shard is intentionally empty. The bundled direct catalog contains only entries with complete representable metadata. Providers with sparse or routed fallback metadata rely on caller-owned or live discovery.

Generic transport modules remain available from `@rigyn/models/api/*` for applications and extensions that own authentication and model discovery. A public protocol transport does not make a service a built-in provider.

The direct Bedrock Converse transport preserves user text/image block order and accepts PNG, JPEG, GIF, and WebP images as canonical base64. Consecutive tool results are emitted together with their tool-use IDs, ordered text/images, and success or error status. A request is limited to 20 images and each decoded image to 3.75 MiB; unsupported media types or malformed data fail before the SDK request is sent.

Stream options include:

- `AbortSignal`, request timeout, WebSocket connect and response-idle timeouts, bounded retry count, and a server-requested retry-delay ceiling (`0` removes the ceiling);
- provider-native HTTP streaming; generic OpenAI Responses supports strict WebSocket modes and `auto` pre-output HTTPS/SSE fallback, while the ChatGPT Codex subscription route remains SSE-only;
- cache retention and reasoning level;
- session affinity and provider metadata;
- request-payload and response-diagnostic hooks;
- case-insensitive header overrides with explicit deletion through `null`.

Request hooks must not retain credentials. Response hooks receive status and normalized headers. A higher-level host must redact diagnostics before forwarding them to untrusted code.

Responses retry and fallback gates treat valid empty lifecycle placeholders as metadata-only. Text, refusal, reasoning, tool state, and malformed, opaque, or unknown output state close the replay gate.

Tools can declare provider-neutral `constrainedSampling`. A JSON-schema constraint uses `"prefer"` fallback or `"require"` fail-closed behavior.

Grammar constraints can provide `openai_lark` or `openai_regex` for a route whose model metadata explicitly supports grammar tools. Unsupported routes keep the ordinary function schema. Grammar calls use one required string property, allowing streamed native input to return to the canonical tool-call shape.

## Deterministic test provider

The root export includes Faux helpers for deterministic, scripted local responses and synthetic offline test events. Faux makes no external model request, uses no subscription or authentication, and is not intended to be selected or presented as a real provider.

## Assistant-call retries

`retryAssistantCall()` is available from the side-effect-free root export for hosts that receive a final `AssistantMessage` on every provider attempt:

```ts
import {
  retryAssistantCall,
  type AssistantMessage,
  type RetryCallbacks,
  type RetryPolicy,
} from "@rigyn/models";

declare const produce: () => Promise<AssistantMessage>;
declare const signal: AbortSignal;

const policy: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
};
const callbacks: RetryCallbacks = {
  onRetryScheduled(attempt, maxAttempts, delayMs, errorMessage) {
    console.error({ attempt, maxAttempts, delayMs, errorMessage });
  },
};

const message = await retryAssistantCall(produce, policy, signal, callbacks);
```

`maxRetries` counts attempts after the first call. Only transient retryable errors are replayed. Quota and usage-limit failures return immediately.

Backoff is exponential and callbacks can be asynchronous. An `aborted` response returns immediately. Aborting during a retry delay returns an `aborted` clone without the earlier transient `errorMessage`. A missing or disabled policy calls the producer once and does not invoke retry callbacks.

## Authentication and OAuth

Providers declare API-key and OAuth methods. Credentials are resolved through an injected `CredentialStore` and `AuthContext`. The library does not require a particular application data directory.

```ts
const check = await models.checkAuth("openai");
if (!check) {
  await models.login("openai", "api_key", interaction);
}
```

OAuth refresh uses an atomic credential-store modification, so concurrent callers do not overwrite one another. Failed or cancelled login does not save a partial credential. Environment discovery is explicit and replaceable in tests or embedded hosts.

The library does not ship a credential-persisting CLI or a default disk credential store. Hosts inject a `CredentialStore`; the rigyn application selects its platform-backed credential broker. Start `rigyn` and use `/login [PROVIDER]` for interactive sign-in.

Earlier development builds may have created `~/.rigyn/models/oauth.json`. Current package builds never read, migrate, or delete that plaintext file. Reauthenticate through rigyn, verify the new login, and then deliberately remove the legacy file rather than restoring it into a new installation.

## Custom providers

`createProvider()` accepts a fixed catalog, optional dynamic refresh, authentication methods, filtering, headers, and either one transport or a map keyed by protocol. One provider ID can therefore route explicit model metadata to different transports.

Custom model IDs and provider IDs remain valid through the open string unions. Consumers should still validate remote catalog data before registration.

## Images

Image generation has separate model, request, result, registry, and provider interfaces. Text-streaming assumptions do not leak into image APIs.

Import image registration through the documented image subpaths. The side-effect-free root does not register optional implementations.

## Package boundaries

- `@rigyn/models` — canonical types, models, authentication contracts, utilities;
- `@rigyn/models/providers/*` — provider factories and catalogs;
- `@rigyn/models/api/*` — protocol transports;
- `@rigyn/models/oauth` — OAuth helpers;
- `@rigyn/models/compat` — explicit compatibility registration;
- `@rigyn/models/bedrock-provider` — optional Bedrock protocol transport for caller-owned providers;
- `@rigyn/models/bun-oauth` — Bun OAuth support.

The root export is side-effect free. Optional registration lives in explicit subpaths so applications can control startup work and dependency loading.
