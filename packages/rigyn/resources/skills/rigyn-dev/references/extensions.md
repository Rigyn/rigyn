# Extend rigyn

Deliver a focused product that runs inside the active rigyn harness. Do not create a scaffold-only result, a second harness, or undeclared child-agent authority.

## Read the installed contract first

Resolve every relative link from this file.

1. Read [the extension overview](../../../../docs/extensions.md) completely.
2. Read [package authoring](../../../../docs/packages.md) when the result is installable, shared, fetched, or depends on another package.
3. Read the complete [API reference](../../../../docs/extension-api.md) when a signature or lifecycle detail is not shown by the focused example. Read [extension events](../../../../docs/extension-events.md) for event work. For behavior across hosts, use the [capability matrix](../../../../docs/extension-capabilities.md) and [mode contract](../../../../docs/modes.md); also read [RPC](../../../../docs/rpc.md) when an interaction must cross that protocol.
4. Read [the TUI contract](../../../../docs/tui.md) for dialogs, components, editor replacement, shortcuts, themes, or overlays.
5. Read [skill](../../../../docs/skills.md), [prompt-template](../../../../docs/prompt-templates.md), or [theme](../../../../docs/themes.md) authoring for the matching declarative resource.
6. Read [provider authoring](../../../../docs/provider-authoring.md) for a provider, authentication method, model catalog, or custom stream.
7. Inspect the smallest matching example completely: its `package.json`, factory, README, any example-local tests, and referenced resources. In a source checkout, inspect the nearest central conformance test when the example has no local test; do not copy its private imports into an extension package. Installed artifacts do not ship host source or central tests, so use their public declarations, examples, author checks, and real-loader smoke instead.
8. When a signature is unclear, inspect the installed public declarations under `../../../../dist/`. Do not import private source or invent methods.

The installed docs, declarations, and examples are authoritative for this host version. Bundled files are read-only references. Create the requested package in a fresh directory in the active workspace unless the user explicitly asks to maintain an existing package.

## Choose a focused example

| Need | Example |
| --- | --- |
| First package, command, or tool | `../../../../examples/starter/` |
| Lifecycle events and cleanup | `../../../../examples/lifecycle-events/` |
| Flags, commands, or shortcuts | `../../../../examples/command-controls/` |
| Replace or render a tool | `../../../../examples/tool-rendering/` |
| Transform input or guard calls | `../../../../examples/input-guard/` |
| Widgets, headers, status, overlays, or workbench UI | `../../../../examples/ui-surfaces/` and `../../../../examples/terminal-workbench/` |
| Prompt context or compaction | `../../../../examples/context-compaction/` |
| Custom messages or in-process topics | `../../../../examples/messages-bus/` |
| Model or thinking controls | `../../../../examples/model-controls/` |
| Replace or compose a provider | `../../../../examples/provider-override/` |
| Provider request and header hooks | `../../../../examples/provider-hooks/` |
| Provider authentication or refreshed catalogs | `../../../../examples/provider-catalog/` |
| Replace the primary editor | `../../../../examples/raw-editor-ui/` |
| Inspect the append-only session tree | `../../../../examples/session-jsonl/` |
| New, fork, navigate, or switch session flows | `../../../../examples/session-control/` |
| Guard compaction, tree, or session transitions | `../../../../examples/session-lifecycle/` |
| Session names, labels, entries, or renderers | `../../../../examples/session-metadata/` |
| Bounded subprocess protocol | `../../../../examples/subprocess-workers/` |
| Runtime-selected resources | `../../../../examples/dynamic-package/` |
| Inspect tools, commands, models, or resource discovery | `../../../../examples/runtime-catalog/` |
| Project-trust decisions | `../../../../examples/project-trust/` |
| Workspace memory or task state | `../../../../examples/state-and-policy/` |
| Local browser dashboard | `../../../../examples/starter/` plus the dashboard rules below |

Combine contracts only when the requested result needs them.

## Define success before code

Record a compact acceptance matrix:

