# Extension authentication threat model

Runtime extensions are trusted executable Node.js code. Installing one grants it the normal filesystem, process, environment, and network authority of the Rigyn process. The package trust prompt, immutable package records, and project-package lock are therefore the primary defense against malicious extension code; the authentication broker is not a JavaScript sandbox.

The broker protects provider credentials from accidental exposure and from APIs that would otherwise make secrets a normal extension value. API keys, OAuth access and refresh tokens, cloud secret keys, signed headers, and credential-store records remain host-owned. They are not returned through extension APIs, events, RPC, session state, diagnostics, errors, or tool results.

An extension may register public authentication metadata and an exact request-origin allowlist. `api.auth.fetch` then enforces all of the following before attaching authority:

- the caller owns the current provider registration generation;
- the URL uses an allowed exact origin;
- caller-supplied authentication headers and redirects are rejected;
- the registered API-key, bearer, or AWS SigV4 strategy matches the resolved credential;
- request and response bodies are bounded and cancellation remains observable;
- refresh, logout, profile changes, and reload are resolved by the host for each request.

Authentication is intentionally provider-scoped rather than session-scoped. Session IDs and profile selectors are not accepted by `api.auth.fetch`, and extension requests cannot retarget the active credential by adding request metadata. Each call re-resolves the host-selected credential for the registered provider; profile selection remains an owner-level provider operation shared by that provider's sessions.

Rigyn intentionally rejects raw credential resolution, arbitrary authorization/header interception, and arbitrary provider-wire body replacement. Providers that require a different protocol must register a provider adapter and a bounded authentication descriptor.

This boundary limits accidental leaks and confused-deputy requests through the supported API. It cannot contain a malicious installed extension that reads host files or environment variables or opens its own network connection. Untrusted extensions require an external execution backend or operating-system isolation chosen by the owner.

Focused verification lives in `test/auth/authenticated-fetch.test.ts`, `test/extensions/runtime.test.ts`, and the provider/reload tests. It covers exact-origin enforcement, ownership and stale-generation rejection, caller header rejection, body bounds, cancellation, refresh/logout behavior, AWS signing, and secret-free public results.
