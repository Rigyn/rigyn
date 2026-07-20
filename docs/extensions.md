# Extensions

Rigyn supports declarative resources and trusted runtime code through one package format. The runtime API is provider-neutral and session-aware, so an extension can add a complete workflow without patching the harness.

The working example is [`examples/reference-package`](../examples/reference-package/README.md). It runs offline and demonstrates a model provider, tool, renderer, slash command, shortcut, CLI flag, lifecycle events, durable state, skill, prompt, and theme. For a copyable starter, focused examples, versioning, integrity, and publication guidance, see [Package authoring and local gallery](packages.md).

## Agent-assisted authoring

Every standard installation includes two progressively loaded authoring resources:

- `/build-extension <request>` expands a focused implementation prompt;
- `/skill:build-extension <request>` loads the complete API-routing, quality, failure, install, reload, and release workflow.

The skill is also advertised to the model for ordinary extension-authoring requests, so a request such as “build a session dashboard extension” should load the workflow without requiring the slash command. The base system prompt contains only the skill description and installed documentation paths; the larger checklist enters context only for matching work.

The workflow routes authors to one focused example rather than merging the whole gallery. Dashboard work starts fresh from [`examples/package-starter`](../examples/package-starter/README.md) plus the bundled security/product checklist; ordinary tool work routes to [`examples/custom-tool`](../examples/custom-tool/README.md); tool guards and transforms to [`examples/tool-lifecycle`](../examples/tool-lifecycle/README.md); approval-gated actions to [`examples/approval-gate`](../examples/approval-gate/README.md); dynamic catalogs to [`examples/dynamic-tools`](../examples/dynamic-tools/README.md); compaction overrides to [`examples/custom-compaction`](../examples/custom-compaction/README.md); parallel child delegation to [`examples/child-coordinator`](../examples/child-coordinator/README.md); fixed MCP stdio boundaries to [`examples/mcp-stdio`](../examples/mcp-stdio/README.md); authenticated providers to [`examples/brokered-provider`](../examples/brokered-provider/README.md); stateful work to [`examples/session-notes`](../examples/session-notes/README.md); state upgrades to [`examples/state-migration`](../examples/state-migration/README.md); runtime coordination to [`examples/shared-events`](../examples/shared-events/README.md); reload cleanup to [`examples/reload-safety`](../examples/reload-safety/README.md); and multi-contribution packages to [`examples/reference-package`](../examples/reference-package/README.md). These paths are included in the published artifact. In a source checkout they are under `examples/`; in the default self-contained install they are under `~/.rigyn/app/node_modules/rigyn/examples/` (replace `~/.rigyn` with `RIGYN_INSTALL_DIR` when customized). Use an example's absolute directory as the working directory so its commands work unchanged.

Focused host-observability and workflow contracts have their own examples: [`advanced-ui`](../examples/advanced-ui/README.md) for the permission-gated structural TUI tier, [`child-specialist`](../examples/child-specialist/README.md) for child-only instructions, [`paged-memory`](../examples/paged-memory/README.md) for cursor-based namespaced messages, [`session-analytics`](../examples/session-analytics/README.md) for durable usage, [`provider-lifecycle`](../examples/provider-lifecycle/README.md) for provider disposal, [`resource-discovery`](../examples/resource-discovery/README.md) for commands/prompts/skills, [`prompt-inspector`](../examples/prompt-inspector/README.md) for safe prompt metadata, [`review-workflow`](../examples/review-workflow/README.md) for a tool-to-child-to-state workflow, and [`session-tools`](../examples/session-tools/README.md) for bounded session browsing.

Use `/build-extension` when you want the agent to own implementation and verification. Use `/skill:build-extension` when you want to supply a more conversational request while forcing the authoring workflow. `--no-skills` and `--no-prompt-templates` disable the corresponding bundled resource for a deliberately minimal invocation.

## Discovery and trust

Extensions are discovered from:

```text
$XDG_CONFIG_HOME/rigyn/extensions/    user scope
WORKSPACE/.rigyn/extensions/               trusted project scope
--extension PATH                             explicit invocation scope
installed packages                           user or project scope
```

User and explicit resources are trusted by the person who loaded them. Project runtime code and project configuration are ignored until the workspace is trusted. Runtime extensions execute as ordinary Node.js modules with the invoking user's filesystem, process, environment, and network access; there is no isolation boundary around extension code. Host validation and redaction reduce accidental misuse, but they do not contain a malicious extension or prevent it from exfiltrating data available to the invoking user.

When protected project resources exist and no CLI trust override was supplied, already-authorized user and explicit `--extension` runtime entries may participate in the decision:

```js
export default function activate(api) {
  api.on("project_trust", async ({ workspace, cwd }, context) => {
    if (!context.ui.hasUI) return { decision: "undecided" };
    const accepted = await context.ui.confirm(
      "Project resources",
      `Enable reviewed resources from ${workspace}?`
    );
    return { decision: accepted ? "yes" : "no", remember: true };
  });
}
```

The first `yes` or `no` result wins. `undecided`, invalid results, and listener failures allow later listeners and then host policy to continue. An extension result is considered before a saved decision, the configured default, and the built-in chooser. `remember: true` writes only the exact canonical workspace; without it, the result lasts for the current launch. The listener context intentionally exposes only `ui.hasUI` and `ui.confirm`, and headless confirmation rejects. CLI `--approve`/`--no-approve` and workspaces with no protected resources suppress the event. Project code is never loaded to decide whether that same project code should be trusted.

The pre-trust extension host is retained during runtime construction. If approval enables project entries, they append to that host; user and explicit entries do not activate twice. The same process applies before opening a cross-workspace resumed session.

Precedence is deterministic. A later, higher-precedence extension with the same ID shadows the earlier one and emits a diagnostic. Invalid resources are isolated so one bad package does not hide valid siblings.

## Manifest

An extension root contains `extension.json`:

```json
{
  "schemaVersion": 1,
  "id": "workspace-tools",
  "name": "Workspace tools",
  "version": "1.0.0",
  "description": "Project-specific coding helpers",
  "enabled": true,
  "contributions": {
    "skillRoots": [{ "path": "skills" }],
    "prompts": [
      {
        "id": "review-change",
        "path": "prompts/review-change.md",
        "description": "Review a requested change"
      }
    ],
    "commands": [
      {
        "name": "release-check",
        "path": "commands/release-check.md",
        "description": "Run the release checklist",
        "argumentHint": "[package]"
      }
    ],
    "themes": [
      {
        "name": "workspace-dark",
        "path": "themes/workspace-dark.json"
      }
    ],
    "runtime": [{ "path": "runtime/index.mjs" }]
  }
}
```

All paths are normalized and relative to the extension root. Runtime files may end in `.ts`, `.mts`, `.js`, or `.mjs`. IDs and slash-command names may not collide with built-in commands. Optional `integrity` entries map relative paths to lowercase SHA-256 digests.

