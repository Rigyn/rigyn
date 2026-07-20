# Providers and authentication

Rigyn speaks provider protocols directly and normalizes their streaming events, tool calls, reasoning, usage, cache accounting, errors, and continuation state into one agent contract.

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
| `mistral` | chat completions or conversations | API key |
| `ollama` | Ollama chat | no credential for loopback; bearer token for remote hosts |
| `llama.cpp` | llama.cpp router with OpenAI-compatible chat | no credential for loopback; `LLAMA_API_KEY` for remote routers |
| configured `gateway-messages` | discovered message gateway | API key, bearer token, or a custom OAuth method bound to the configured provider ID |
| `xai` | exact per-model Responses or Chat Completions route | SuperGrok/X Premium device OAuth, API key, or `XAI_API_KEY` |
| `vercel-ai-gateway` | OpenAI-compatible chat completions | `AI_GATEWAY_API_KEY` |
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
| `opencode-go` | OpenCode Go, routed by model across Messages and Chat Completions | `OPENCODE_API_KEY` |
| `cloudflare-workers-ai` | Workers AI Chat Completions | `CLOUDFLARE_API_KEY` plus `CLOUDFLARE_ACCOUNT_ID` |
| `cloudflare-ai-gateway` | AI Gateway, routed by model across Responses, Messages, and Chat Completions | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_GATEWAY_ID` |
| `kimi-coding` | Kimi For Coding Messages API | `KIMI_API_KEY` |
| `minimax` | MiniMax global Messages API | `MINIMAX_API_KEY` |
| `minimax-cn` | MiniMax China Messages API | `MINIMAX_CN_API_KEY` |

All of these protocols are implemented in Rigyn, but not every adapter is preconfigured. `vertex` needs a Google Cloud project, `azure-openai` needs the resource endpoint, and `bedrock` needs a region. Add them to global configuration before expecting them in `/login` or `/model`:

```jsonc
{
  "providers": {
    "vertex": { "kind": "vertex", "project": "YOUR_PROJECT", "location": "us-central1" },
    "azure-openai": { "kind": "azure-openai", "endpoint": "https://YOUR_RESOURCE.openai.azure.com" },
    "bedrock": { "kind": "bedrock", "region": "us-east-1" }
  }
}
```

Bedrock is also configured automatically when `AWS_REGION` or `AWS_DEFAULT_REGION` is present. An API key or ambient cloud identity does not by itself supply the missing Azure endpoint or Vertex project.

The `openai-codex`, Claude Pro/Max OAuth, `github-copilot`, and xAI subscription paths are compatibility transports for provider subscription services, not provider-endorsed Rigyn integrations. Their public client registrations, endpoints, eligibility rules, and availability may change or be restricted by the provider. Users are responsible for complying with the applicable provider terms; use the documented API-key or cloud-provider path when a stable public integration is required.

OpenAI-compatible presets are also built in for `groq`, `together`, `deepseek`, `cerebras`, `fireworks`, `huggingface`, `ant-ling`, `nvidia`, `xiaomi`, both Moonshot regions, and all three Xiaomi Token Plan regions. Each preset has a tested base URL and credential mapping. xAI, OpenCode, OpenCode Go, Workers AI, and AI Gateway are routed providers whose maintained model rows select an explicit protocol. Override a preset in `providers` only when you intentionally need a different endpoint.

The Vercel preset filters its live `/models` result to language models, so image, video, embedding, and reranking products do not fill the coding-model picker. Z.AI uses its coding-only endpoint and provider-specific `max_tokens`/streamed-tool fields. Xiaomi uses its documented binary `thinking.type` control, preserves streamed `reasoning_content` across tool turns, and filters the mixed live catalog to the documented Chat Completions models. The regional Token Plan presets use the same wire behavior with independent regional credentials. `MIMO_API_KEY` is preferred for the general Xiaomi endpoint; `XIAOMI_API_KEY` remains a compatibility alias. See Xiaomi's [Chat Completions](https://mimo.mi.com/docs/en-US/api/chat/openai-api), [model-listing](https://mimo.mi.com/docs/en-US/api/model/list-models), and [Token Plan](https://platform.xiaomimimo.com/token-plan) contracts.

Moonshot uses `max_tokens`, binary `thinking.type`, and durable `reasoning_content`. Models that reject disabled thinking omit that field when reasoning-off is selected. Kimi and MiniMax use their Messages-compatible coding endpoints, retain signed thinking blocks across tool turns, and never route through the Chat Completions adapter. Live discovery remains authoritative for fixed-protocol presets; maintained rows are a small connected/offline fallback and never add IDs to a successful live listing.

`openai-codex` supports `auto`, `websocket-cached`, `websocket`, and `sse` response transports. Choose it under `/settings` or configure `providers.openai-codex.transport`; a saved change takes effect after `/reload`. `auto` prefers the reusable WebSocket path when available and falls back safely. Optional `webSocketConnectTimeoutMs` and `webSocketIdleTimeoutMs` values are bounded from 0 through 600000 milliseconds.

`/login` shows status and methods for every configured provider. `/logout` removes the selected stored profile and attempts OAuth revocation when the provider supports it. Environment and ambient credentials are never copied into the stored credential vault.

### Local router models

`llama.cpp` is preconfigured at `http://127.0.0.1:8080`. Only models reported as loaded or sleeping by the router appear in `/model`; unloaded catalog entries are never presented as runnable. `/llama` opens the model manager to refresh, load, unload, or download GGUF models. It asks before unloading another loaded model, never deletes local files, bounds every catalog and event payload, and supports cancellation throughout long operations.

