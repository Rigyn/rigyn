# Extensions

Rigyn loads trusted extensions as direct in-process factories. The factory receives one stable `ExtensionAPI`; commands, tools, event handlers, providers, renderers, flags, and shortcuts registered during activation become visible only after activation succeeds.

For package layout, installation, integrity, and publishing, read [Extension packages](packages.md). The smallest runnable package is [`examples/starter`](../examples/starter/README.md).

## Activation lifecycle

```js
export default function activate(rigyn) {
  const timer = setInterval(() => {}, 1000);

  rigyn.onDispose(() => clearInterval(timer));
  rigyn.registerCommand("hello", {
    async handler(_args, context) {
      context.ui.notify("Hello.", "info");
    },
  });
}
```

Activation is transactional and time-bounded. A factory that throws, times out, or is cancelled commits no registrations. Its API becomes stale, then registered disposers run once in reverse order. Reload sends `session_shutdown` to the live generation before activating a candidate. A failed candidate is disposed and the previous generation is restarted; a successful candidate replaces it and makes the old API stale before disposal.

Use `onDispose` only for extension-owned resources such as timers, watchers, sockets, temporary files, or child processes. Host registrations and UI mounts are generation-owned and are removed automatically. Calling any generation API from a disposer fails because the API is already stale. One failing disposer is reported without skipping the remaining callbacks.

## Factory API

The direct factory API exposes:

- `onDispose(callback)` for generation cleanup;
- `on(event, handler)` for lifecycle, provider, message, tool, input, and session events;
- `registerTool`, `registerCommand`, `registerShortcut`, and `registerFlag`;
- `registerMessageRenderer` and `registerEntryRenderer`;
- `registerProvider` and `unregisterProvider`;
- `sendMessage`, `sendUserMessage`, `appendEntry`, session name and label helpers;
- `exec` for argv-based child processes;
- tool, command, model, and thinking-level selection helpers;
- `getCommands()` for the invokable extension-command, prompt-template, and skill-command catalog in host order;
- `getDiscoveryView` for the richer bounded prompt and skill metadata view;
- `events.on` and `events.emit` for bounded in-process coordination.

The API object is generation-scoped. Do not cache it across reloads.

Registrations remain live after activation. Re-registering a tool, its renderer, or a command with the same name from the same extension replaces that registration atomically. A tool name already owned by another extension keeps its first owner and produces a diagnostic.

## Commands and shortcuts

```js
rigyn.registerCommand("inspect-session", {
  description: "Show current session size",
  async handler(args, context) {
    const entries = context.sessionManager.getEntries();
    context.ui.notify(`${entries.length} entries; request: ${args}`, "info");
  },
});
```

Command and shortcut contexts provide:

- `cwd`, `mode`, `hasUI`, `signal`, and project-trust status;
- a read-only `sessionManager`, current `model`, and `modelRegistry`;
- `ui` dialogs, notifications, editor access, theme access, widgets, header/footer components, terminal input observation, and primary-editor replacement;
- idle, pending-message, abort, shutdown, context-usage, compaction, and system-prompt access;
- command-only `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, and `reload`.

Check `hasUI` before requiring a dialog. Headless behavior must fail closed for destructive or privileged actions. Command arguments are user input; validate and bound them before side effects.

## Tools

```js
rigyn.registerTool({
  name: "text_length",
  label: "Text length",
  description: "Count Unicode code points.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string", maxLength: 4096 } },
  },
  async execute(_callId, input, signal, onUpdate, context) {
    signal?.throwIfAborted();
    const count = [...input.text].length;
    return {
      content: [{ type: "text", text: JSON.stringify({ count }) }],
      details: { count },
    };
  },
});
```

Use a closed schema and validate before side effects. Tool output is an array of text or image blocks plus JSON-safe `details`; keep both bounded. Propagate cancellation. Optional call/result renderers must preserve a useful text observation for print, JSON, RPC, and non-image terminals.

Tool-call listeners may block calls, and tool-result listeners may replace bounded canonical result fields. Host validation runs after transformations. Never place host-controlled session identity into a model-controlled schema.

## Events

`rigyn.on` accepts these event families:

- project trust and dynamic resource discovery;
- session start, metadata change, pre-switch, pre-fork, pre-compaction, compaction, shutdown, pre-tree, and tree completion;
- context construction and pre-agent-start mutation;
- provider request hooks and complete request/response header hooks for trusted direct extensions;
- agent, turn, message, and tool-execution lifecycle;
- model and thinking-level selection;
- user shell, interactive input, tool call, and tool result.

Handlers receive immutable or validated canonical data and a generation-bound context. Keep handlers deterministic, abortable, and bounded. Streaming `message_update` events contain accumulated canonical snapshots plus provider-neutral update metadata; do not retain provider-native objects.

See [`lifecycle-events`](../examples/lifecycle-events/README.md) for the full agent/turn/message/tool sequence, [`provider-hooks`](../examples/provider-hooks/README.md) for transport-safe request and response observation, and [`session-lifecycle`](../examples/session-lifecycle/README.md) for guarded session transitions.

`rigyn.events` is an in-process topic bus. It is not durable and does not cross processes. Register its returned listener disposer when an earlier opt-out is needed; generation shutdown removes remaining listeners.

## Providers

`registerProvider(id, config)` composes a model provider registration. Registering an existing provider ID creates a generation-owned replacement; unloading restores the previous provider. Defined fields compose over the base registration, so a package can replace a catalog, transport family, base URL, display name, or headers without owning unrelated host state.

```js
rigyn.registerProvider("ollama", {
  name: "Local Ollama",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: [{
    id: "local-model",
    name: "Local model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  }],
});
```

Direct extensions use the public `@rigyn/models` `Model`, `Provider`, `Api`, and streaming contracts. A provider may declare a custom API identifier when it also supplies `streamSimple`; the host preserves that identifier in extension contexts and translates it explicitly at the core run-loop boundary.

Use `unregisterProvider(id)` for an earlier explicit removal. Do not place real credentials in source, package metadata, logs, tool output, or session records.

See [`provider-override`](../examples/provider-override/README.md) for replacement lifecycle, [`provider-catalog`](../examples/provider-catalog/README.md) for managed OAuth and refreshed catalogs, and [Providers](providers.md) for model fields and authentication behavior.

## Session data and flow

Callback contexts expose the current session through a read-only `SessionManager` projection. It includes the JSONL header, append-only entries, tree, labels, branch context, session name, file path, and leaf. Read through this projection instead of reopening the file. Session text is private and untrusted.

Commands may request a new session, fork at an entry, navigate the current tree, or switch to an explicit session file. The host validates the operation, requires idle state where necessary, emits lifecycle events, and owns the transition.

Factory-level `appendEntry`, `sendMessage`, `sendUserMessage`, naming, and labeling helpers act on the active bound session. They are unavailable during installation activation tests because no live session exists.

Pair `appendEntry(customType, data)` with `registerEntryRenderer(customType, renderer)`, and pair visible `sendMessage` calls with `registerMessageRenderer`. These renderers project the durable JSONL value directly: the same stored entry, ID, and order are used during live display and resume. Hidden messages stay hidden, and a renderer failure uses the host fallback without changing the session.

See [`session-jsonl`](../examples/session-jsonl/README.md), [`session-control`](../examples/session-control/README.md), [`session-lifecycle`](../examples/session-lifecycle/README.md), and [`session-metadata`](../examples/session-metadata/README.md).

## Terminal UI

The command context owns interactive UI. Simple extensions should use notifications, dialogs, text widgets, status, working messages, and editor text helpers. Trusted TUI extensions may import public components from `rigyn/tui` and install a complete editor factory, autocomplete wrapper, header, footer, widget, or custom overlay.

Raw editor replacement must preserve submission, cancellation, paste, keybindings, resize behavior, focus, and accessibility. UI mounts are generation-owned and restored on failure, reload, or close. See [`ui-surfaces`](../examples/ui-surfaces/README.md), [`raw-editor-ui`](../examples/raw-editor-ui/README.md), [`terminal-workbench`](../examples/terminal-workbench/README.md), and [Terminal UI](tui.md).

## Processes

`rigyn.exec(executable, argv, options)` executes an argv array without a shell. Always use a fixed executable, pass untrusted values as distinct arguments, set an explicit timeout, propagate the callback signal, validate output, and bound displayed or model-visible bytes.

Trusted direct extensions can compose subprocess agents through the installed Rigyn CLI. The package owns specialization, concurrency, recursion prevention, cancellation, structured output validation, process-tree cleanup, and failure isolation. See [`subprocess-workers`](../examples/subprocess-workers/README.md).

## Skills, prompts, and custom themes

Declare fixed resources in `package.json`. Use `resources_discover` only when paths depend on runtime initialization:

```js
rigyn.on("resources_discover", () => ({
  skillPaths: ["skills"],
  promptPaths: ["prompts"],
  themePaths: ["themes"],
}));
```

Relative paths resolve from the package root and remain within an approved resource boundary. See [`dynamic-package`](../examples/dynamic-package/README.md).

## Stable imports

TypeScript authors can import public declarations:

```ts
import type { ExtensionAPI } from "rigyn/extensions";

export default function activate(rigyn: ExtensionAPI): void {
  // registrations
}
```

Runtime code may import stable exported host modules such as `rigyn/tui`, `rigyn/providers`, and `rigyn/storage`. Do not import `src/`, `dist/`, private files, or a second bundled copy of Rigyn.

## Verification checklist

Before distribution, prove:

1. source validation and focused tests pass;
2. activation failure commits nothing and the prior generation survives;
3. timeout and cancellation settle cleanly;
4. disposers run once, in reverse order, with the API already stale;
5. repeated reload does not duplicate commands, listeners, providers, UI, timers, sockets, or processes;
6. headless behavior is safe;
7. the exact packed archive contains every declared file;
8. the exact installed copy performs its documented user-visible action;
9. removal restores provider, editor, process, and resource state.

The conformance suite in `packages/rigyn/test/extensions/direct-example-packages.test.ts` activates every bundled example through `DefaultPackageManager` and the direct runtime.