The optional `permissions` object declares exceptional host authority. Supported booleans are `advancedUi`, `nativeUi`, `unsafeTerminal`, `providerOverride`, `providerWire`, `credentialAccess`, `sessionRaw`, and `hostConfiguration`. Omit every permission the extension does not need. A declaration is necessary but not sufficient: the runtime must also be accepted by the host's trusted local or managed-package policy, and project code remains blocked until its workspace is trusted. Ordinary tools, commands, renderers, resources, namespaced state, child runs, and brokered provider requests require none of these permissions.

`advancedUi` enables bounded structural chrome and observation. `nativeUi` enables decoded input and full editor ownership. `unsafeTerminal` additionally enables raw input transformation and unvalidated terminal writes; it can observe anything typed while active and is appropriate only for fully reviewed local code. `providerOverride` and `providerWire` enable generation-owned provider replacement and transport interception. `credentialAccess` exposes the active access credential through `api.native.credentials.resolve`; it also permits managed provider-authentication callbacks, whose refresh contract necessarily receives the provider refresh token. Neither surface exposes a credential-store handle. `sessionRaw` exposes bounded raw event/run pages and process-local unredacted prompt snapshots. `hostConfiguration` exposes effective paths/settings and validated user or trusted-project configuration updates. Every privileged handle becomes stale when its generation unloads. Review the [extension authentication threat model](extension-auth-threat-model.md) before granting provider or credential permissions.

TypeScript runtime entries use a scoped transform loader, so ordinary package syntax such as enums and parameter properties works in addition to erasable types. Multi-file ESM packages should declare `"type": "module"` in their nearest `package.json` (or use `.mts`) and keep runtime imports in `dependencies`. Loading is transpile-only; type-check the package in its own test or release workflow.

## Runtime entry point

A runtime module default-exports an activation function:

```js
export default function activate(api) {
  api.registerTool({
    name: "workspace_stats",
    description: "Return a small source-file summary for the active workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    async execute(_input, context) {
      return {
        content: `workspace: ${context.workspace.root}`,
        isError: false
      };
    }
  });

  api.registerCommand({
    name: "workspace-stats",
    description: "Ask the agent to inspect this workspace.",
    execute(context) {
      context.ui.setStatus("workspace-stats", "queued");
      return { prompt: "Use workspace_stats and explain the result." };
    }
  });

  api.ui.setWidget("workspace-stats", "Workspace stats ready");
  api.onDispose(() => {
    // Release resources created during activation.
  });
}
```

Activation is transactional: staged registrations become visible only after the module finishes successfully. Reload activates a candidate generation before disposing the old generation; a failed candidate leaves the previous runtime usable. Import plus activation is bounded to 30 seconds so one unresolved extension cannot freeze startup or reload. `api.signal` aborts when activation fails, a reload replaces the generation, or the host closes; use it for initialization work and retain `onDispose` for cleanup. The generation-bound API, UI, auth, session, command, and tool surfaces are inactive before disposers run, so an `onDispose` callback may only release or await raw resources that the extension already owns.

### Typed tool authoring

TypeScript extensions can use the generic helper from the public extension subpath. It returns the ordinary runtime registration, so registration bounds, schema revalidation, resource coordination, cancellation, result limits, and path policy remain host-owned:

```ts
import { defineRuntimeTool } from "rigyn/extensions";

api.registerTool(defineRuntimeTool<{ path: string }>({
  name: "inspect_path",
  description: "Inspect one path through extension-owned logic.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }
  },
  async execute(input, context) {
    context.signal.throwIfAborted();
    return { content: input.path, isError: false };
  }
}));
```

The helper validates that the schema uses Rigyn's supported bounded JSON Schema subset before registration. The generic type is authoring-time guidance, not a replacement for runtime schema validation. Filesystem tools must still use the host path/backend contracts; this helper does not grant a path-policy bypass.

Managed runtime entries may value-import only these exact host-owned modules: `rigyn/context`, `rigyn/core`, `rigyn/extensions`, `rigyn/images`, `rigyn/net`, `rigyn/process`, `rigyn/prompts`, `rigyn/providers`, `rigyn/testing`, `rigyn/tools`, and `rigyn/tui`. Rigyn resolves those specifiers to the active host, including for supported ESM, scoped TypeScript, and CommonJS entries, so an installed package does not need or receive a nested runtime copy. The root `rigyn` module and every unlisted or deeper subpath are rejected. Keep a compatible `rigyn` peer and development dependency for authoring declarations and standalone tests. This import allowlist limits the public host surface; it does not sandbox trusted extension code.

## Runtime resource discovery

Use the `resources_discover` lifecycle event only when skill, prompt, or theme paths depend on runtime initialization. Prefer manifest contributions for fixed package resources. The focused [`examples/dynamic-resources`](../examples/dynamic-resources/README.md) extension is directly runnable.

```js
export default function activate(api) {
  api.on("resources_discover", ({ reason }, context) => {
    context.signal.throwIfAborted();
    return {
      skillPaths: ["skills"],
      promptPaths: ["prompts"],
      themePaths: ["themes"]
    };
  });
}
```

The hook runs after every candidate runtime has activated and before final skill, prompt, and theme discovery. `reason` is `"startup"` or `"reload"`. Relative paths resolve from the contributing extension package root, never the process working directory. Absolute paths are accepted only when they remain inside that package root or the same extension's `api.dataPaths.user` or `api.dataPaths.workspace` root. Paths must already exist, must be regular files or directories, and cannot contain symbolic-link components. Escapes, cross-extension paths, untrusted contributions, malformed results, and duplicate canonical paths are diagnosed and ignored.

Each listener may return at most 64 paths across the three arrays, and one generation accepts at most 256 discovered paths. Listeners run in deterministic extension and registration order and receive the caller/generation cancellation signal. Discovery happens only while building a candidate generation; successful reload atomically replaces its discovered resources, while a failed or cancelled candidate leaves the active generation unchanged.

## Extension-owned data paths

`api.dataPaths.user` is a stable directory for this extension across workspaces. `api.dataPaths.workspace` is isolated by the current canonical workspace. The host creates both as private canonical directories before activation; installed builds place them under the Rigyn state directory, outside package files and the credential store. Package upgrade or reload therefore does not overwrite extension data, and one workspace cannot accidentally reuse another workspace's files.

Use these paths only when a real file or external database is required. Session-attached JSON belongs in `api.session`, where branch identity and compare-and-append are host managed. Extensions still own file formats, atomic writes, multi-process locking, migrations, size limits, cleanup, and validation under their data paths. Never persist API keys, OAuth tokens, authorization headers, or other credentials there. Ordinary authenticated provider requests stay behind `api.auth.fetch`; reviewed `credentialAccess` values must remain ephemeral under the native-tier rules below.

Generated skills, prompts, or themes may be written below an owned data path and returned from `resources_discover` as an absolute path. Do not write generated resources into the installed package directory.

## Tools

`registerTool` accepts:

- `name`, `description`, and a JSON input schema;
- optional `loading: "eager" | "deferred"`; supporting verified OpenAI and Anthropic model families may load a deferred definition through provider-native tool search, while every other provider/model receives the complete definition;
- optional `promptSnippet` for a concise `Available tools` entry and `promptGuidelines` for active-tool usage guidance;
- optional input preparation and validation;
- `executionMode: "parallel" | "sequential"`;
- optional resource claims for conflict-aware scheduling;
- an async `execute(input, context)` returning `{ content, isError, status?, summary?, nextActions?, terminate?, metadata?, artifacts?, images? }`.