Set `LLAMA_BASE_URL` to select another router. Remote URLs must use HTTPS and may authenticate with `LLAMA_API_KEY`; loopback HTTP is allowed without a credential. The equivalent explicit configuration is:

```jsonc
{
  "providers": {
    "llama.cpp": {
      "kind": "llama-router",
      "id": "llama.cpp",
      "baseUrl": "http://127.0.0.1:8080",
      "timeoutMs": 15000
    }
  }
}
```

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

The thinking suffix is validated against model metadata. For a private deployment or provider without a listing endpoint, add an exact model entry in configuration, then type `/model PROVIDER/MODEL` or pass `--model PROVIDER/MODEL`; configured-only rows intentionally do not populate the live picker. `--list-models [TEXT]` prints the connected catalog non-interactively. `/scoped-models` controls the smaller list used by model-cycling shortcuts.

## Credential precedence and storage

For each credential ID, resolution order is:

1. `--api-key` for the current invocation;
2. the active stored credential profile;
3. its selected stored fallback profile;
4. the provider's environment variable;
5. an ambient cloud identity where supported.

Self-contained installs use an installation-local encrypted credential store so update and uninstall own one complete state root. Its key is a private `credentials.key` file on Linux and macOS and a DPAPI-protected envelope on Windows. A source or portable run with no existing local key functionally probes the current user's macOS Keychain or Linux Secret Service; if that service cannot be used, interactive startup creates the private encrypted file store on the first write. Merely finding `secret-tool` is not treated as a working Secret Service.

`RIGYN_CREDENTIAL_KEY` can supply exactly 32 bytes encoded as hexadecimal or unpadded base64url for a deliberately portable or headless source runtime. Keep it out of shell history, logs, project configuration, and support bundles. Stored files use private permissions and never contain the credential kind or secret in plaintext. Secrets are registered with the output redactor before use.

Multiple profiles can coexist for the same provider. When profiles already exist, `/login` can select a saved profile, authenticate again into one named profile, or create another without destroying unrelated profiles. `/logout` removes only the active profile; a later `/login` can select any remaining profile.

### Cloud credential chains

Bedrock resolves static environment credentials, shared-file static credentials, bounded `credential_process`, web identity, ECS, and IMDSv2 directly. Profiles that use IAM Identity Center, `source_profile`, `credential_source`, or chained role assumption are delegated to the official AWS credential provider with the selected profile and exact configured shared-file paths. Run `aws sso login --profile NAME` before selecting an Identity Center profile. Every resolved access key, secret, and session token is immediately registered with Rigyn's redactor; the official chain never changes the selected provider or profile.

Google application default credentials support authorized users, service accounts, impersonation, metadata, file and URL workload identity, AWS workload identity, executable subject tokens, and X.509 certificate sources. Rigyn validates Google STS and impersonation endpoints before exchange, restricts AWS metadata and verification endpoints, requires absolute executable paths and `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1`, and validates certificate-config paths before delegating only subject-token acquisition to the official Google auth library. Final STS exchange, service-account impersonation, expiration checks, and token redaction remain host-owned.

