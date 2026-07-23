---
name: build-extension
description: Design, implement, repair, test, or package a rigyn extension with tools, commands, providers, session behavior, terminal UI, processes, skills, prompts, themes, or a local dashboard.
compatibility: rigyn 0.4–0.6; Node.js 24.15+ or 26+ for runtime extensions.
allowed-tools: read bash edit write grep find ls
---

# Build a rigyn extension

Deliver a working installed extension, not a scaffold or a second agent harness.

## Read the installed contract first

Resolve every relative link from this file.

1. Read [the direct extension API](../../../docs/extensions.md) completely.
2. Read [package authoring](../../../docs/packages.md) when the result is installable, shared, fetched, or depends on another package.
3. Read [the TUI contract](../../../docs/tui.md) for dialogs, components, editor replacement, shortcuts, themes, or overlays.
4. Inspect the smallest matching example completely: its `package.json`, factory, README, and referenced resources.
5. When a signature is unclear, inspect the installed declarations under `../../../dist/extensions/` and the public subpath declarations. Do not invent methods or import private files.

The installed docs, declarations, and examples are authoritative for this host version. Ignore remembered APIs from other tools.

Bundled examples and installed package files are read-only references. Create the requested product in a fresh directory in the user's active workspace. Never edit the rigyn master source, installed package, or bundled examples unless the user explicitly asks to maintain those exact files.

## Choose a focused base

| Need | Example |
| --- | --- |
| First package, command, or tool | `../../../examples/starter/` |
| Lifecycle events and cleanup | `../../../examples/lifecycle-events/` |
| Flags, commands, or shortcuts | `../../../examples/command-controls/` |
| Replace or render a tool | `../../../examples/tool-rendering/` |
| Transform input or guard tool calls | `../../../examples/input-guard/` |
| Widgets, headers, status, or overlays | `../../../examples/ui-surfaces/` |
| Prompt context or compaction | `../../../examples/context-compaction/` |
| Custom messages or in-process topics | `../../../examples/messages-bus/` |
| Model or thinking controls | `../../../examples/model-controls/` |
| Replace or compose an existing provider | `../../../examples/provider-override/` |
| Replace the primary terminal editor | `../../../examples/raw-editor-ui/` |
| Inspect the current append-only session tree | `../../../examples/session-jsonl/` |
| New, fork, navigate, or switch session flows | `../../../examples/session-control/` |
| Session names, entries, labels, or renderers | `../../../examples/session-metadata/` |
| Bounded subprocess or worker protocol | `../../../examples/subprocess-workers/` |
| Runtime-selected skill, prompt, or theme paths | `../../../examples/dynamic-package/` |
| Browser dashboard | `../../../examples/starter/`, [dashboard checklist](references/dashboard.md), and `../../../docs/extensions.md` |

Combine contracts only when the requested product needs them. Do not copy every example into one package.

## Define success before writing code

Record a compact acceptance matrix:

- user entry point;
- visible result and empty/loading/success/cancel/error states;
- exact `ExtensionAPI` methods and callback context methods used;
- data that survives reload or restart;
- filesystem, process, network, credential, or terminal authority;
- focused tests and installed smoke command.

Ask only when a missing decision materially changes the product. Otherwise choose the smallest coherent behavior and state the assumption.

## Package shape

Prefer a prompt, skill, or theme when code is unnecessary. A runtime package normally contains:

```text
package.json
README.md
extensions/index.mjs
skills/<name>/SKILL.md   # optional
prompts/<name>.md        # optional
themes/<name>.json       # optional
test/runtime.test.mjs    # recommended
```

Declare only real resources:

```json
{
  "name": "@scope/package-name",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "rigyn": ">=0.4.0 <0.7.0"
  },
  "rigyn": {
    "extensions": ["extensions/index.mjs"]
  }
}
```

The factory is a default export:

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

Use `rigyn/extensions` for types and only documented public host subpaths at runtime. Put runtime libraries in `dependencies`, build/test tools in `devDependencies`, and rigyn itself in peer/development dependencies when declarations are needed. Never import `src/`, `dist/`, or another bundled rigyn runtime.