The execution context supplies the host-owned `threadId`, `runId`, and exact session `branch` for service-managed runs. Use these values for branch-aware session actions and child delegation; session identity does not belong in model-controlled tool input. It also supplies `mode`, `hasUI`, and `ui`: interactive tool calls can use native dialogs and components, while headless calls retain the presentation-only UI methods and reject interactive operations explicitly.

`content` and `isError` are required. `content` must be a string; serialize structured domain data with `JSON.stringify(...)` and parse it in tests rather than returning an object. `isError` must be a boolean. `status` is `success`, `warning`, or `error`; `summary` is one bounded outcome line; and `nextActions` contains bounded recovery steps. Put these fields on the tool result itself instead of duplicating them inside JSON `content`. Keep domain data in bounded text or serialized JSON content. `artifacts` is reserved for actual host-written artifact descriptors, not an empty observation placeholder.

Tools are parallel by default. Sequential tools form source-order barriers. Resource claims let independent invocations run together while serializing operations that target the same logical resource. An extension may intentionally override a built-in tool name; the active tool list makes that choice visible.

Installed extension tools are active by default alongside the built-in coding tools. `--tools` is an explicit allowlist over both built-in and extension names, `--exclude-tools` removes named tools, `--no-builtin-tools` keeps only extension tools, and `--no-tools` disables both sets.

Tool output is subject to the same structural validation, durable eventing, cancellation, progress, artifact quotas, and transcript rendering as built-in tools. During long work, `context.reportProgress` accepts either bounded process output (`{ type: "output", stream, delta, stdoutBytes, stderrBytes, ... }`) or a replaceable native result (`{ type: "result", content, isError, metadata? }`). Partial results are durable and visible but never enter the model-visible terminal result. Aggregate or throttle rapid streams: one invocation accepts at most 256 updates and 256 KiB of progress. Always return the complete terminal result from `execute`.

`registerToolRenderer` can replace the native call or result slot with structural lines and semantic theme roles. `renderResult` receives `view.isPartial === true` for a live replaceable result and receives the terminal result with `isPartial` absent or false. The same renderer therefore owns the loading and completed states without creating a separate UI surface.

Prompt metadata is included only for tools selected at the start of a run. A custom tool without `promptSnippet` remains available through its provider tool definition but does not add another base-prompt line. Guidelines should name their tool explicitly because they are appended as flat bullets.

Extensions may register a larger tool catalog and keep a loader tool active. `setActiveTools` queues an atomic selection for the next provider turn; unknown names are rejected and an executing batch keeps its original snapshot. Every provider receives the complete definition list for the next selected set. This remains the portable dynamic-loading fallback. Tools marked `loading: "deferred"` may instead use provider-native search on verified compatible OpenAI and Anthropic model families; unsupported, proxied, disabled, conflicting, or unknown cases receive complete definitions normally.

Tool renderer fallback is per slot. If `renderCall` or `renderResult` is absent, returns `undefined`, produces invalid structural data, or throws, the corresponding native host presentation remains visible. An extension can therefore override a built-in tool implementation or just one render slot without taking ownership of the other slot.

`terminate: true` is an early-completion hint for tools that themselves produce the final outcome. The agent stops before another model request only when every finalized result in the provider-requested batch sets the hint. All calls still receive durable results, malformed or blocked calls prevent termination, and a steering message accepted during the batch takes precedence. A `tool_result` listener may set or clear the hint.

## Commands, shortcuts, flags, and UI

`registerCommand` adds a slash command with optional argument completions. It may perform work directly, return a prompt string, or return `{ prompt }` to enter the normal agent loop.

The command context exposes the active workspace, thread and branch, cancellation signal, arguments, and UI operations:

- notification, status, widget, and title updates;
- keyed, persistent header and footer text outside the scrolling transcript;
- working-message and working-indicator visibility overrides;
- selection, confirmation, text input, and multiline editor dialogs;
- editor text read/write;
- live theme query and selection;
- custom inline or overlay components.

Lifecycle listeners receive the same UI surface as `context.ui`. Interactive operations work in the TUI; presentation-only status, widget, header, footer, title, and notification methods remain usable in headless hosts. Interactive calls reject explicitly when the host has no interactive client, rather than hanging.

`registerShortcut` adds a remappable key action. `registerFlag` declares a boolean or string CLI flag available during activation through `getFlag`.

Top-level `api.ui` operations may establish initial status, widgets, headers, footers, working state, titles, and notices. `api.ui.registerAutocompleteProvider` and `api.ui.registerEditorMiddleware` add bounded composable input behavior without exposing the terminal controller. `api.registerEditorRenderer` may replace only the editor's structural block; the host still owns the text, grapheme cursor, editing commands, submission, interrupt behavior, and terminal protocol. Its lines, spans, semantic roles, dimensions, and required cursor are validated, and invalid output falls back to the native editor. These operations are rolled back with the extension generation.

The supported component contract, focus and overlay rules, sizing model, lifecycle, and a complete focused example are documented in [Extension TUI](tui.md).

### Trusted advanced UI

`api.ui.advanced` is an explicit TUI-only tier for persistent presentation that cannot be expressed by ordinary notices, text headers, dialogs, or overlays. It is available only when the extension manifest declares `"permissions": { "advancedUi": true }` and the runtime is accepted by the host's trusted local or managed-package policy. The permission does not make an untrusted project executable.

The surface remains structural and bounded:

- `setComponent(slot, key, factory?)` installs or clears a keyed `header`, `footer`, legacy `widget`, explicit `widget-above` or `widget-below` component. The `header-replacement` and `footer-replacement` slots replace the complete corresponding host region; removing their last owner restores native chrome;
- `setWorkingIndicator({ frames, intervalMs }?)` supplies a bounded activity animation;
- `setHiddenReasoningLabel(label?)` changes only the label used for collapsed reasoning;
- `getToolOutputExpanded()` reads the interactive TUI preference, while `setToolOutputExpanded(value?)` temporarily overrides it for this extension generation;
- `observeKeys(observer)` observes sanitized decoded key metadata and returns an idempotent disposer.

Component factories may return a component immediately or asynchronously and use the same validated lines and semantic spans as ordinary extension UI. A pending asynchronous component reserves no terminal rows and late resolution after unload is discarded and disposed. Components cannot access terminal bytes, emit ANSI, own the screen, replace input handling, or control submission. Key observers cannot consume input or prevent host shortcuts, editing, focus, or submission, and secret entry is not delivered to them.

Every advanced operation is namespaced to its owning extension generation. Persistent components are keyed within that owner. Global overrides are insertion-ordered and last-wins; clearing or ending the current generation restores the previous live owner, and removing the final tool-output override restores the exact user preference underneath it. Abort, failed activation, reload, reset, and host close remove generation-owned presentation. See [`examples/advanced-ui`](../examples/advanced-ui/README.md) for the focused package.

## Provider and authentication extensions