## Provider configuration

Examples:

```jsonc
{
  "providers": {
    "openai": {
      "kind": "openai",
      "organization": "org_example",
      "project": "proj_example",
      "store": true,
      "promptCacheOptions": { "ttl": "30m" },
      "promptCacheRetention": "24h",
      "serviceTier": "auto"
    },
    "openai-codex": {
      "kind": "openai-codex",
      "transport": "auto",
      "webSocketConnectTimeoutMs": 10000,
      "webSocketIdleTimeoutMs": 300000
    },
    "anthropic": {
      "kind": "anthropic",
      "promptCache": "1h",
      "eagerToolInputStreaming": true,
      "thinking": {
        "budgets": { "low": 2048, "medium": 8192, "high": 16384 },
        "models": {
          "partner-model": {
            "mode": "enabled",
            "off": "omit",
            "interleaved": "beta",
            "allowEmptySignature": true
          }
        }
      }
    },
    "gemini": {
      "kind": "gemini",
      "protocol": "interactions"
    },
    "mistral": {
      "kind": "mistral",
      "protocol": "conversations",
      "store": true,
      "reasoningMode": "effort"
    },
    "ollama": {
      "kind": "ollama",
      "host": "http://127.0.0.1:11434"
    }
  }
}
```

Provider-specific keys are strictly validated. Anthropic, Bedrock, and OpenRouter accept `promptCache` values `off`, `5m`, or `1h`. Mistral chat accepts `off` or `session`; the conversations protocol maintains its own remote continuation and therefore does not use a prompt cache key.

Anthropic thinking mode is selected from live Models API `capabilities.thinking.types` when available, with documented first-party model families as an offline fallback. A model with no metadata or explicit entry defaults to the legacy manual `budget_tokens` contract; configure `providers.anthropic.thinking.models.MODEL_ID` when a custom Anthropic-compatible endpoint needs adaptive thinking or another behavior. A `"*"` model entry supplies an intentional endpoint-wide default, while an exact model entry wins over it.

`mode` is `adaptive` or `enabled`. `off` is `omit`, `disabled`, or `always-on`; use `always-on` only when the upstream rejects disabled thinking. `interleaved` is `automatic`, `beta`, or `off`. The harness sends the interleaved beta only for a reasoning-enabled request with tools and a model marked `beta`; adaptive first-party models interleave automatically. Manual budgets must be integers from 1,024 through 1,000,000 and are bounded again by the request's `max_tokens`, reserving answer space whenever the cap permits. Top-level `thinkingBudgets` supplies per-run `minimal` through `high` values and takes precedence over provider defaults; Anthropic clamps values to its protocol minimum, while Gemini 2.5 Generate Content uses them directly. Adaptive and level-only protocols ignore numeric budgets. See Anthropic's [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) and [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) contracts.

Thinking and redacted-thinking blocks returned during a tool turn are retained in provider continuation state and sent back unchanged, including signed blocks whose visible thinking text is empty. Unsigned partial thinking is converted to ordinary text by default so it is not presented to Anthropic as a provider-authenticated block. Set `allowEmptySignature` only for a compatible endpoint that explicitly accepts `signature: ""`. Anthropic OAuth applies required canonical casing only to matching built-in tool names and maps responses back to the registered harness names; arbitrary extension tool names are untouched.

Anthropic function tools request eager partial-input streaming by default. Set `eagerToolInputStreaming` to `false` only for an older compatible endpoint that rejects the per-tool field; Rigyn then omits it and requests the legacy partial-input beta instead. Streamed argument fragments retain their order and every tool call is finalized once. Refusal finishes preserve only the provider-authored explanation, bounded to 4 KiB and stripped of control characters; arbitrary `stop_details` fields are not retained.

### Anthropic stream retry boundary

An Anthropic stream that ends before `message_stop` is retried only when the attempt has produced no text, reasoning, tool activity, or other substantive provider event. The adapter buffers `message_start` and its initial usage bookkeeping until substantive output or a clean terminal event, so a connection lost immediately after that bookkeeping can be retried without duplicating durable output.

The Responses transport uses the same substantive-output boundary when a connection closes before a terminal event. Metadata-only starts remain retryable; once text, reasoning, or tool-call output has been emitted, the failure is marked partial and is not retried automatically.

