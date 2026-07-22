# @rigyn/models

`@rigyn/models` is Rigyn's standalone provider layer. It supplies canonical model and message types, streaming transports, authentication and OAuth contracts, strict maintained-model projections, cost and token accounting, image-generation primitives, and provider-neutral diagnostics.

The package has no dependency on the coding agent or terminal UI. Provider SDKs and wire protocols stop at this boundary; consumers receive one normalized event stream regardless of the selected transport.

## Model collection

Create a collection, register only the providers the application needs, then resolve available models through the collection:

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
  messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
}, {
  reasoning: "medium",
  cacheRetention: "short",
});

for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

const message = await stream.result();
```

`Models` owns provider selection, credential resolution, model refresh, authentication checks, and completion helpers. `MutableModels` additionally supports provider registration, replacement, and removal. A provider may route different models through different APIs by supplying an implementation map to `createProvider()`.

## Canonical stream contract

All text providers emit `AssistantMessageEvent` values:

- `start`;
- text and thinking `*_start`, `*_delta`, and `*_end` events;
- tool-call `toolcall_start`, `toolcall_delta`, and `toolcall_end` events;
- one terminal `done` or `error` event.

`AssistantMessageEventStream.result()` resolves to the same final assistant message represented by the event sequence. Provider-specific continuation material is kept in `providerState` and must be replayed only to the same API, provider, and model boundary.

Usage reports uncached input, output, cache reads, cache writes, optional one-hour cache writes, reasoning tokens, totals, and calculated cost. A transport may report a response model or response ID without changing the caller's selected model.

## Provider transports

Built-in factories cover the maintained provider set independently of static model rows. The bundled direct catalog contains only entries with complete representable metadata; providers with sparse fallback metadata rely on caller-owned or live discovery. Transport modules are also available directly from `@rigyn/models/api/*` for applications that already own authentication and model discovery.

Stream options include:

- `AbortSignal`, request timeout, bounded retry count, and retry-delay ceiling;
- SSE, WebSocket, cached WebSocket, or automatic transport selection where supported;
- cache retention and reasoning level;
- session affinity and provider metadata;
- request-payload and response-diagnostic hooks;
- case-insensitive header overrides with explicit deletion through `null`.

Request hooks must not retain credentials. Response hooks receive status and normalized headers; higher-level hosts are responsible for redaction before forwarding diagnostics to untrusted extensions.

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

`maxRetries` counts attempts after the initial call. Only retryable transient error messages are replayed; quota and usage-limit failures return immediately. Backoff is exponential and callbacks may be asynchronous. An `aborted` producer response returns immediately; aborting during a retry delay returns an `aborted` clone without carrying the earlier transient `errorMessage`. An absent or disabled policy delegates once and does not invoke retry callbacks.

## Authentication and OAuth

Providers declare API-key and OAuth methods. Credentials are resolved through an injected `CredentialStore` and `AuthContext`; the library does not require a particular application data directory.

```ts
const check = await models.checkAuth("openai");
if (!check) {
  await models.login("openai", "api_key", interaction);
}
```

OAuth refresh uses an atomic credential-store modification so concurrent callers do not overwrite one another. Failed or cancelled login does not save a partial credential. Environment discovery is explicit and can be replaced for tests or embedded environments.

The package also publishes a standalone OAuth helper:

```text
rigyn-models list
rigyn-models login [provider]
rigyn-models --help
```

Only providers with an OAuth flow are listed or accepted. Omitting the provider opens an interactive selection. Text, secret, manual-code, provider-choice, browser, and device-code interactions are supported.

Standalone credentials are stored in `~/.rigyn-models/oauth.json` by default. Set `RIGYN_MODELS_AUTH_FILE` to an absolute path to select another file. `RIGYN_AI_AUTH_FILE` remains a lower-precedence compatibility fallback; when both are present, `RIGYN_MODELS_AUTH_FILE` wins. With neither variable set, a valid legacy `~/.rigyn-ai/oauth.json` store is migrated once without overwriting an existing new store. Concurrent identical migrations converge on the same verified file. This store is deliberately separate from the coding agent's credential broker: the helper refuses both the default broker path and a broker path selected through `RIGYN_CODING_AGENT_DIR`. The helper writes atomically to an owner-only regular file on POSIX systems, uses the containing user's inherited ACL on Windows, and rejects malformed files, symbolic links, unsafe parent directories, and permissive POSIX modes. It never prints access or refresh tokens.

Exit status is `0` for success, `1` for an authentication or storage failure, `2` for invalid usage, and `130` for cancellation.

## Custom providers

`createProvider()` accepts a fixed catalog, optional dynamic refresh, authentication methods, filtering, headers, and either one transport or a map keyed by API protocol. This permits a single provider ID to route explicit model metadata to different transports without guessing from model names.

Custom model IDs and provider IDs remain valid through the open string unions. Consumers should still validate remote catalog data before registration.

## Images

Image generation has separate model, request, result, registry, and provider interfaces so text streaming assumptions do not leak into image APIs. Import image registration intentionally through the documented image subpaths; the side-effect-free root does not register optional implementations.

## Package boundaries

- `@rigyn/models` — canonical types, models, authentication contracts, utilities;
- `@rigyn/models/providers/*` — provider factories and catalogs;
- `@rigyn/models/api/*` — protocol transports;
- `@rigyn/models/oauth` — OAuth helpers;
- `@rigyn/models/compat` — explicit compatibility registration;
- `@rigyn/models/bedrock-provider` — Bedrock-specific integration;
- `@rigyn/models/bun-oauth` — Bun OAuth support.

The root export is side-effect free. Optional registration lives in explicit subpaths so applications can control startup work and dependency loading.