`registerProvider` accepts the same provider-neutral adapter contract used by the built-ins: `id`, `stream(request, signal)`, and optional model catalog methods. Streaming yields normalized response, text, reasoning, tool-call, usage, end, and error events. The returned async disposer is idempotent and may remove only that extension generation's exact adapter; it also removes generation-owned authentication metadata and the live registry entry.

Provider packages that need a stable presentation or diagnostic feed can wrap their normalized stream with `projectProviderStream` from `rigyn/providers`. Its sequence-bearing envelopes include interleaved text, reasoning, partial tool-call state, safe response IDs, normalized usage, and bounded terminal/error metadata. They exclude continuation state, unknown raw events, raw usage/errors, response bodies, credentials, and non-allowlisted headers. Partial tool arguments are untrusted best-effort JSON, not schema-validated executable input.

`defineProviderAdapter` from `rigyn/providers` supplies provider IDs, observation evidence, and conservative defaults for compact model rows while returning the normal `ProviderAdapter` contract:

```ts
import { defineProviderAdapter } from "rigyn/providers";

api.registerProvider(defineProviderAdapter({
  id: "company",
  models: [{
    id: "company-code-v1",
    contextTokens: 128_000,
    capabilities: { tools: true, reasoning: "unknown", images: false }
  }],
  async *stream(request, signal) {
    signal.throwIfAborted();
    // Encode the company protocol here and yield normalized AdapterEvent values.
    yield { type: "response_start", model: request.model };
    yield {
      type: "response_end",
      reason: "stop",
      state: {
        kind: "chat_completions",
        assistantMessage: { role: "assistant", content: "" }
      }
    };
  }
}));
```

Dynamic catalogs may provide `models(signal)` instead of an array. Catalog rows pass through the same provider registry normalization, size limits, evidence validation, and duplicate handling used for built-ins. The helper never accepts credentials, headers, raw-body transforms, or a transport callback: wire encoding stays in the authored adapter, and authenticated network calls use the generation-bound broker described below.

`defineRoutedProviderAdapter` composes separately configured adapters behind one provider ID when an upstream service assigns different models to different wire protocols. Every route names one exact public model, its explicit protocol family, its delegate adapter, and an optional exact upstream model alias. Duplicate routes, unlisted request models, non-canonical model IDs, missing upstream catalog rows, and protocol-metadata conflicts fail closed. The helper never infers a protocol from a model name. Continuation state is tagged with the exact route and live router generation, survives normal session persistence, and is passed only back to that same delegate route; state from another route, protocol, or router generation is withheld. Session/cache metadata, cancellation, and errors pass directly to the selected delegate. `delegateOwnership` is mandatory: `"owned"` makes the router dispose each distinct delegate exactly once, so those delegates must not be registered or shared elsewhere; `"borrowed"` leaves their lifecycle with the caller and is required for shared delegates.

```ts
import { defineRoutedProviderAdapter } from "rigyn/providers";

api.registerProvider(defineRoutedProviderAdapter({
  id: "company",
  delegateOwnership: "owned",
  routes: [
    { model: "fast", upstreamModel: "responses-v2", protocolFamily: "openai-responses", adapter: responses },
    { model: "deep", upstreamModel: "messages-v3", protocolFamily: "anthropic-messages", adapter: messages }
  ]
}));
```

`registerProviderAuth` can attach one or more methods to that provider:

- API key;
- OAuth 2.0 authorization-code flow with PKCE and loopback callback;
- OAuth 2.0 device flow;
- AWS, Google, or Azure ambient identity.

OAuth descriptors contain only public client registration data and HTTPS endpoints. Secret resolution remains in the central credential broker. A provider extension declares an exact `request.origins` allowlist plus the host-owned API-key, bearer, or AWS SigV4 authentication strategy. It then calls `api.auth.fetch(provider, input, init?, signal?)`. The host validates the origin, rejects caller-supplied authorization headers and redirects, refreshes or resolves the selected credential, authenticates the request inside the broker boundary, and returns a bounded `Response`. Through this ordinary brokered surface, API keys, access/refresh tokens, cloud secret keys, and signed-request material are never returned to extension code.

Authenticated request authority belongs only to the extension generation that registered the descriptor. A different extension, a stale generation, an unlisted origin, or an authentication strategy that does not match the selected credential fails before a credential is attached. Reload, cancellation, logout, profile changes, and credential refresh are observed on the next request because the ordinary brokered surface returns no reusable credential handle or string.

An auth descriptor may give its provider a distinct `credentialId` for a separately stored account. It cannot select an ID already bound to another registered provider. Intentional credential sharing belongs in host provider configuration, where every affected provider is explicit, rather than in runtime extension code.

When a provider's login and refresh protocol cannot be represented by the declarative PKCE or device descriptors, a reviewed package may register a `managed_oauth` method. This is a privileged escape hatch: the runtime must be trusted and its manifest must declare `credentialAccess`. Its `login` callback receives a host-owned interaction object with `showAuthorization`, `showDeviceCode`, `showProgress`, `prompt`, `select`, and a cancellation signal. Its `refresh` callback receives the normalized OAuth credential, including the refresh token, plus a cancellation signal. The optional `getApiKey` callback projects a provider-specific request secret inside the broker, while `modifyModels` can project a detached catalog only when the matching OAuth account is active.

Managed callbacks never receive the credential store. Initial login must return an access token, a refresh token, and a future expiry; refresh may omit an unchanged refresh token, account identity, or scopes, which the host preserves. Every returned credential, API-key projection, and model array is bounded and validated before use. Registration, refresh routing, catalog projection, and broker projection belong to the activation generation, so failed activation, reload, or disposal removes them together. Never log, persist, or place callback credentials in extension state or output.

## Reviewed native host integrations

`api.native` is a separately reviewed tier for packages whose product cannot be implemented through ordinary UI, brokered authentication, provider registration, transcript projection, or host-owned configuration. A package must be accepted by the trusted local or managed-package policy and declare each exact permission in `extension.json`; declarations do not activate an untrusted project entry.

| Permission | Native surface | Authority and remaining boundary |
| --- | --- | --- |
| `nativeUi` | `api.native.ui` | Intercept decoded input; replace or wrap the editor and autocomplete; mount persistent components; paste; inspect resolved themes. Raw terminal bytes and unvalidated ANSI remain unavailable. |
| `unsafeTerminal` | `api.native.terminal` | Intercept, consume, or rewrite raw terminal input; emit arbitrary terminal protocol bytes; request host redraw; inspect terminal size/capabilities and active keybindings. This authority can observe secret input and corrupt terminal state. |
| `providerOverride` | `api.native.providers.override`, `api.native.providers.overlay` | Replace a complete provider or overlay only its display name, secure base URL, headers, models, catalog loader, or streaming implementation. Unspecified authentication and behavior remain active; disposal or unload restores the exact prior composition. |
| `providerWire` | `api.native.providers.intercept` | Transform bounded JSON requests, secure request destinations, and outgoing headers and observe response headers. `baseUrl` rebasing preserves credential-bearing query values without exposing them; inbound WebSocket content and response bodies remain hidden. |
| `credentialAccess` | `api.native.credentials.resolve`; `managed_oauth` callbacks registered through `api.registerProviderAuth` | Receive the active access credential and derived request headers. Managed login/refresh callbacks additionally receive the provider OAuth values required by that protocol, including the refresh token. Credential-store handles remain unavailable. |
| `sessionRaw` | `api.native.session` | Page canonical event/run snapshots and optional compacted context, or read a process-local unredacted prompt snapshot. The caller receives neither a mutable store handle nor broader workspace ownership. |
| `hostConfiguration` | `api.native.host` | Read effective paths/settings and apply validated user or trusted-project patches. This is not arbitrary file-write authority. |