Once an attempt has produced substantive output, premature EOF is a partial, non-retryable failure. Rigyn does not replay that attempt because the runtime has no abandoned-attempt/reset event that could retract already persisted deltas safely.

## Deferred tool loading

Executable tool definitions may opt into provider-native discovery with `loading: "deferred"`; eager loading remains the default. Rigyn enables the provider wire only for documented compatible model families on the first-party OpenAI Responses or Anthropic Messages endpoints. Set `deferredToolLoading: true` only when a custom endpoint explicitly implements that provider contract. Unknown models, older models, disabled endpoints, and reserved-name conflicts receive every function definition normally without a search tool.

OpenAI uses hosted `tool_search`; Anthropic uses its versioned BM25 server tool. Provider search calls and loaded-tool references remain opaque continuation state, while only registered harness functions reach the executable tool coordinator. The loading mode is part of the tool-definition fingerprint, so changing it invalidates incompatible continuation and cache state instead of silently reusing a different tool surface.

## OpenAI-compatible endpoints

Only `openai-compatible` configurations may use an arbitrary alias:

```jsonc
{
  "providers": {
    "company": {
      "kind": "openai-compatible",
      "baseUrl": "https://models.example.com/v1",
      "credentialProvider": "company"
    }
  },
  "models": [
    {
      "provider": "company",
      "id": "code-model",
      "contextTokens": 131072,
      "tools": true,
      "reasoning": true
    }
  ]
}
```

Use `/login company` to store the credential. A runtime extension can alternatively register both a provider adapter and an auth descriptor.

`profile` is optional and defaults to `default`. The Vercel, Z.AI, Xiaomi, Moonshot, OpenCode, and Cloudflare gateway compatible presets select their documented profiles. Xiaomi's profile maps Rigyn's off state to `thinking.type: "disabled"` and every enabled effort to `thinking.type: "enabled"`; the wire protocol does not expose finer effort levels. Moonshot adds its binary thinking and reasoning-continuation contract. OpenCode selects its token-field compatibility for Chat Completions routes. The Cloudflare gateway uses `max_tokens` and omits the unsupported generic reasoning-effort field. The `kimi-coding` and `minimax` profiles remain available only for an explicitly configured legacy Chat Completions gateway that implements those wire differences; the bundled Kimi and MiniMax providers use Messages instead. A custom endpoint should not select any provider profile unless it implements that profile's contract.

