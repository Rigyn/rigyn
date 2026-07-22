# Live provider contract tests

Mocked protocol tests are the default because they are deterministic and free. The opt-in live suite checks the same adapters against credentials already resolved by rigyn:

```bash
npm run test:live --workspace rigyn
```

The script loads `.env.local` and `.env` when present, but the test code never reads, prints, snapshots, or enumerates secret values. Credentials flow through the normal credential broker. Ordinary `npm test` discovers this file but skips it.

By default the suite uses `openai` and prefers a low-cost live model. Non-secret selectors can override that choice:

```bash
RIGYN_LIVE_PROVIDER=anthropic \
RIGYN_LIVE_MODEL=claude-haiku-4-5 \
npm run test:live --workspace rigyn
```

The default scenarios cover text streaming, normalized usage, tool calls, multi-turn continuation, image input when confirmed by live metadata, and cancellation. Limit a run with `RIGYN_LIVE_SCENARIOS=text,tool`.

Prompt-cache validation is separate because it sends a sufficiently large repeated prefix and can incur additional token charges:

```bash
RIGYN_LIVE_CACHE=1 npm run test:live --workspace rigyn
```

The cache scenario runs only when live model metadata confirms caching. It verifies provider-reported cache counters; it never estimates a hit from repeated text.

Success means the selected provider:

- returns the requested model from live discovery;
- emits start, streamed content, normalized usage, and a terminal event;
- round-trips native continuation state across turns;
- produces a structured tool call when tool support is confirmed;
- accepts confirmed image input and honors cancellation;
- reports cache reads or writes when the explicit cache scenario is enabled.

These tests are compatibility probes, not unit tests or a billing-free health check. Use a dedicated low-spend project where possible.

When `OPENROUTER_API_KEY` is configured, `npm run test:live --workspace rigyn` also performs one low-volume image-generation request through the independent `rigyn/images` surface. It verifies brokered authentication, the maintained image catalog, the lazy SDK transport, and a non-empty base64 image result. This request can incur image-generation charges and remains disabled during ordinary `npm test` runs.