Native handles and returned disposers belong to one activation generation. Caller cancellation and `api.signal` abort invalidate pending work; failed candidate activation, successful reload, and unload must remove provider/UI registrations before another generation becomes active. Treat credential and raw-session values as ephemeral: never log, persist, place them in session state or extension output, or send them outside the reviewed integration. A package requesting this tier should start from [`examples/trusted-native-host`](../examples/trusted-native-host/README.md), document why each ordinary boundary is insufficient, and include negative tests for missing permission, missing trust, stale handles, abort, rollback, and cleanup. Review the [extension authentication threat model](extension-auth-threat-model.md) before installation.

## Events

`api.on(name, listener)` observes or reduces lifecycle events. Available groups include:

- session start/end/shutdown, committed session-name changes, switch/fork/tree guards, tree completion, and compaction guards/completion;
- before-agent, agent start/end/settled, turn start/end;
- message start/update/end;
- tool execution start/update/end, tool-call guard, and tool-result transform;
- context and user-input transforms;
- model and thinking-level selection;
- canonical before-provider request transforms and normalized after-provider response observation;
- user shell commands, active-theme changes, and the normalized durable event stream.

Guard and transform events return bounded structural values rather than mutating shared objects. Listeners for the same event run in deterministic extension order. Cancellation signals are propagated through command, tool, provider, and compaction work.

Every typed run boundary carries the exported `RuntimeRunScope`: immutable `threadId`, `runId`, the host-resolved `branch`, and `step` where applicable. Rigyn freezes each top-level run event before invoking a listener, so concurrent RPC or embedded sessions never depend on a global active-session pointer. `before_agent_start` additionally exposes the content-free `promptComposition` record for the exact composed prompt—hashes, byte counts, source labels, tool names, and skill paths, never prompt bodies.

When an event has host-owned session identity, its listener context exposes a callback-bound `session` surface. It preserves the exact `threadId`, resolved `branch`, and run/step attribution when present, and provides `get`, `getModel`, `getUsage`, `getSystemPrompt`, `isIdle`, `hasPendingMessages`, `abort`, and `compact`. Use this surface for event-local work instead of capturing a mutable active-session pointer. Prompt reads remain redacted, all actions retain the listener's cancellation and generation ownership, and no raw session store or credentials are exposed. Input events carry host-owned thread/branch identity as well, and transforms cannot replace it.

Streaming observers receive provider-neutral accumulated state rather than a provider SDK object. `message_start.message` begins empty; every text, reasoning, and partial tool-call update carries the current snapshot; and `tool_call_end` contains the finalized canonical call after the assistant message is durable. `turn_end` includes the final assistant message and model-visible tool results, so tool turns close only after those results are durable. `agent_end` and `agent_settled` include a bounded chronological suffix of run messages and an explicit truncation flag.

For the provider-finalized assistant message, `message_end` also receives `event.finalized`. An extension may replace its normalized token/cache/cost accounting and safe terminal finish reason alongside the message:

```js
api.on("message_end", (event) => {
  if (event.finalized === undefined) return;
  return {
    finalized: {
      ...event.finalized,
      usage: event.finalized.usage === undefined
        ? undefined
        : { ...event.finalized.usage, cost: "0.125" },
    },
  };
});
```

`usage` is a complete replacement, not a partial merge. Counters must be non-negative safe integers, `totalTokens` must equal input, output, cache-read, and cache-write components when those components are present, and `cost` is a non-negative decimal string. Provider-raw usage cannot be read or supplied. Finish-reason changes cannot alter tool execution or introduce internal context, cancellation, error, or incomplete states. Invalid patches are diagnosed and ignored. Effective transforms are attributed by a durable `assistant_response_transformed` event, followed by a final usage correction when accounting changed. Consequently `turn_end`, `agent_end`, run results, context pressure, and historical session totals all use the same finalized values; `after_provider_response` remains the observer for the original provider result.

`tool_call` includes the owning `threadId`, `runId`, and exact resolved `branch` alongside the prepared invocation. Branch-aware guards must use that host identity for session-state reads; do not ask the model to supply or guess session identifiers. The identity fields are immutable. A listener should return `{ input }` to replace only the cloned JSON input; legacy mutation of the listener-owned clone is also detected. Each effective transform is attributed to its extension, the final value is validated by the selected tool's complete schema, and a durable `tool_input_transformed` audit event is committed before `tool_requested`. If final validation or audit delivery fails, the transformed candidate is discarded and the validated pre-transform request is paired with the error result. A throwing listener contributes no partial mutation and fails closed.

See [Runtime extension events](extension-events.md) for the deterministic activation, reload, session, run, turn, message, and tool order plus the complete payload, result, failure, and cancellation contract for every event name.

`before_provider_request` runs after context projection and immediately before a provider adapter is called. Its event exposes immutable run identity (`threadId`, `runId`, exact `branch`, `step`, `provider`, and `model`) plus a cloned canonical request containing only `messages`, `tools`, `maxOutputTokens`, `reasoningEffort`, and caller metadata. A listener may return a patch for those request fields; `null` clears an optional scalar or metadata object. Tool patches may retain, reorder, remove, or rewrite definitions for currently executable tool names, but cannot introduce a name the active `ToolCoordinator` cannot execute. Invalid patches are diagnosed and ignored without exposing their partial values. Any effective patch invalidates provider continuation state for that request.

`after_provider_response` is observer-only. It runs once for every observed HTTP attempt and receives provider/model/step identity, one-based `attempt`, `willRetry`, optional bounded response/request IDs, normalized `finishReason`, optional raw terminal reason, normalized usage, and optional redacted transport diagnostics. A failed HTTP attempt uses `finishReason: "error"` and includes bounded error metadata without a raw provider body; a later successful attempt remains a separate event. Diagnostics contain the HTTP status plus only a fixed, bounded allowlist of request-ID, content-type, retry, and rate-limit response headers. Authorization, cookies, unknown headers, raw bodies, credential records, and provider continuation state are never exposed. The core revalidates diagnostics from custom providers and the credential redactor runs before extension delivery. Diagnostics are omitted from `turn_end`, `agent_end`, `agent_settled`, generic durable `event`, child-run event, and portable session-export projections. Observer failures are diagnosed without rewriting the response, retry decision, or durable work. Ordinary extensions that need a genuinely different protocol should register a provider; a reviewed package that only needs bounded transport interception may request the separate `providerWire` permission. Caller-supplied request metadata and canonical message text are extension-visible and therefore should not be used to carry credentials.

