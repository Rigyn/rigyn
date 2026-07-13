# Local dashboard checklist

Read this only when the extension request includes a browser UI, local dashboard, control panel, or web view.

There is intentionally no bundled dashboard implementation to copy or edit. Start a fresh package in the user's active workspace, use `../../../../examples/package-starter/` only for the manifest/runtime shape, and verify every host call against `../../../../docs/extensions.md`. The finished dashboard must prove the public extension API rather than inherit private example behavior.

## Product surface

A useful agent dashboard should make the current session understandable and controllable:

- connection and reload state;
- active session and branch, available sessions, selected model, and thinking level;
- conversation with streaming assistant text, reasoning summaries when available, tool calls, results, and errors;
- token usage, context pressure, cache activity, cost when known, retry state, and cancellation;
- steering and follow-up submission;
- abort, new session, fork, and switch actions when requested;
- clear empty, loading, active, disconnected, stale, cancelled, and error states.

Remove any control that is not wired to a real host action. Do not show fabricated metrics or placeholder history.

## Local security boundary

- Bind the listener to loopback only and verify the actual bound address.
- Generate a high-entropy launch token. Exchange it through a one-time bootstrap flow for an `HttpOnly`, `SameSite=Strict` session cookie; do not retain the token in browser storage or ordinary URLs.
- Require authentication for every state, event, and mutation endpoint.
- Check request origin and fetch metadata for mutations. Use explicit methods and reject unknown content types.
- Set a restrictive content security policy and ship browser assets locally. Do not permit arbitrary remote scripts, frames, or connections.
- Bound request bodies, headers, connections, event queues, retained snapshots, and log data. Apply idle timeouts.
- Never expose provider credentials, environment variables, filesystem reads, generic shell execution, arbitrary process spawning, or an unauthenticated remote bind.

## Runtime behavior

- Start lazily from one documented slash command and show the exact private URL once.
- Build the initial and reconnect conversation snapshot with cursor-paginated `api.getTranscript`; never read the session database or expose raw event envelopes. Then apply bounded live lifecycle updates or replaceable snapshots without duplicating actions.
- Serialize or identify mutations so double clicks and retries do not duplicate session operations.
- Treat browser disconnect as routine. Agent work continues unless the user explicitly aborts it.
- Close sockets and the listener on extension disposal; reload must release the port before the next generation becomes active.
- Keep browser presentation dependency-free when the product does not need a framework. If a dependency is justified, pin it through normal package metadata and verify the packed install.

## Visual quality

- Use a restrained responsive layout with a readable conversation column and a compact operational sidebar.
- Establish hierarchy with typography, spacing, semantic status color, and progressive detail—not decorative panels.
- Keep the composer and primary actions reachable at narrow widths.
- Preserve keyboard navigation, visible focus, labels, reduced-motion behavior, sufficient contrast, and selectable text.
- Render model content as text unless a reviewed sanitizer is deliberately included. Never inject raw model HTML.

## Verification

At minimum, prove with focused tests that:

1. the server binds only to loopback and rejects requests without valid authentication;
2. bootstrap cannot be replayed and establishes the protected cookie;
3. mutation validation rejects cross-origin, malformed, oversized, and unknown actions;
4. state/events are bounded and redact secrets;
5. a real session snapshot includes conversation and operational metadata;
6. steer or follow-up plus abort and one session action reach the host contract;
7. disposal closes the listener and a fresh activation can bind again;
8. the installed package starts through its documented command.
