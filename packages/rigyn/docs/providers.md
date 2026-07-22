# Providers and authentication

rigyn owns the provider adapters and normalizes their streaming events, tool calls, reasoning, usage, cache accounting, errors, and continuation state into one agent contract. Exact-pinned official SDKs act only as transport adapters where a supported protocol uses them, including OpenAI and compatible routes, Anthropic API-key calls, AWS Bedrock, Google Gemini and Vertex, and Mistral. Provider-specific OAuth, subscription, and local transports that do not use those adapters stay within rigyn. In every case rigyn retains request bounds, retry policy, event normalization, and agent-loop ownership.

Image generation uses a separate model and provider surface so an image-only route cannot appear in the chat model picker. `rigyn/images` currently ships an OpenRouter image catalog, broker-compatible authentication, and a lazy SDK transport with bounded retries and responses. See [Image generation](image-generation.md) for the public API and custom-provider contract.

## Provider adapters

| Provider ID | Protocol | Authentication choices |
| --- | --- | --- |
| `openai` | Responses API | API key or environment credential |
| `openai-codex` | ChatGPT subscription Responses transport | browser or device OAuth |
| `anthropic` | Messages API | API key, environment credential, or Claude Pro/Max OAuth |
| `github-copilot` | Copilot chat | GitHub device OAuth or token |
| `gemini` | Interactions or Generate Content | API key, bearer token, or Google application default credentials |
| `vertex` | Vertex Generate Content | Google application default credentials or bearer token |
| `azure-openai` | Azure Responses | API key or Azure default credential |
| `bedrock` | Converse | AWS default credential chain or bearer token |
| `openrouter` | OpenRouter chat | API key or browser OAuth |
| `mistral` | conversations | API key |
| `ollama` | Ollama chat | no credential for loopback; bearer token for remote hosts |
| `llama.cpp` | llama.cpp router with OpenAI-compatible chat | no credential for loopback; `LLAMA_API_KEY` for remote routers |
| configured `gateway-messages` | discovered message gateway | API key, bearer token, or a custom OAuth method bound to the configured provider ID |
| `xai` | exact per-model Responses or Chat Completions route | SuperGrok/X Premium device OAuth, API key, or `XAI_API_KEY` |
| `vercel-ai-gateway` | Messages-compatible gateway | `AI_GATEWAY_API_KEY` |
| `qwen-token-plan` | Qwen Token Plan global Chat Completions | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-token-plan-cn` | Qwen Token Plan China Chat Completions | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `zai` | Z.AI GLM Coding Plan (global) | `ZAI_API_KEY` |
| `zai-coding-cn` | Z.AI GLM Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| `ant-ling` | Ant Ling Chat Completions | `ANT_LING_API_KEY` |
| `nvidia` | NVIDIA NIM Chat Completions | `NVIDIA_API_KEY` |
| `xiaomi` | Xiaomi MiMo Chat Completions | `MIMO_API_KEY` (or legacy `XIAOMI_API_KEY`) |
| `xiaomi-token-plan-cn` | Xiaomi Token Plan China Chat Completions | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-token-plan-ams` | Xiaomi Token Plan Amsterdam Chat Completions | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-token-plan-sgp` | Xiaomi Token Plan Singapore Chat Completions | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `moonshotai` | Moonshot global Chat Completions | `MOONSHOT_API_KEY` |
| `moonshotai-cn` | Moonshot China Chat Completions | `MOONSHOT_API_KEY` |
| `opencode` | OpenCode Zen, routed by model across Responses, Messages, Generate Content, and Chat Completions | `OPENCODE_API_KEY` |
| `opencode-go` | OpenCode Go, routed by model across Responses, Messages, and Chat Completions | `OPENCODE_API_KEY` |
| `cloudflare-workers-ai` | Workers AI Chat Completions | `CLOUDFLARE_API_KEY` plus `CLOUDFLARE_ACCOUNT_ID` |
| `cloudflare-ai-gateway` | AI Gateway, routed by model across Responses, Messages, and Chat Completions | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_GATEWAY_ID` |
| `kimi-coding` | Kimi For Coding Messages API | device OAuth or `KIMI_API_KEY` |
| `minimax` | MiniMax global Messages API | `MINIMAX_API_KEY` |
| `minimax-cn` | MiniMax China Messages API | `MINIMAX_CN_API_KEY` |