`before_user_shell` intercepts interactive `!` and `!!` shortcuts before a process starts. A listener can return `continue`, transform the command or workspace-confined working directory, or return `handled` with a bounded synthetic result that prevents the process. The host owns the visible/hidden choice, so an extension cannot make `!!` durable or hide `!`. Completed real and synthetic shortcuts still enter the existing observer-only `user_shell` event.

Extensions can also exchange bounded JSON without a global singleton:

```js
api.events.on("review.updated", async (payload, context) => {
  context.ui.notify(`Review ${payload.id} changed`);
});

await api.events.emit("review.updated", { id: "review-7" }, signal);
```

Shared listeners are owned by their extension generation, run in deterministic load order, receive an abortable listener context, and disappear atomically on reload.

## Agent and session controls

Runtime extensions have typed, generation-bound host actions. Every session action uses an explicit `threadId` and optional `branch`; there is no hidden global-session authority.

```js
await api.sendUserMessage({
  threadId,
  branch,
  text: "Check the failing test first",
  delivery: "steer" // or "follow_up"
});

const copy = await api.forkSession({ threadId, branch, name: "experiment" });
await api.switchSession({ threadId: copy.threadId });

await api.setModel({
  threadId: copy.threadId,
  provider: "anthropic",
  model: "claude-sonnet-4-5"
});
await api.setThinkingLevel({ threadId: copy.threadId, reasoningEffort: "high" });

await api.setSessionName({ threadId: copy.threadId, name: "auth experiment" });
await api.setEntryLabel({
  threadId: copy.threadId,
  targetEventId,
  label: "before refactor"
});

const tools = await api.getAllTools({ threadId: copy.threadId });
const runtimeCommands = api.getCommands();
const discoverable = await api.getDiscoveryView();
const sessions = await api.listSessions({ search: "authentication", limit: 50 });
const snapshot = await api.getSession({ threadId: copy.threadId });
const historicalUsage = await api.getSessionUsage({ threadId: copy.threadId, branch: snapshot.branch });
const promptSnapshot = await api.getSystemPromptSnapshot({ threadId: copy.threadId, branch: snapshot.branch });
const transcript = await api.getTranscript({ threadId: copy.threadId, branch: snapshot.branch, limit: 100 });
await api.waitForIdle({ threadId: copy.threadId });

const delegated = await api.runChild({
  threadId,
  branch,
  prompt: "Inspect the failing authentication tests and report the likely cause.",
  context: "fork",
  tools: ["read", "grep", "find", "ls"],
  appendSystemPrompt: "Report evidence separately from inference.",
  maxSteps: 6,
  timeoutMs: 90_000,
  session: "ephemeral",
  execution: { backend: "inherit", requireAllTools: true }
});

const shutdown = await api.requestShutdown({ reason: "maintenance complete" });
if (!shutdown.accepted) {
  // This host does not allow extensions to stop it.
}
```

The control surface includes:

- `sendUserMessage` for durable steering or follow-up delivery and `sendMessage` for namespaced custom transcript/model-context entries;
- `abort`, `compact`, `reload`, and the acknowledged `requestShutdown` host-policy request;
- `newSession`, `forkSession`, `switchSession`, `getSession`, `waitForIdle`, `getSessionTree`, and `navigateSessionTree`;
- `runChild`, which executes one bounded child session through the active in-process `HarnessService`; it never launches another `rigyn` executable;
- `setSessionName` and `setEntryLabel`; omit `name` or `label` to clear it. Every mutation names its target thread and optional branch;
- `getAllTools`, which returns bounded callback-free metadata for every executable model tool, including active state, input schema, execution mode, prompt metadata, and built-in/host/extension provenance;
- `getCommands`, which returns bounded callback-free descriptions for runtime extension commands, including duplicate invocation suffixes and owner paths;
- `getDiscoveryView`, which flattens built-in/runtime/template commands, prompt templates, and skills into one callback-free bounded metadata view;
- `listSessions`, which cursor-pages bounded name/ID/branch/timestamp metadata only for the current workspace, so an extension can select a `threadId` before replay;
- `getTranscript`, which cursor-pages one explicitly selected reachable branch as bounded transcript-visible data without raw durable events;
- `getSessionUsage`, which reconstructs persisted token, cache, duration, server-tool, and cost aggregates after restart, plus cache-effectiveness counters;
- `getSystemPromptSnapshot`, which returns the latest durably recorded host prompt after secret-pattern redaction, its safe hash/size, model selection, and content-free composition options;
- `session.readState`, `session.appendState`, and `session.compareAndAppendState` for namespaced append-only state, including conflict-safe read-modify-write updates;
- `getModel`, `setModel`, and `setThinkingLevel` for the selected model used by subsequent turns;
- `exec`, which runs an argv array without a shell, confines `cwd` to the workspace, propagates cancellation, and bounds time and captured output.

The canonical host's session snapshot includes active operation and phase, pending and recoverable message counts, current selection, and context pressure when authoritative provider usage and model metadata are available. It also exposes content-free prompt-composition metadata for the latest run: source identities, byte counts, hashes, tool names, and skill manifest paths. `getSystemPromptSnapshot` is the explicit prompt-body boundary: it names an exact thread/branch, reads only the latest durable host instruction message, applies the credential redactor again, and never returns provider state, request headers, or credential records. Context pressure reports its `provider_usage` source instead of presenting an unlabelled estimate. `waitForIdle` includes run setup and is generation/caller cancellable. Calling it from a lifecycle listener is rejected because that listener may be part of the active run it would wait on; commands and other external control paths may use it normally.