## Lifecycle requirements

- Activation must be deterministic and fast. Start long-lived work lazily unless it must exist immediately.
- Register every extension-owned timer, watcher, socket, server, subprocess, and temporary resource with `rigyn.onDispose`.
- Disposers run after the API is stale. They must release only captured extension-owned resources and must not call rigyn APIs.
- Propagate callback cancellation into tools, process execution, network calls, and queued work.
- A cancelled operation must settle itself without poisoning a later queued operation.
- Bound concurrency, duration, request bytes, output bytes, queues, retained snapshots, and collections.
- Treat reload as routine. The active generation receives `session_shutdown` before replacement activation. A failed candidate is disposed and the previous generation restarts; a successful candidate must not leave the old generation alive.

## Tools

- Give each tool one job and a closed JSON schema.
- Validate before side effects. Keep session and branch identity out of model-controlled input.
- Return a bounded array of text/image `content` blocks and JSON-safe `details`.
- Serialize structured model-visible data with `JSON.stringify`; never byte-slice serialized JSON into invalid output.
- Preserve useful text output even when a TUI renderer exists.
- Propagate `signal`; throttle and bound partial updates.
- Errors must state a root-cause category, a safe recovery step, and a stop condition without exposing secrets or raw remote bodies.

## Commands, sessions, and UI

- Validate and bound command arguments.
- Use `context.sessionManager` for the current session rather than opening its JSONL file.
- Use `newSession`, `fork`, `navigateTree`, and `switchSession` only from a command context and honor cancellation.
- Check `context.hasUI` before requiring interaction. Destructive actions require `context.ui.confirm`; a model-controlled boolean is not approval.
- Prefer notifications and dialogs before replacing structural UI.
- A custom editor must preserve submit, cancel, paste, resize, focus, accessibility, and host keybindings.
- Treat session and model text as private, untrusted content. Never inject it as raw HTML or terminal escape sequences.

## Providers and credentials

- Use `registerProvider` for a new provider or generation-owned replacement. Do not mutate private registries.
- Use `unregisterProvider` only for an earlier explicit opt-out; unload restores registrations automatically.
- Never hard-code, log, persist, display, or return real credentials.
- Bound and redact errors from external services. Do not reflect raw response bodies, authentication headers, or credential-bearing URLs.
- Declare exact network destinations and authentication expectations in the README.

## Processes

- Use `rigyn.exec` with a fixed executable and argv array. Never interpolate untrusted input into a shell command.
- Set an explicit timeout, propagate the callback signal, validate a framed response, and bound aggregate output.
- A subprocess worker is not automatically a child agent. The extension owns concurrency, recursion prevention, process-tree cleanup, protocol errors, and user-visible cancellation.
- Await every started process or own it as a bounded background job that is stopped during disposal.

## Verification

1. Test the factory through the real direct loader when the installed rigyn package is resolvable.
2. Cover malformed input plus the highest-risk cancellation, cleanup, provider, session, process, or UI boundary.
3. Prove failed activation commits nothing and a reload failure leaves the live generation usable.
4. Prove repeated activation/reload does not duplicate registrations or retain resources.
5. Run the focused test from the package root exactly as documented.
6. Run `rigyn extensions author report PACKAGE` on clean source.
7. Pack to an explicit destination and run the report on the exact unpacked archive.
8. Install that exact archive or source through `rigyn install`; run `/reload`; exercise the user-visible entry point; remove it; confirm cleanup.
9. Use `rigyn --extension PATH` only for an invocation-only source smoke. Do not use obsolete package flags.

The exact installed package, not only its source checkout, is the final verification target.

Treat a non-zero status, missing test discovery, wrong working directory, activation-only result, or undocumented manual patch as a failed verification.

## Completion report

Report the package root, entry point, visible behavior, authority used, focused tests, install/reload/remove evidence, and any remaining compatibility or publication caveat. Do not call the extension production-ready without exact installed-artifact evidence.