All of these protocols are exposed through rigyn adapters, but not every adapter is active by default. Bedrock is built in and resolves its region and credentials only when used. Providers that require deployment-specific endpoints or project identifiers, such as Vertex or Azure OpenAI, must be registered by a reviewed provider extension. Provider declarations, endpoint headers, and credentials are intentionally not accepted in `settings.json`.

The `openai-codex`, Claude Pro/Max OAuth, `github-copilot`, Kimi Code OAuth, and xAI subscription paths are compatibility transports for provider subscription services, not provider-endorsed rigyn integrations. Their public client registrations, endpoints, eligibility rules, and availability may change or be restricted by the provider. Users are responsible for complying with the applicable provider terms; use the documented API-key or cloud-provider path when a stable public integration is required.

When the interactive session selects an Anthropic model with Claude subscription credentials, rigyn warns once per process that third-party harness traffic uses Anthropic extra usage billed per token rather than Claude plan limits. Usage is managed in the [Anthropic extra-usage settings](https://claude.ai/settings/usage). Set `warnings.anthropicExtraUsage` to `false` to suppress that notice.

OpenAI-compatible presets are also built in for `groq`, `together`, `deepseek`, `cerebras`, `fireworks`, `huggingface`, both Qwen Token Plan regions, `ant-ling`, `nvidia`, `xiaomi`, both Moonshot regions, and all three Xiaomi Token Plan regions. Each preset has a tested base URL and credential mapping. xAI, OpenCode, OpenCode Go, Workers AI, and AI Gateway are routed providers whose maintained model rows select an explicit protocol. A reviewed provider extension can replace or overlay a preset when a deployment intentionally needs a different endpoint.

The Vercel preset filters its live `/models` result to language models, so image, video, embedding, and reranking products do not fill the coding-model picker. Z.AI uses its coding-only endpoint and provider-specific `max_tokens`/streamed-tool fields. Xiaomi uses its documented binary `thinking.type` control, preserves streamed `reasoning_content` across tool turns, and filters the mixed live catalog to the documented Chat Completions models. The regional Token Plan presets use the same wire behavior with independent regional credentials. `MIMO_API_KEY` is preferred for the general Xiaomi endpoint; `XIAOMI_API_KEY` remains a compatibility alias. See Xiaomi's [Chat Completions](https://mimo.mi.com/docs/en-US/api/chat/openai-api), [model-listing](https://mimo.mi.com/docs/en-US/api/model/list-models), and [Token Plan](https://platform.xiaomimimo.com/token-plan) contracts.

Moonshot uses `max_tokens`, binary `thinking.type`, and durable `reasoning_content`. Models that reject disabled thinking omit that field when reasoning-off is selected. Kimi and MiniMax use their Messages-compatible coding endpoints, retain signed thinking blocks across tool turns, and never route through the Chat Completions adapter. `/login kimi-coding` offers device authorization with rotating refresh tokens while preserving API-key login as a separate choice. Live discovery remains authoritative for fixed-protocol presets; maintained rows are a small connected/offline fallback and never add IDs to a successful live listing.

`openai-codex` supports `auto`, `websocket-cached`, `websocket`, and `sse` response transports. Choose it under `/settings` or set the top-level `transport` setting; a saved change takes effect after `/reload`. `auto` prefers the reusable WebSocket path when available and falls back safely. The top-level `websocketConnectTimeoutMs` setting controls the connection bound.

`/login` shows status and methods for every configured provider. `/logout` removes the selected stored profile and attempts OAuth revocation when the provider supports it. Environment and ambient credentials are never copied into the stored credential vault.

### Scoped network transport

`createNetworkTransport()` from `rigyn` or `rigyn/net` returns a lifecycle-owned `fetch` implementation and optional WebSocket factory with scoped proxy and timeout settings. Its fetch accepts the standard Node.js `RequestInfo | URL` input, including a Node-global `Request`; the request method, body, headers, signal, and redirect policy are preserved, while an explicit second `RequestInit` retains normal override precedence. Call `close()` when the owning runtime is disposed.

### Local router models

`llama.cpp` is preconfigured at `http://127.0.0.1:8080`. Only models reported as loaded or sleeping by the router appear in `/model`; unloaded catalog entries are never presented as runnable. `/llama` opens the model manager to refresh, load, unload, or download GGUF models. It asks before unloading another loaded model, never deletes local files, bounds every catalog and event payload, and supports cancellation throughout long operations.

Set `LLAMA_BASE_URL` to select another router. Remote URLs must use HTTPS and may authenticate with `LLAMA_API_KEY`; loopback HTTP is allowed without a credential. More specialized routing belongs in a provider extension rather than settings.

The download picker uses an available Hugging Face token from `HF_TOKEN`, `HF_TOKEN_PATH`, `HF_HOME`, or the standard local token cache. Gated repositories require explicit confirmation and prior access approval. An exact `owner/repository:QUANTIZATION` bypasses search while retaining repository and quantization validation.

### Stable stream envelopes

`ProviderStreamProjector` and `projectProviderStream` from `rigyn/providers` turn a normalized `AdapterEvent` stream into a sequence-bearing, serializable `ProviderStreamEnvelope`. The projection preserves response and request IDs, normalized text and reasoning deltas, interleaved tool-call starts and argument fragments, best-effort partial JSON, completed tool calls, usage semantics, finish details, and bounded error metadata. Tool-call indexes remain authoritative; consumers must not assume that one call's events are contiguous.

The projection is intentionally narrower than the adapter stream. It omits unknown provider events, continuation state, raw usage, and raw error payloads. HTTP diagnostics are revalidated through the fixed response-header allowlist, and credential-shaped values in response/request identifiers and error metadata pass through the host secret redactor. Provider output and tool arguments remain application content rather than transport diagnostics; extensions must treat partial arguments as untrusted and incomplete and must never place transport credentials in them.

```ts
import { projectProviderStream } from "rigyn/providers";

for await (const envelope of projectProviderStream(adapter.id, adapter.stream(request, signal))) {
  if (envelope.event.type === "tool_call_delta") {
    renderPartialArguments(envelope.event.partial.arguments);
  }
}
```

## Model selection

After authentication, the provider's live model catalog is refreshed and cached. `/model`, `Ctrl+L`, and the normal `--list-models` view show only IDs verified by a successful live discovery; configured, maintained, cached, and stale rows do not leak into that list. `rigyn --offline --list-models` can inspect configured or cached fallback metadata, but that output is not proof that a model is currently available. A saved model that is no longer returned is omitted rather than silently presented as available.

References may be exact or fuzzy:

```text
openai/MODEL_ID
anthropic/MODEL_ID:high
MODEL_ID
```

The thinking suffix is validated against model metadata. A private deployment or provider without a listing endpoint should register an exact model catalog through a reviewed provider extension. Type `/model PROVIDER/MODEL` or pass `--model PROVIDER/MODEL`; extension-owned static rows intentionally do not masquerade as a successful live listing. `--list-models [TEXT]` prints the connected catalog non-interactively. `/scoped-models` controls the smaller list used by model-cycling shortcuts.

## Credential precedence and storage

For each credential ID, resolution order is:

1. `--api-key` for the current invocation;
2. the active stored credential profile;
3. its selected stored fallback profile;
4. the provider's environment variable;
5. an ambient cloud identity where supported.

Stored credentials live separately from settings in the owner-only `auth.json` file under the agent directory. The file contains authentication material and must be protected like an API-key file: do not copy it into a project, commit it, include it in support bundles, or share it. Secrets are registered with the output redactor before use, but filesystem permissions remain part of the security boundary.

Multiple profiles can coexist for the same provider. When profiles already exist, `/login` can select a saved profile, authenticate again into one named profile, or create another without destroying unrelated profiles. `/logout` removes only the active profile; a later `/login` can select any remaining profile.

### Cloud credential chains

Bedrock resolves static environment credentials, shared-file static credentials, bounded `credential_process`, web identity, ECS, and IMDSv2 directly. Set `AWS_PROFILE` to select a named profile; its configured region is honored when no higher-precedence region is present. Profiles that use IAM Identity Center, `source_profile`, `credential_source`, or chained role assumption are delegated to the official AWS credential provider with the selected profile and exact configured shared-file paths. Run `aws sso login --profile NAME` before selecting an Identity Center profile. Every resolved access key, secret, and session token is immediately registered with rigyn's redactor; the official chain never changes the selected provider or profile. All Bedrock SDK traffic uses rigyn's host-owned HTTP/1.1 transport, so the top-level `httpProxy` setting and `NO_PROXY` policy apply without bypassing the redactor or request bounds.

Google application default credentials support authorized users, service accounts, impersonation, metadata, file and URL workload identity, AWS workload identity, executable subject tokens, and X.509 certificate sources. rigyn validates Google STS and impersonation endpoints before exchange, restricts AWS metadata and verification endpoints, requires absolute executable paths and `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1`, and validates certificate-config paths before delegating only subject-token acquisition to the official Google auth library. Final STS exchange, service-account impersonation, expiration checks, and token redaction remain host-owned.

## Provider-owned request options

`settings.json` contains user-interface and agent-runtime preferences, not provider declarations. Built-in provider defaults are versioned with rigyn. Deployment-specific endpoints, request options, static catalogs, caching policy, or protocol routing belong in a reviewed provider extension. The extension can register a direct provider, register an authentication method, or apply a generation-owned overlay to an existing provider; disposal and `/reload` restore the prior provider state.

For Bedrock Claude models, `thinkingDisplay` is `summarized` or `omitted`; GovCloud requests omit this field because that schema does not accept it. `interleavedThinking` defaults to `true` for compatible budget-based Claude models and is ignored by adaptive-thinking models. Per-run `thinkingBudgets` remain bounded by the selected output cap so at least 1,024 tokens are reserved for the answer.

Anthropic thinking mode is selected from live Models API `capabilities.thinking.types` when available, with documented first-party model families as an offline fallback. A custom Anthropic-compatible endpoint that needs different behavior must declare it in its provider extension rather than settings.

`mode` is `adaptive` or `enabled`. `off` is `omit`, `disabled`, or `always-on`; use `always-on` only when the upstream rejects disabled thinking. `interleaved` is `automatic`, `beta`, or `off`. The harness sends the interleaved beta only for a reasoning-enabled request with tools and a model marked `beta`; adaptive first-party models interleave automatically. Manual budgets must be integers from 1,024 through 1,000,000 and are bounded again by the request's `max_tokens`, reserving answer space whenever the cap permits. Top-level `thinkingBudgets` supplies per-run `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` values and takes precedence over provider defaults; Anthropic clamps values to its protocol minimum, while Gemini 2.5 Generate Content uses them directly. Adaptive and level-only protocols ignore numeric budgets. See Anthropic's [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) and [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) contracts.

Thinking and redacted-thinking blocks returned during a tool turn are retained in provider continuation state and sent back unchanged, including signed blocks whose visible thinking text is empty. Unsigned partial thinking is converted to ordinary text by default so it is not presented to Anthropic as a provider-authenticated block. Set `allowEmptySignature` only for a compatible endpoint that explicitly accepts `signature: ""`. Anthropic OAuth applies required canonical casing only to matching built-in tool names and maps responses back to the registered harness names; arbitrary extension tool names are untouched.

Anthropic function tools request eager partial-input streaming by default. An older compatible endpoint that rejects the per-tool field should be implemented by a provider extension with the matching transport behavior. Streamed argument fragments retain their order and every tool call is finalized once. Refusal finishes preserve only the provider-authored explanation, bounded to 4 KiB and stripped of control characters; arbitrary `stop_details` fields are not retained.

### Anthropic stream retry boundary

An Anthropic stream that ends before `message_stop` is retried only when the attempt has produced no text, reasoning, tool activity, or other substantive provider event. The adapter buffers `message_start` and its initial usage bookkeeping until substantive output or a clean terminal event, so a connection lost immediately after that bookkeeping can be retried without duplicating durable output.

The Responses transport uses the same substantive-output boundary when a connection closes before a terminal event. Metadata-only starts remain retryable; once text, reasoning, or tool-call output has been emitted, the failure is marked partial and is not retried automatically.

Once an attempt has produced substantive output, premature EOF is a partial, non-retryable failure. rigyn does not replay that attempt because the runtime has no abandoned-attempt/reset event that could retract already persisted deltas safely.

## Deferred tool loading

Executable tool definitions may opt into provider-native discovery with `loading: "deferred"`; eager loading remains the default. rigyn enables the provider wire only for documented compatible model families on the first-party OpenAI Responses or Anthropic Messages endpoints. Set `deferredToolLoading: true` only when a custom endpoint explicitly implements that provider contract. Unknown models, older models, disabled endpoints, and reserved-name conflicts receive every function definition normally without a search tool.

OpenAI uses hosted `tool_search`; Anthropic uses its versioned BM25 server tool. Provider search calls and loaded-tool references remain opaque continuation state, while only registered harness functions reach the executable tool coordinator. The loading mode is part of the tool-definition fingerprint, so changing it invalidates incompatible continuation and cache state instead of silently reusing a different tool surface.

## OpenAI-compatible endpoints

An arbitrary OpenAI-compatible alias is registered by a reviewed provider extension. The extension owns the secure base URL and model metadata and must document how its transport obtains credentials. Use `/login company` only when the extension has also registered a supported authentication path. See [`examples/provider-override`](../examples/provider-override/README.md) for the direct provider lifecycle.

`profile` is optional and defaults to `default`. The Vercel, Z.AI, Xiaomi, Moonshot, OpenCode, and Cloudflare gateway compatible presets select their documented profiles. Xiaomi's profile maps rigyn's off state to `thinking.type: "disabled"` and every enabled effort to `thinking.type: "enabled"`; the wire protocol does not expose finer effort levels. Moonshot adds its binary thinking and reasoning-continuation contract. OpenCode selects its token-field compatibility for Chat Completions routes. The Cloudflare gateway uses `max_tokens` and omits the unsupported generic reasoning-effort field. The `kimi-coding` and `minimax` profiles remain available only for an explicitly configured legacy Chat Completions gateway that implements those wire differences; the bundled Kimi and MiniMax providers use Messages instead. A custom endpoint should not select any provider profile unless it implements that profile's contract.

Per-model wire differences are provider metadata, not settings. A provider extension can supply `headers`, reasoning mappings, and bounded request-compatibility metadata for an exact model ID. Credential-shaped headers remain rejected.

### Multi-protocol routed providers

Some aggregating services publish one model catalog but route individual models through OpenAI Responses, Anthropic Messages, or Chat Completions. When a `/models` response does not identify the required route, treating the service as one fixed OpenAI-compatible endpoint can expose selectable models that fail at runtime. A runtime extension can compose independently configured adapters with `defineRoutedProviderAdapter`, but it must supply an exact route for every exposed model. rigyn does not guess protocols from model names.

Use `defineRoutedProviderAdapter` inside a reviewed provider extension to compose routed providers. Each route selects a named delegate and declares an exact `protocolFamily`; activation fails on a mismatch, a missing adapter, a duplicate route, nested routing, or dynamically selected protocol. Optional static model metadata is bounded and belongs to that extension. Provider routes are never settings and rigyn never guesses a protocol from a model name.

OpenCode and OpenCode Go are built-in routed providers. Their maintained route tables bind each current model ID to Responses, Messages, Generate Content, or Chat Completions explicitly; they never infer a protocol from an ID. Both use `OPENCODE_API_KEY`. Their static catalogs avoid an invalid cross-protocol `/models` merge and are refreshed with rigyn releases when the service roster changes.

Workers AI and AI Gateway are also built-in routed providers. Set these values before launch:

```text
CLOUDFLARE_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_GATEWAY_ID=... # AI Gateway only
```

`/login cloudflare-workers-ai` or `/login cloudflare-ai-gateway` may store the API key instead, but the account ID and optional gateway ID must still come from the environment. Workers requests materialize the account-scoped endpoint and use bearer authorization. Gateway requests materialize both bounded path segments, remove the delegate's ordinary `Authorization` or `x-api-key` header, and send `cf-aig-authorization` instead. Both providers expose maintained, protocol-bound model rows without pretending that a generic OpenAI `/models` endpoint verifies the mixed catalog.

### Discovered message gateways

`gateway-messages` connects a private or third-party gateway that implements rigyn's provider-neutral message stream. No service or endpoint is built in. A reviewed provider extension owns the versioned gateway root, exact provider ID, request defaults, and optional authentication registration. These declarations do not belong in `settings.json`.

`/login company-gateway` stores a bearer credential after the extension has registered that provider. When the extension enables managed OAuth, rigyn discovers a bounded public-client browser/device flow from `GET <gatewayUrl>/oauth`; endpoints, grants, scopes, polling, refresh, cancellation, and loopback state are validated by the host. rigyn sends the resulting token to `GET <gatewayUrl>/config`. The response must contain one secure `baseUrl` and an exact model catalog with IDs, display names, reasoning flags and level mappings, text/image inputs, per-token prices, context limits, and output limits. Only that credential-conditioned live catalog appears in `/model`; duplicate or malformed rows fail the refresh instead of being partially accepted. An extension can register the conventional `radius` provider ID and read `RADIUS_GATEWAY` as its gateway root.

Runs use `POST <baseUrl>/messages` with `{ model, context, options }`. Every run repeats credential-conditioned discovery and uses that same resolved bearer credential for discovery and generation, so endpoint state never crosses an account boundary. The SSE response supports ordered text, reasoning, and tool-call blocks plus one terminal success or error event. Reasoning is buffered until its terminal block confirms that it is not redacted, and streamed tool arguments must equal the terminal structured arguments before a call becomes executable. rigyn preserves provider-supplied content signatures and response IDs in continuation state, maps cache reads/writes and actual cost into normalized usage, emits bounded rewrite-impact metadata, and treats EOF without a terminal event as retryable only before substantive output. Both endpoints must use HTTPS, except loopback HTTP for local development. Authentication headers remain inside the credential broker and provider wire transport.

The provider extension may expose `temperature` from 0 through 2, `cacheRetention` (`none`, `short`, or `long`), `toolChoice` (`auto`, `none`, or `required`), and managed OAuth as its own validated options. A catalog `thinkingLevelMap` translates rigyn's selected effort before it crosses the wire; `null` disables that effort. `gateway-messages` is also a stable `ModelProtocolFamily`, so it can be selected explicitly by a routed provider without protocol-name guessing.

## Custom OAuth registrations

Trusted packages add provider-owned OAuth through the `oauth` field passed to `rigyn.registerProvider(name, config)`. The callback surface provides host-rendered authorization URLs, device codes, progress, bounded prompts, manual-code input, and selection. The extension implements its reviewed PKCE, device, or provider-specific exchange and returns normalized access, refresh, and expiry fields.

`refreshToken` renews the normalized credential and `getApiKey` projects the request secret. Optional `modifyModels` receives detached copies and may return a credential-conditioned catalog. The host owns persistence and interaction rendering; the extension never receives a credential-store handle.

## Managed provider OAuth

Use a small reviewed callback implementation for the provider's standard PKCE or device protocol. A provider whose protocol requires custom browser/device steps, non-standard token exchange, provider-specific request-secret projection, or account-conditioned model discovery uses the same direct `oauth` contract.

The package must be accepted by the trusted local or managed-package policy. `login` receives host-rendered authorization, device-code, progress, text-prompt, and selection interactions. `refreshToken` receives the active normalized OAuth value. `getApiKey` may derive the request secret used inside the model registry, and `modifyModels` may return a credential-conditioned catalog. Model projection runs only for a matching resolved OAuth credential; its input and output are detached copies, so callbacks cannot mutate the provider's base catalog.

The initial credential must include non-empty access and refresh tokens and an expiry. All callback output is normalized and validated, and the central store remains inaccessible. Provider registrations are activation-generation owned: failed activation, `/reload`, provider disposal, and shutdown remove their refresh, request-projection, and catalog-projection callbacks together. Callback credentials must remain ephemeral and must never enter logs, extension state, session events, diagnostics, or tool output.

## Caching and continuation

Provider state is kept only when it is compatible with the next request's provider, model, tools, and request fingerprint. OpenAI/ChatGPT use stable session cache keys; OpenAI can request configured retention. Anthropic inserts bounded explicit cache breakpoints. Bedrock adds cache points to stable message, system, and tool prefixes. Stateless chat protocols reconstruct canonical history and may send a configured cache-affinity key.

Normalized usage separates uncached input, cache reads, cache writes, output, and reasoning tokens where the upstream protocol reports them. Provider-reported costs take precedence. Otherwise the runtime calculates cost from provenance-bearing model pricing, including input-volume tiers and Anthropic's distinct 5-minute and 1-hour cache-write rates. If any non-zero counter lacks a price, cost stays unknown instead of being under-reported.

Credential-gated protocol smoke tests are documented in [live-provider-testing.md](./live-provider-testing.md).

Provider adapters attach bounded response diagnostics when their transport exposes an HTTP response. Those core diagnostics remain allowlisted and redacted before they enter events, messages, exports, or logs. Separately, trusted direct-extension `after_provider_response` observers receive each observed HTTP attempt and its complete normalized response headers. This direct hook intentionally has the authority of installed in-process code; response bodies and provider-native stream frames are not included. A WebSocket transport reports the successful protocol switch but may not have access to the server's handshake headers.

Trusted provider-integration packages call `rigyn.registerProvider(existingId, config)` to replace selected fields of an existing provider: display name, secure base URL, static headers, model catalog, catalog loader, OAuth behavior, or streaming implementation. Defined fields compose over the active registration; unloading that generation restores the remaining provider stack. `rigyn.unregisterProvider(id)` supports an earlier explicit removal.

Packages that require request-dependent behavior subscribe to `before_provider_request` to inspect and replace a detached provider-native JSON body, and to `before_provider_headers` to mutate the complete assembled header set. `after_provider_response` exposes status and complete normalized response headers. These are trusted direct hooks: authentication and cookie headers are visible, while inbound frames, response bodies, and provider-native stream objects remain private. OAuth callback values must remain ephemeral.
