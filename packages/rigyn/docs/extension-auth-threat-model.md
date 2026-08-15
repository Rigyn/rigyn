# Extension authentication threat model

rigyn extensions are trusted in-process Node.js code. Installing one gives it the filesystem, process, environment, and network authority of the rigyn process. The extension API is not a JavaScript sandbox.

The security boundary is:

- package review and immutable package records;
- project trust;
- process, account, container, or operating-system isolation.

## Direct provider authentication

An extension can register or replace a provider with `rigyn.registerProvider(name, config)`. The provider config can contain:

- a static API key for a private local integration;
- a managed `oauth` object with `login`, `refreshToken`, and `getApiKey` callbacks.

The host stores normalized credentials under the provider ID. It also supplies interaction callbacks for authorization URLs, device codes, prompts, progress, and selection.

Managed OAuth callbacks receive the secrets needed for that provider protocol. Keep those credentials ephemeral. Never write them to source, logs, diagnostics, session entries, tool results, messages, URLs, or unrelated network destinations.

`refreshToken` must return a normalized replacement. `getApiKey` must return only the request secret needed by the provider.

Ordinary direct factories do not receive the credential store, authentication broker, or a general-purpose “resolve secret” method. Callback contexts expose a `modelRegistry` for the documented provider/model operations, not raw credential persistence.

## Provider request hooks

- `before_provider_request` receives a detached provider-native JSON body and may return a complete JSON-safe replacement.
- `before_provider_headers` receives the complete assembled outgoing headers and can add, replace, or remove them, including authentication headers.
- `after_provider_response` receives the HTTP status and complete normalized response headers, including authentication and cookie headers. Response bodies and arbitrary provider-native stream state are not included.
- `registerProvider` may replace an existing provider generation. Unload or refresh removes that owner and restores the remaining registration stack.

These hooks belong to the trusted direct-extension tier. Extension code can already call `fetch`, read environment variables, open files, and inspect process memory. Header redaction is therefore not the extension security boundary. Bounded core diagnostics, session data, exports, logs, and RPC projections still redact credentials.

## UI, sessions, and output

Interactive callback contexts can observe terminal input, replace the editor, mount components, and inspect the active session projection. A trusted UI extension may therefore see user text and private session content. Renderer and event output is sanitized and bounded by the host, but the extension itself remains trusted code.

Session access is a read-only `sessionManager` projection plus explicit helpers such as `appendEntry`, `sendMessage`, `setSessionName`, and `setLabel`. There is no public mutable store handle. Do not copy credential material into durable session state.

## Lifecycle

Registrations belong to one activation generation. Failed activation commits nothing. Refresh and shutdown make the API stale before provider restoration and reverse-order `onDispose` cleanup.

Cleanup limits accidental retention. It cannot undo terminal bytes, filesystem writes, subprocess side effects, or network requests that already happened.

Use an external execution backend, container, or operating-system account when code is not trusted enough to run with the user’s authority.

Focused verification covers managed OAuth login/refresh, provider replacement/restoration, secret redaction, response telemetry, activation rollback, cancellation, and stale-generation rejection in the provider, authentication, and direct-extension test suites.