An exact entry under top-level `models` can override documented wire differences without creating another provider profile. Use `headers` for non-secret per-model labels, `reasoningEffortMap` for provider-specific reasoning values, and `requestCompatibility` for token-field, streaming-usage, reasoning-format, chat-template, cache-marker, session-affinity, and OpenRouter/Vercel routing behavior. These settings are validated, bounded, and applied only to the matching model ID. They do not allow arbitrary body mutation, and credential-shaped headers are rejected. See [Model metadata](configuration.md#model-metadata) for the complete fields and example.

### Multi-protocol routed providers

Some aggregating services publish one model catalog but route individual models through OpenAI Responses, Anthropic Messages, or Chat Completions. When a `/models` response does not identify the required route, treating the service as one fixed OpenAI-compatible endpoint can expose selectable models that fail at runtime. A runtime extension can compose independently configured adapters with `defineRoutedProviderAdapter`, but it must supply an exact route for every exposed model. Rigyn does not guess protocols from model names.

The same composition is available declaratively with `kind: "routed"`. One public provider owns the delegates, shares one credential binding by default, forwards wire telemetry under the public provider ID, and disposes every delegate with the active runtime generation:

```jsonc
{
  "providers": {
    "company": {
      "kind": "routed",
      "credentialProvider": "company",
      "adapters": {
        "fast": {
          "kind": "openai-compatible",
          "baseUrl": "https://gateway.example/v1/chat"
        },
        "deep": {
          "kind": "anthropic",
          "baseUrl": "https://gateway.example/v1/messages"
        }
      },
      "routes": [
        {
          "model": "fast-code",
          "upstreamModel": "vendor-fast-code",
          "adapter": "fast",
          "protocolFamily": "openai-chat-completions"
        },
        {
          "model": "deep-code",
          "upstreamModel": "vendor-deep-code",
          "adapter": "deep",
          "protocolFamily": "anthropic-messages",
          "modelInfo": {
            "displayName": "Deep Code",
            "contextTokens": 200000,
            "tools": true,
            "reasoningEfforts": ["off", "low", "high"]
          }
        }
      ]
    }
  }
}
```

`adapter` selects a named delegate and `protocolFamily` must exactly match that delegate's configured protocol. Startup fails on a mismatch, a missing adapter, duplicate route, nested routed provider, or dynamically selected protocol. `modelInfo` is optional static catalog metadata for an endpoint without model discovery; it accepts the same bounded model fields as top-level `models`. Without `modelInfo`, the delegate must advertise `upstreamModel` through live discovery. Per-adapter credential overrides are available to the programmatic factory, while the JSON form intentionally uses one public credential binding so `/login company` has unambiguous behavior.

OpenCode and OpenCode Go are built-in routed providers. Their maintained route tables bind each current model ID to Responses, Messages, Generate Content, or Chat Completions explicitly; they never infer a protocol from an ID. Both use `OPENCODE_API_KEY`. Their static catalogs avoid an invalid cross-protocol `/models` merge and are refreshed with Rigyn releases when the service roster changes.

Workers AI and AI Gateway are also built-in routed providers. Set these values before launch:

```text
CLOUDFLARE_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_GATEWAY_ID=... # AI Gateway only
```

`/login cloudflare-workers-ai` or `/login cloudflare-ai-gateway` may store the API key instead, but the account ID and optional gateway ID must still come from the environment. Workers requests materialize the account-scoped endpoint and use bearer authorization. Gateway requests materialize both bounded path segments, remove the delegate's ordinary `Authorization` or `x-api-key` header, and send `cf-aig-authorization` instead. Both providers expose maintained, protocol-bound model rows without pretending that a generic OpenAI `/models` endpoint verifies the mixed catalog.

### Discovered message gateways

`gateway-messages` connects a private or third-party gateway that implements Rigyn's provider-neutral message stream. No service or endpoint is built in. Configure the versioned gateway root explicitly:

```jsonc
{
  "providers": {
    "company-gateway": {
      "kind": "gateway-messages",
      "gatewayUrl": "https://gateway.example.com/v1",
      "credentialProvider": "company-gateway",
      "cacheRetention": "long",
      "toolChoice": "auto"
    }
  }
}
```

`/login company-gateway` stores a bearer credential unless an extension registers another authentication method for the same credential ID. Rigyn sends it to `GET <gatewayUrl>/config`. The response must contain one secure `baseUrl` and an exact model catalog with IDs, display names, reasoning flags and level mappings, text/image inputs, per-token prices, context limits, and output limits. Only that credential-conditioned live catalog appears in `/model`; duplicate or malformed rows fail the refresh instead of being partially accepted.

Runs use `POST <baseUrl>/messages` with `{ model, context, options }`. Every run repeats credential-conditioned discovery and uses that same resolved bearer credential for discovery and generation, so endpoint state never crosses an account boundary. The SSE response supports ordered text, reasoning, and tool-call blocks plus one terminal success or error event. Reasoning is buffered until its terminal block confirms that it is not redacted, and streamed tool arguments must equal the terminal structured arguments before a call becomes executable. Rigyn preserves provider-supplied content signatures and response IDs in continuation state, maps cache reads/writes and actual cost into normalized usage, emits bounded rewrite-impact metadata, and treats EOF without a terminal event as retryable only before substantive output. Both endpoints must use HTTPS, except loopback HTTP for local development. Authentication headers remain inside the credential broker and provider wire transport.

The optional provider settings are `temperature` from 0 through 2, `cacheRetention` (`none`, `short`, or `long`), and `toolChoice` (`auto`, `none`, or `required`). A catalog `thinkingLevelMap` translates Rigyn's selected effort before it crosses the wire; `null` disables that effort. `gateway-messages` is also a stable `ModelProtocolFamily`, so it can be selected explicitly by a declarative routed provider without protocol-name guessing.

## Custom OAuth registrations

Providers with standard OAuth endpoints can add a PKCE or device registration without changing the core:

```jsonc
{
  "oauthRegistrations": {
    "company-login": {
      "provider": "company",
      "flow": "pkce",
      "clientId": "public-client-id",
      "authorizationEndpoint": "https://identity.example.com/authorize",
      "tokenEndpoint": "https://identity.example.com/token",
      "revocationEndpoint": "https://identity.example.com/revoke",
      "scopes": ["models:read", "models:invoke"],
      "callbackPath": "/oauth/callback",
      "label": "Company sign-in"
    }
  }
}
```

PKCE uses a loopback callback with state verification. Device flow validates polling intervals and cancellation. OAuth responses, refresh tokens, expiry, account identity, and provider metadata are normalized into the same stored-credential contract.

## Managed provider OAuth

Use declarative PKCE or device registration whenever a provider follows those standards. A provider whose protocol requires custom browser/device steps, non-standard token exchange, provider-specific request-secret projection, or account-conditioned model discovery can instead ship a trusted runtime extension with a `managed_oauth` authentication method.

The package must be accepted by the trusted local or managed-package policy and declare `permissions.credentialAccess`. `login` receives host-rendered authorization, device-code, progress, text-prompt, and selection interactions. `refresh` receives the active normalized OAuth value and cancellation signal. `getApiKey` may derive the request secret used inside the broker, and `modifyModels` may return a credential-conditioned catalog. Model projection runs only for a matching resolved OAuth credential; its input and output are detached copies, so callbacks cannot mutate the provider's base catalog.

The initial credential must include non-empty access and refresh tokens and a future expiry. A refresh result may omit unchanged refresh-token, identity, or scope fields; the host carries them forward. All callback output is normalized and validated, projected secrets are registered with redaction, and the central store remains inaccessible. Managed registrations are activation-generation owned: failed activation, `/reload`, provider disposal, and shutdown remove their refresh, request-projection, and catalog-projection callbacks together. This is intentionally more authority than ordinary `api.auth.fetch`; callback credentials must remain ephemeral and must never enter logs, extension state, session events, diagnostics, or tool output.

## Caching and continuation

Provider state is kept only when it is compatible with the next request's provider, model, tools, and request fingerprint. OpenAI/ChatGPT use stable session cache keys; OpenAI can request configured retention. Anthropic inserts bounded explicit cache breakpoints. Bedrock adds cache points to stable message, system, and tool prefixes. Mistral conversations persists its conversation ID, while stateless protocols reconstruct canonical history.

Normalized usage separates uncached input, cache reads, cache writes, output, and reasoning tokens where the upstream protocol reports them. Provider-reported costs take precedence. Otherwise the runtime calculates cost from provenance-bearing model pricing, including input-volume tiers and Anthropic's distinct 5-minute and 1-hour cache-write rates. If any non-zero counter lacks a price, cost stays unknown instead of being under-reported.

Credential-gated protocol smoke tests are documented in [live-provider-testing.md](./live-provider-testing.md).

Provider adapters attach bounded response diagnostics when their transport exposes an HTTP response. Runtime `after_provider_response` observers receive each observed HTTP attempt, including non-2xx attempts that will retry, and may read the status and a fixed allowlist of request-ID, content-type, retry, and rate-limit headers. Failed attempts include bounded error metadata without the raw response body. Rigyn drops every other header, revalidates custom-adapter diagnostics in the core, and applies the credential redactor before delivery; authentication, cookies, raw bodies, and arbitrary provider metadata never cross this boundary. A WebSocket transport reports the successful protocol switch but may not have access to the server's handshake headers.

Trusted provider-integration packages may request `providerOverride`, then use `api.native.providers.overlay` to replace only an existing provider's display name, secure base URL, static headers, model catalog, catalog loader, or streaming implementation. Missing fields continue through the active adapter and authentication binding; overlays compose as ownership-safe layers and disposing any layer recomputes the exact remaining composition. This is the preferred surface for declarative endpoint, catalog, or protocol changes.

Packages that require request-dependent behavior may request `providerWire`, then use `api.native.providers.intercept` to transform a built-in provider's JSON request, secure destination, and headers before transmission and inspect complete response headers. A `baseUrl` patch is applied by the host to the private request URL, so credential-bearing query values survive rebasing without becoming visible to extension code. HTTP, pre-sign cloud requests, and outbound JSON WebSocket frames share this lifecycle; established WebSocket connections cannot change URL or handshake headers, and the host transport exposes only status 101 rather than the server's handshake headers. Credential-bearing request headers and URL fields are hidden from the observer, inbound WebSocket frame contents and all response bodies remain private, and disposal restores the unmodified transport. A package that also needs the active access secret must request the separate `credentialAccess` permission.