`runChild` requires a non-empty prompt, `context: "fresh" | "fork"`, and an explicit tool allowlist. Pass `tools: []` for summarization, planning, review, extraction, or other model-only work; omitted tools are rejected rather than silently granting authority. `systemPrompt` may replace the ordinary child prompt with at most 256 KiB, while `appendSystemPrompt` adds at most 64 KiB of task-specific instructions. Both must be non-empty valid text without NUL. The host always appends its no-recursive-delegation invariant after either option, so an extension cannot replace that safety boundary. The child inherits the parent's exact provider, model, reasoning selection, and configured execution backend unless the extension supplies an exact override. Set `execution.backend` to `"local"` to bypass the host backend deliberately. With `"inherit"`, `backendId` pins the exact configured backend and `requireAllTools` rejects before provider execution unless that backend claims every allowed tool. There is no silent fallback when a requested backend is unavailable. `fresh` starts without conversational history but retains parent-session lineage; `fork` copies the stable parent path and excludes the assistant tool call currently delegating work. Omitted `maxSteps`, `timeoutMs`, and `outputLimitBytes` values come from the host's [`childRuns` configuration](configuration.md#child-runs); current defaults remain 32 turns, ten minutes, and 64 KiB. The host also configures concurrent, step, timeout, and returned-text maxima, bounded by compiled ceilings of 16 children, 256 steps, one hour, and 8 MiB. Lower per-call limits remain available for narrowly bounded tasks. Active children reject steering and follow-up messages so one request cannot multiply its step budget. Recursive child delegation remains rejected after a persisted child is resumed or Rigyn restarts. Ephemeral sessions are deleted after completion, cancellation, or failure; `session: "persisted"` retains the child for inspection and ordinary later continuation. Results are normalized as `success`, `cancelled`, or `error` with a bounded summary, next actions, final text, truncation flag, exact model selection, session identifiers, aggregate normalized usage, execution routing, and bounded content-free artifact metadata.

`onStart` runs synchronously after the child session exists and before provider work. It exposes the child thread, branch, model, and persistence choice so a foreground tool can render stable identity immediately or cancel through the normal session controls. `onEvent` receives ordered safe lifecycle events while the run is active. Provider-private reasoning traces, opaque provider state, and response diagnostics are excluded. For a native agent-style tool, aggregate those events into occasional `context.reportProgress({ type: "result", ... })` calls, keep `execute` pending until `runChild` settles, then return one terminal result. This keeps the child inside the original tool row, lets the parent agent continue normally, and avoids a second harness process.

Inside a runtime tool, the essential foreground pattern is:

```js
async execute(input, context) {
  let childThreadId;
  let visibleText = "";
  let lastUpdateAt = 0;
  const result = await api.runChild({
    threadId: context.threadId,
    branch: context.branch,
    prompt: input.prompt,
    context: "fork",
    tools: ["read", "grep", "find", "ls"],
    signal: context.signal,
    onStart(child) {
      childThreadId = child.threadId;
      context.reportProgress?.({
        type: "result",
        content: "Child started",
        isError: false,
        metadata: { childThreadId, state: "running" }
      });
    },
    onEvent(update) {
      if (update.event.type === "text_delta") visibleText += update.event.text;
      const now = Date.now();
      if (now - lastUpdateAt < 100 || visibleText === "") return;
      lastUpdateAt = now;
      context.reportProgress?.({
        type: "result",
        content: visibleText,
        isError: false,
        metadata: { childThreadId, state: "running" }
      });
    }
  });
  return {
    content: result.finalText,
    isError: result.status === "error",
    summary: result.summary,
    nextActions: result.nextActions,
    metadata: { childThreadId: result.threadId, status: result.status }
  };
}
```

For a parallel delegation tool, start several `runChild` promises with separate `AbortController` instances, correlate their progress by the `onStart` thread ID, and await `Promise.allSettled` before returning the parent tool result. One partial result can summarize every child row. This preserves native cancellation and lets the parent model continue only after the delegated batch has a terminal observation.

Return before a child settles only when the product explicitly promises background jobs. In that case the extension owns the job table, controller, bounded retained output, durable completion entry, and generation cleanup. Register the controller cleanup before starting the run, capture identity in `onStart`, and publish completion through the session namespace or an explicit follow-up. Never rely on an unobserved promise, process-global active-session pointer, toast-only completion, or an ephemeral child transcript that is deleted before the user can inspect it.

`requestShutdown` is a request, not permission to terminate the process directly. Every call receives a request ID and an acknowledgement. Interactive and owned embedding hosts may accept it and begin graceful cancellation and close; hosts without an explicit shutdown policy return `accepted: false` immediately instead of hanging or exiting unexpectedly.

Use `runChild` for an agent-style extension that needs another model loop. A package should not shell out to `rigyn`, call its CLI recursively, or start an RPC copy of the same harness merely to delegate work. External processes remain appropriate only for a real external boundary such as an MCP stdio server or an explicitly isolated executor.

Selection changes are validated against the provider registry and durably recorded. They affect the next model turn/run; an in-flight provider request is never retargeted. `switchSession` is a TUI focus operation; RPC and embedding owners select sessions through their own public session/service calls. Compaction uses the session's recorded model unless an exact provider/model is supplied.

`getCommands` remains the synchronous runtime-command-only view for existing extensions. Use `getDiscoveryView(signal?)` when one picker or authoring workflow needs built-in commands, runtime commands, declarative commands, prompts, and skills together. It returns metadata, never executable callbacks or resource bodies. `session_info_changed` fires after an extension, TUI, or RPC rename is durably committed; its `name` is absent when cleared. Entry labels are durable branch events and are also observable through the generic `event` listener.

`getResourceCatalog(signal?)` returns the same deterministic, callback-free, bounded metadata snapshot exposed by the embedding runtime and RPC `resources.list`. It includes resource ownership, active/trust state, package provenance, provider/model summaries, and diagnostics without source contents, credential values, provider continuation state, executable handlers, or hidden prompts. See [`resource-catalog.md`](resource-catalog.md).

`listSessions({ search?, cursor?, limit?, signal? })` returns at most 100 metadata rows per page, ordered by most recently updated. Search matches session names and IDs, not message bodies or raw event payloads. The service always applies its canonical current-workspace scope; cursors cannot widen it. Select a returned `threadId` and `defaultBranch`, then call `getTranscript` for bounded visible content. Cross-workspace IDs are rejected even if an extension already knows them.

`getTranscript({ threadId, branch?, afterSequence?, limit?, signal? })` returns at most 256 visible entries and one MiB per page. Continue with the returned exclusive `nextSequence` only while `hasMore` is true. Each entry carries its durable event ID, sequence, timestamp, and safe display fields. The projection includes user/assistant text, image media type and source class without image data or URLs, visible reasoning summaries, tool lifecycle status and bounded result summaries, transcript-enabled extension messages, and visible compaction/branch/status summaries. It never returns system prompts, extension state or non-transcript payloads, tool arguments or raw results, usage/error raw data, provider continuation or opaque blocks, provider-trace reasoning, credentials, headers, or callbacks. The host verifies workspace ownership and branch reachability before replay. Treat it as the initial/reconnect snapshot for a dashboard and use bounded live lifecycle events only for subsequent updates.

A browser client can use these same controls through a new loopback-only extension or the RPC bridge. The bundled authoring skill deliberately creates dashboard packages from scratch in the active workspace; Rigyn does not ship a dashboard implementation for the agent to edit.

## Durable extension state

The session namespace prevents extensions from writing arbitrary core events:

```js
await api.session.appendState({
  threadId,
  branch,
  schemaVersion: 1,
  key: "last-scan",
  value: { files: 42 }
});

await api.session.appendMessage({
  threadId,
  branch,
  schemaVersion: 1,
  kind: "scan_complete",
  payload: { files: 42 },
  modelContext: false,
  transcript: { text: "Scanned 42 files" }
});
```

State is append-only in the event log; `readState` returns the latest reachable value for a key. A blind `appendState` is appropriate when the new value does not depend on the previous value. For a counter, memory index, plan, or any other read-modify-write path, use namespace-level optimistic compare-and-append:

```js
let current = await api.session.readState({ threadId, branch, schemaVersion: 1, key: "counter" });
let committed = false;
for (let attempt = 0; attempt < 8; attempt += 1) {
  const count = typeof current?.value?.count === "number" ? current.value.count : 0;
  const result = await api.session.compareAndAppendState({
    threadId,
    branch,
    schemaVersion: 1,
    key: "counter",
    value: { count: count + 1 },
    expectedEventId: current?.eventId ?? null,
    signal,
  });
  if (result.status === "committed") {
    committed = true;
    break;
  }
  current = result.current;
}
if (!committed) throw new Error("Counter state changed repeatedly");
```

`expectedEventId: null` means the key must not yet exist. The comparison and append share one SQLite write transaction across harness processes. A stale writer receives `{ status: "conflict", threadId, branch, expectedEventId, current? }`; it never overwrites the newer value. The returned branch is the exact resolved branch, including when the caller omitted `branch`. Comparison is scoped to the extension, schema version, and key, so unrelated branch events do not cause false conflicts. Check the caller or generation signal before every attempt and use a bounded retry limit.

Extension messages independently control whether they enter model context and whether they render in the transcript. `registerRenderers(schemaVersion, renderer)` gives stored entries a stable structural representation after restart.

`session.readMessages({ threadId, branch?, schemaVersion, kind?, limit?, beforeEventId? })` preserves the existing latest-first-page behavior: results remain chronologically ordered and default to the latest 100 matching entries. For older pages, pass the first returned entry's `eventId` as the exclusive `beforeEventId` cursor. Cursors are accepted only when reachable in the same explicit branch, extension namespace, schema version, and optional kind; a foreign or stale cursor fails rather than widening the query.

`getActiveTools` and `setActiveTools` let a command opt its tool into the current session without modifying global defaults.

## Skills

A skill is a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: release-check
description: Verify a package before publication.
---

1. Run the package tests.
2. Inspect the packed artifact.
3. Report evidence and remaining blockers.
```

Only name and description enter the base prompt. Full instructions load when the skill is invoked, keeping routine context small. Skills can also declare model and invocation controls supported by the Agent Skills format.

Automatic compatibility roots include `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`, plus their trusted workspace equivalents. Within each compatible group that is the ascending precedence order, so `.codex` wins the same-name collision. Explicit configured and invocation roots come later. Collision diagnostics include both manifest paths and both root paths.

Native Rigyn skill roots discover both directory skills containing `SKILL.md` and direct root-level `*.md` skills. Shared compatibility roots remain directory-`SKILL.md` only. Embedders can express the distinction with the optional public `SkillRoot.rootMarkdown` field; omit it for native behavior or set it to `false` for compatibility behavior.

Recursive skill roots honor hierarchical `.gitignore`, `.ignore`, and `.fdignore` rules, including negation. Hidden directories and `node_modules` remain excluded. An explicitly configured skill file is loaded directly even when an ancestor directory would be ignored by recursive discovery.

## Prompts and declarative commands

Manifest prompt and command files are Markdown templates. `{{input}}` inserts the original prompt input, while `{{args}}` inserts the original command arguments; each form is specific to its resource type. Both may use shell-style positional placeholders: `$1`, `${1:-default}`, `$@`, `$ARGUMENTS`, `${@:START}`, `${@:START:LENGTH}`, `${@:-default}`, and `${ARGUMENTS:-default}`. `${@:0}` starts at the first argument, while `${@:0:LENGTH}` returns at most that many arguments. `$0` is accepted for compatibility and expands to an empty string; `${0:-default}` therefore selects its default. Arguments honor quotes and backslash escapes, and replacement is single-pass, so placeholder-looking text produced by an argument is not expanded again.

Invoke a prompt by its slash ID or with `/prompt ID INPUT`. Declarative commands render their template, and `/skill:NAME INPUT` loads an exact skill. These forms and runtime extension commands execute inside both interactive chat and one-shot `rigyn run`; a one-shot runtime command receives presentation-only UI methods and rejects interactive dialogs explicitly.

## Themes

Themes are JSON objects with `schemaVersion: 1`, a unique `name`, an optional built-in `base`, optional bounded `vars`, and semantic `styles`. Style colors may be palette indexes, `#RRGGBB`, or `$variable` references; styles may also set bold or italic. The bundled editor schema is [`resources/schemas/theme-v1.json`](../resources/schemas/theme-v1.json), whose canonical URI is `urn:rigyn:schema:theme:v1`.

Roles include general presentation (`title`, `muted`, `accent`, `info`, `link`, `code`, `border`), editor/activity presentation (`editor`, `editorActive`, `working`), actors and outcomes, selections, and tool lifecycle states. `themeContrastDiagnostics` reports low-contrast role declarations without rejecting a theme that remains otherwise valid.

Rigyn also accepts complete token-shaped theme documents for package portability. Their `colors` object has 51 required semantic tokens plus optional `thinkingMax`; `THEME_TOKENS` is the stable public key list. Bare color names resolve recursively through `vars`, `thinkingMax` inherits `thinkingXhigh`, and the parsed `ThemeDefinition.tokens` record retains every resolved token instead of reducing the document to the smaller structural-role set. Unknown or missing token keys, invalid aliases, cycles, bases, and export fields fail validation.

Token-shaped documents may set `base` to `dark` or `light`; when omitted, a theme named `light` uses the light base and every other name uses the dark base. Optional `export.pageBg`, `export.cardBg`, and `export.infoBg` values use the same aliases and color validation. Missing or empty export values inherit the resolved `userMessageBg` token and are available on `ThemeDefinition.export` for presentation exporters.

The TUI renders semantic roles rather than hard-coded colors, so built-in and extension renderers respond to theme changes together. Replacing the active theme definition during `/reload` safely invalidates the live render. A selected loose theme is also watched and reapplied after a valid atomic file save; malformed intermediate content leaves the last valid theme visible. Configure `LIGHT/DARK` to pair two installed themes and follow terminal background reports automatically.

## Packages

Package commands accept a local directory, `npm:SPEC`, `git:SOURCE`, or credential-free HTTPS Git URL:

```sh
rigyn install ./workspace-tools
rigyn install npm:@example/workspace-tools
rigyn update workspace-tools
rigyn update --all
rigyn list
rigyn config
rigyn remove workspace-tools
```

Use `-l` for project scope. Installs are staged, bounded, validated, activation-tested in a disposable host, and atomically committed with provenance and a lock record. The candidate host uses temporary workspace and data roots and cannot reach a live session through the extension API. It is disposed before the staged directory is committed; activation failure or timeout leaves the previous install and project lock unchanged. Updates use the recorded source. Package resource filters can enable or disable individual contributions without modifying the installed package.

The [local package gallery](packages.md) includes independently runnable tool, provider, durable-state, lifecycle, UI, and complete reference packages. Public discovery metadata is documented in [Package discovery index](package-gallery.md).

## Testing an extension

Start with the non-installing author checks:

```sh
rigyn extensions author report ./workspace-tools
rigyn extensions author pack ./workspace-tools ./artifacts
```

The report validates a private staged copy, inspects the packed file set, activates and disposes it through the in-process loader, and repeats activation candidate-first. It does not replace the real entry-point and install/remove checks below.

Keep an offline provider or deterministic tool fixture in the package when practical. The reference package can be installed and exercised through the real agent loop without credentials:

From the `examples/reference-package` directory:

```sh
rigyn install .
rigyn \
  --provider reference-offline \
  --model reference-offline-v1 \
  --tools reference_echo \
  --no-session \
  -p "package check"
```

Test activation failure, reload, cancellation, malformed tool input, duplicate registrations, session restart, and package install/remove in addition to the happy path.