- user entry point;
- target hosts and exact behavior when `context.hasUI` is false, including RPC serialization limits when applicable;
- visible empty, loading, active, success, cancel, and error states;
- exact public methods and callback-context methods used;
- whether compact UI belongs in the shared status row or in a dedicated widget;
- data that survives `/refresh` or process restart;
- filesystem, process, network, credential, or terminal authority;
- focused tests and the exact installed smoke command.

Ask only when a missing decision materially changes the product. Otherwise choose the smallest coherent behavior and state the assumption.

## Package contract

Prefer a prompt, skill, or theme when code is unnecessary. A runtime package normally contains:

```text
package.json
README.md
extensions/index.mjs
skills/<name>/SKILL.md   # optional
prompts/<name>.md        # optional
themes/<name>.json       # optional
checks/runtime.test.mjs  # recommended
```

Declare only resources that exist:

```json
{
  "name": "@scope/package-name",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "rigyn": ">=0.1.0 <0.2.0"
  },
  "rigyn": {
    "extensions": ["extensions/index.mjs"]
  }
}
```

The extension entry default-exports its activation factory:

```js
export default function activate(rigyn) {
  rigyn.registerCommand("command-name", {
    description: "User-visible purpose",
    async handler(args, context) {
      context.ui.notify(args, "info");
    },
  });
}
```

Use `rigyn/extensions` for types and only documented public host subpaths at runtime. Put runtime libraries in `dependencies`, build/test tools in `devDependencies`, and rigyn itself in peer and development dependencies when declarations are needed. Never import `src/`, `dist/`, or another bundled rigyn runtime.

## Lifecycle and authority

- Keep activation deterministic and fast. Start long-lived work lazily unless it must exist immediately.
- Register every raw extension-owned timer, watcher, socket, server, subprocess, and temporary resource with `rigyn.onDispose`. Host registrations and `rigyn.processes` workers are generation-owned.
- Disposers run after the API becomes stale. Release only captured extension-owned resources; do not call rigyn APIs from a disposer.
- Propagate callback cancellation into tools, processes, network calls, and queues. A cancelled operation must settle without poisoning later work.
- Bound concurrency, duration, request bytes, output bytes, queues, retained snapshots, and collections.
- Treat `/refresh` as routine. Failed activation commits nothing and must leave the previous generation usable; a successful candidate must leave no old generation alive.
- Do not create a child-agent authority implicitly. A subprocess worker remains extension-owned code with explicit concurrency, recursion prevention, cancellation, protocol validation, and cleanup.

## Tools, commands, sessions, and UI

- Give each tool one job and a closed JSON schema. Validate before side effects and keep host-controlled identity out of model-controlled input.
- Return bounded text or image `content` blocks plus JSON-safe `details`. Keep useful text output even when a custom renderer exists.
- Propagate `signal`; throttle and bound partial updates. A tool error should name a safe root-cause category and recovery step without exposing secrets or raw remote bodies.
- Validate and bound command arguments. Use `context.sessionManager`; never reopen the active JSONL session file.
- Use session navigation methods only from a command context and honor cancellation.
- Check `context.hasUI` before interaction. Destructive actions require `context.ui.confirm`; a model-controlled boolean is not approval.
- Use `context.ui.setStatus` for compact keyed text in the shared footer status row. Use `context.ui.setWidget` for independently placed content above or below the editor.
- Prefer notifications and dialogs before structural replacement. A custom editor must preserve submit, cancel, paste, resize, focus, accessibility, and active host keybindings.
- Treat session and model text as private, untrusted content. Never inject it as raw HTML or terminal control sequences.

## Providers and credentials

- Use `registerProvider` for a new provider or generation-owned replacement. Do not mutate private registries.
- Use `unregisterProvider` only for an earlier explicit opt-out; unload restores generation-owned registrations automatically.
- Never hard-code, log, persist, display, or return credentials.
- Bound and redact external failures. Do not reflect raw response bodies, authentication headers, or credential-bearing URLs.
- Declare exact network destinations and authentication expectations in the package README.

