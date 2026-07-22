# Local dashboard checklist

Use this only for a browser UI, local control panel, or web view. There is no bundled dashboard to copy. Start a fresh package in the user's workspace from `../../../../examples/starter/` and verify every host call against `../../../../docs/extensions.md`.

## Product contract

Expose only state the direct API can actually supply. A current-session dashboard can derive a bounded snapshot from `context.sessionManager`, current model/context usage, and canonical lifecycle events. New, fork, navigate, switch, abort, steer, or follow-up controls must call their documented host methods; omit controls that are not wired.

Define connected, loading, empty, active, stale, cancelled, and error states. Do not fabricate token, cache, cost, reasoning, or session metadata.

## Local security

- Bind only to loopback and verify the bound address.
- Generate a high-entropy one-time bootstrap token, then use an `HttpOnly`, `SameSite=Strict` cookie.
- Authenticate every state, event, and mutation endpoint.
- Validate origin, fetch metadata, method, content type, and a bounded request body for every mutation.
- Ship browser assets locally under a restrictive content security policy.
- Bound connections, queues, snapshots, headers, bodies, and idle time.
- Never expose credentials, environment variables, arbitrary file reads, generic shell execution, or a remote bind.

## Runtime behavior

- Start lazily from one slash command and show the private URL once.
- Build snapshots from the callback's read-only `sessionManager`; never reopen the JSONL file or expose raw entries without an explicit, bounded projection.
- Apply canonical lifecycle events idempotently and identify mutations so retries do not duplicate actions.
- Browser disconnect must not abort agent work unless the user explicitly requests abort.
- Capture the server, sockets, timers, and pending writes in `rigyn.onDispose`. Reload must release the port before the next generation becomes active.
- Render model content as text unless a reviewed sanitizer is included.

## Verification

Prove loopback binding, authentication, one-time bootstrap, cross-origin rejection, body bounds, output redaction, current-session snapshot correctness, one real host mutation, disposal, repeat activation on the same port, and startup through the exact installed package.
