# Kimi Code

Rigyn exposes Kimi Code as the built-in `kimi-code` provider. It uses Kimi's
OpenAI-compatible coding endpoint at `https://api.kimi.com/coding/v1` and the
API key issued by the [Kimi Code console](https://www.kimi.com/code/console).
That key consumes the member's Kimi Code quota; it is distinct from a Moonshot
Open Platform API key.

Use `/login`, select **Kimi Code**, then choose device account login or the API-key
method. For non-interactive launches, set `KIMI_CODE_API_KEY`. The same provider
identity, catalog, and credential lookup are used by TUI, print, JSON, RPC,
serve, and SDK sessions.

The maintained catalog contains the current coding model IDs:

| Model | Context fallback | Reasoning selection |
| --- | ---: | --- |
| `k3` | up to 1,048,576 tokens, subject to membership tier | low, high, max |
| `k3-256k` | 262,144 | low, high, max |
| `kimi-for-coding` | 262,144 | provider-managed |
| `kimi-for-coding-highspeed` | 262,144 | provider-managed |

Kimi publishes these context windows but not separate output maxima or
incremental per-token prices for the membership IDs. Rigyn leaves those fields
unknown instead of deriving a limit or treating quota-based access as free.

When a session ID is available, Rigyn sends it as `prompt_cache_key`. Kimi
documents this field for coding agents and requires it for Kimi Code Plan cache
affinity. Resuming the same Rigyn session retains the same key.

Device login uses Rigyn's bundled public client registration. Set
`RIGYN_KIMI_CODE_OAUTH_CLIENT_ID` to replace that public client ID for a
deployment. The resulting refreshable credential is stored under the same
`kimi-code` identity; the API-key and environment-key methods remain available.
Rigyn does not read another client's credential file or add unrelated identity
headers to Kimi Code requests.

Provider references:

- [Kimi Code documentation](https://www.kimi.com/code/docs/en/)
- [Kimi Code models and third-party tool setup](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [Kimi CLI authentication reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