## Processes

- Use `rigyn.exec` for one bounded request whose buffered result is awaited. Use a fixed executable and argv array, set a timeout, propagate the callback signal, validate the response, and bound aggregate output.
- Use `rigyn.processes.spawn` only when work must continue after the callback returns or needs status subscriptions, framed input, backpressured output, or explicit cancellation. Start it lazily after activation commits; select bounded capture or consume pipes promptly.
- Never interpolate untrusted input into a shell command. Await or cancel raw child processes and stop them during disposal. Managed workers end automatically when their generation refreshes or closes, but the extension still owns protocol validation, task concurrency, and result delivery.

## Local dashboard rules

There is no dashboard to copy. Build one only when the user requests a browser UI, local control panel, or web view.

- Expose only state supplied by the public API. Derive a bounded current-session snapshot from `context.sessionManager`, current context usage, and canonical lifecycle events.
- Wire new, fork, navigate, switch, abort, steer, or follow-up controls to documented host methods. Omit unwired controls.
- Define connected, loading, empty, active, stale, cancelled, and error states. Do not fabricate token, cache, cost, reasoning, or session metadata.
- Bind to loopback and verify the bound address. Authenticate every endpoint with a high-entropy one-time bootstrap followed by an `HttpOnly`, `SameSite=Strict` cookie.
- Validate origin, fetch metadata, method, content type, and bounded bodies for mutations. Serve local assets with a restrictive content security policy.
- Never expose credentials, environment variables, arbitrary file reads, generic shell execution, or a remote bind.
- Start lazily from one command. Browser disconnect must not abort agent work unless the user requests it.
- Apply lifecycle events idempotently. Capture the server, sockets, timers, and pending writes in `rigyn.onDispose`; `/refresh` must release the port before the next generation activates.
- Render model content as text unless a reviewed sanitizer is present.

Verify loopback binding, authentication, one-time bootstrap, cross-origin rejection, body bounds, redaction, current-session snapshots, one real mutation, disposal, repeat activation on the same port, and startup from the exact installed package.

## Verify the package

1. Run the package-owned focused test. The starter shows a `node:test` registration recorder that invokes a command and tool without importing private rigyn files; it complements rather than replaces real-loader checks.
2. Cover malformed input and the highest-risk cancellation, cleanup, provider, session, process, or UI boundary.
3. Run `rigyn extensions author report PACKAGE_DIRECTORY` through the real direct loader. Author reports accept real local package directories, not `.tgz` files.
4. Treat the author `refresh` check as a valid-candidate repeat-activation smoke. It does not inject an activation failure or prove live rollback.
5. When failed-candidate rollback is a required boundary, use a disposable source-loaded copy in a real host: establish a working command, introduce an intentional activation failure in the copy, run `/refresh`, and confirm the old command still works. Never mutate the installed copy or a bundled example for this test.
6. Prove repeated activation and `/refresh` do not duplicate registrations or retain resources.
7. Run the author report on reviewed source. Here, clean source means the `author inspect` pack file set has been reviewed and excludes prior archives, package-local `node_modules`, credential files, and unrelated generated files; it does not require a Git repository or a globally clean monorepo.
8. Pack to an explicit destination directory outside the package root. Use the JSON `artifact` path and SHA-256 as the authority; `rigyn extensions author pack` validates those exact archive bytes, so a second report on extracted bytes is not required.
9. Install that archive with its absolute `npm:file:///...tgz` source (or install a reviewed source directory); run `/refresh`; exercise the user-visible entry point; remove it with the identical source string; confirm cleanup.
10. Use `rigyn --extension PATH` only for an invocation-only source smoke.

The exact installed package, not only the source checkout, is the final verification target. Treat a non-zero status, missing test discovery, wrong working directory, activation-only result, or undocumented manual patch as failed verification.

Report the package root, entry point, visible behavior, authority, focused tests, install/refresh/remove evidence, and any compatibility or publication caveat. Do not call an extension production-ready without installed-artifact evidence.
