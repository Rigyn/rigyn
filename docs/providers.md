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
| `vercel-ai-gateway` | OpenAI-compatible chat completions | `AI_GATEWAY_API_KEY` |
| `zai` | Z.AI GLM Coding Plan (global) | `ZAI_API_KEY` |
| `zai-coding-cn` | Z.AI GLM Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| `kimi-coding` | Kimi For Coding | `KIMI_API_KEY` |
| `minimax` | MiniMax global OpenAI-compatible API | `MINIMAX_API_KEY` |
| `minimax-cn` | MiniMax China OpenAI-compatible API | `MINIMAX_CN_API_KEY` |

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

The `openai-codex`, Claude Pro/Max OAuth, and `github-copilot` paths are compatibility transports for provider subscription services, not provider-endorsed Rigyn integrations. Their client registrations, endpoints, eligibility rules, and availability may change or be restricted by the provider. Users are responsible for complying with the applicable provider terms; use the documented API-key or cloud-provider path when a stable public integration is required.

OpenAI-compatible presets are also built in for `groq`, `together`, `deepseek`, `cerebras`, `xai`, `fireworks`, and `huggingface`. Each preset has a tested base URL, credential mapping, and compatibility profile. Override a preset in `providers` only when you intentionally need a different endpoint.

The Vercel preset filters its live `/models` result to language models, so image, video, embedding, and reranking products do not fill the coding-model picker. Z.AI uses its coding-only endpoint and provider-specific `max_tokens`/streamed-tool fields. MiniMax requests separated reasoning details so complete assistant state can be returned on tool-call turns. Kimi keeps its provider-native reasoning field in continuation state. Live discovery remains authoritative for every preset; maintained rows are a small connected/offline fallback and never add IDs to a successful live listing.

`openai-codex` supports `auto`, `websocket-cached`, `websocket`, and `sse` response transports. Choose it under `/settings` or configure `providers.openai-codex.transport`; a saved change takes effect after `/reload`. `auto` prefers the reusable WebSocket path when available and falls back safely. Optional `webSocketConnectTimeoutMs` and `webSocketIdleTimeoutMs` values are bounded from 0 through 600000 milliseconds.

`/login` shows status and methods for every configured provider. `/logout` removes the selected stored profile and attempts OAuth revocation when the provider supports it. Environment and ambient credentials are never copied into the stored credential vault.

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

`mode` is `adaptive` or `enabled`. `off` is `omit`, `disabled`, or `always-on`; use `always-on` only when the upstream rejects disabled thinking. `interleaved` is `automatic`, `beta`, or `off`. The harness sends the interleaved beta only for a reasoning-enabled request with tools and a model marked `beta`; adaptive first-party models interleave automatically. Manual budgets must be integers from 1,024 through 1,000,000 and are bounded again by the request's `max_tokens`, reserving answer space whenever the cap permits. See Anthropic's [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) and [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) contracts.

Thinking and redacted-thinking blocks returned during a tool turn are retained in provider continuation state and sent back unchanged, including signed blocks whose visible thinking text is empty. Unsigned partial thinking is converted to ordinary text by default so it is not presented to Anthropic as a provider-authenticated block. Set `allowEmptySignature` only for a compatible endpoint that explicitly accepts `signature: ""`. Anthropic OAuth applies required canonical casing only to matching built-in tool names and maps responses back to the registered harness names; arbitrary extension tool names are untouched.

### Anthropic stream retry boundary

An Anthropic stream that ends before `message_stop` is retried only when the attempt has produced no text, reasoning, tool activity, or other substantive provider event. The adapter buffers `message_start` and its initial usage bookkeeping until substantive output or a clean terminal event, so a connection lost immediately after that bookkeeping can be retried without duplicating durable output.

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

`profile` is optional and defaults to `default`. The built-in compatible presets use one of `vercel-ai-gateway`, `zai`, `kimi-coding`, or `minimax` to apply only documented wire-format differences. A custom endpoint should not select a provider profile unless it implements that provider's contract.

### Providers that are not fixed presets

OpenCode Zen and OpenCode Go publish one model catalog but route individual models through OpenAI Responses, Anthropic Messages, or Chat Completions. Their `/models` responses do not identify the required route. Treating either service as one fixed OpenAI-compatible endpoint would therefore show selectable models that fail at runtime. A runtime extension can compose independently configured adapters with `defineRoutedProviderAdapter`, but it must supply an exact route for every exposed model. Rigyn does not guess protocols from model names.

Cloudflare AI Gateway also combines provider-specific routes and requires account/gateway identifiers plus Cloudflare-specific authorization headers. It is not represented as a fixed compatible preset. Cloudflare Workers AI is safely usable as a configured Chat Completions endpoint when the account ID and model are explicit:

```jsonc
{
  "providers": {
    "cloudflare-workers-ai": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
      "credentialProvider": "cloudflare-workers-ai"
    }
  },
  "models": [
    {
      "provider": "cloudflare-workers-ai",
      "id": "@cf/moonshotai/kimi-k2.6",
      "tools": true,
      "reasoning": true
    }
  ]
}
```

Set `CLOUDFLARE_API_KEY` before launching. Workers AI model discovery uses a Cloudflare-specific search endpoint rather than OpenAI `/models`, so the explicit model row is required for the fallback picker. Full AI Gateway routing, stored BYOK, and gateway-specific cache headers belong in a dedicated provider extension rather than a misleading fixed preset.

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

## Caching and continuation

Provider state is kept only when it is compatible with the next request's provider, model, tools, and request fingerprint. OpenAI/ChatGPT use stable session cache keys; OpenAI can request configured retention. Anthropic inserts bounded explicit cache breakpoints. Bedrock adds cache points to stable message, system, and tool prefixes. Mistral conversations persists its conversation ID, while stateless protocols reconstruct canonical history.

Normalized usage separates uncached input, cache reads, cache writes, output, and reasoning tokens where the upstream protocol reports them. Provider-reported costs take precedence. Otherwise the runtime calculates cost from provenance-bearing model pricing, including input-volume tiers and Anthropic's distinct 5-minute and 1-hour cache-write rates. If any non-zero counter lacks a price, cost stays unknown instead of being under-reported.

Credential-gated protocol smoke tests are documented in [live-provider-testing.md](./live-provider-testing.md).

Provider adapters attach bounded response diagnostics when their transport exposes an HTTP response. Runtime `after_provider_response` observers receive each observed HTTP attempt, including non-2xx attempts that will retry, and may read the status and a fixed allowlist of request-ID, content-type, retry, and rate-limit headers. Failed attempts include bounded error metadata without the raw response body. Rigyn drops every other header, revalidates custom-adapter diagnostics in the core, and applies the credential redactor before delivery; authentication, cookies, raw bodies, and arbitrary provider metadata never cross this boundary. WebSocket-only responses may omit diagnostics.
