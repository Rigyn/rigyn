# Runtime cookbook

These recipes use shipped interfaces. The active rigyn process keeps authority
over sessions, tools, providers, and extensions.

## Run one isolated, unsaved review

```sh
rigyn --no-session --tools read,grep,find,ls --print \
  "Review this repository. Report concrete evidence and do not modify files."
```

`--tools` is an allowlist. `--no-session` prevents durable conversation
storage. It does not create an operating-system sandbox.

## Continue or branch work

```sh
rigyn --continue "Run the remaining verification"
rigyn --fork SESSION_REF "Try the smaller implementation"
```

Continuation reuses the durable thread for the workspace. Forking copies the
selected history into a linked independent session and leaves the original
journal untouched. `/tree` moves the selected head within one journal.

## Export a session

Inside the TUI, `/export archive.jsonl` writes the versioned machine-readable
format. `/export archive.html` creates a self-contained interactive viewer.
Use JSONL for round trips. Use HTML for reading and inspection. See
[the export contract](session-export.md).

Convert an existing JSONL session without loading a provider runtime:

```sh
rigyn --export path/to/session.jsonl share.html
```

An ordinary HTML export prevents session content from becoming active viewer
markup, but it does not redact private data. Use `/export --redact FILE` to
create a local redacted copy for review. Use `/share` to upload a temporary
redacted HTML export as a secret GitHub Gist and return its URL. A secret Gist
is unlisted, not access-controlled. Inspect the complete result before you
share it.

## Inspect resource loading without executing an agent run

```sh
rigyn extensions doctor
rigyn diagnostics ./support.json
```

The first command reports the active extension catalog. The diagnostic bundle
checks static resources and records path ownership and local timing. It does
not read credential or session contents.

## Add a shared skill

Create `SKILL.md` under one of:

```text
~/.agents/skills/NAME/
~/.claude/skills/NAME/
~/.codex/skills/NAME/
```

Workspace equivalents load only after project trust. The active runtime keeps
the first eligible root in its configured order. A collision diagnostic
reports both paths. Only the skill name and description enter the base prompt.
Full instructions load on invocation.

## Build and verify an extension package

Use `/skill:rigyn-dev <request>` in a disposable workspace. The single bundled
development skill routes extension work to the installed contract, directs the
agent to a fresh directory, and describes the managed install, `/refresh`, and
removal path. For a manual baseline from a rigyn source checkout, copy the
bundled starter to an explicit workspace outside that checkout:

```sh
cp -R packages/rigyn/examples/starter /absolute/path/to/workspace/my-extension
cd /absolute/path/to/workspace
rigyn install ./my-extension
rigyn extensions doctor
rigyn list --json
rigyn remove ./my-extension
```

From an installed runtime, use the version-matched starter linked by the bundled `rigyn-dev` skill as a read-only reference and create the package in the active workspace; do not assume a `packages/rigyn` directory exists there.

Runtime tools, commands, providers, UI contributions, prompts, custom themes,
and skills run inside the active harness. Agent-style subprocess extensions use
bounded `rigyn.exec` for one-shot work or `rigyn.processes` for asynchronous
workers and framed pipes. The extension owns its arguments, protocol,
task-level concurrency, recursion policy, validation, and result presentation.

## Persist workspace memory and task state

Install [`state-and-policy`](../examples/state-and-policy/README.md) for an executable baseline:

```sh
rigyn install ./packages/rigyn/examples/state-and-policy
```

It uses the current callback's `context.paths.workspaceData`, a fixed schema,
bounded records, user-only file permissions, and sequential tools.
`paths.userData` is the equivalent root for state that should follow the
extension across workspaces.

Do not derive either root yourself. Do not store provider credentials there.
Remembered text becomes visible to the model when recalled.

Use `rigyn.config` when the extension needs one bounded, atomic JSON settings
document per user or workspace scope. Its compare-and-swap revision prevents
silent writer races. Use the data paths for larger or multi-file domain state.

The same package demonstrates a small workflow store. One model-callable tool
can add, list, and complete task records. `/example-state` reports the counts.
A larger planner should use explicit state transitions, persist only validated
JSON, and keep durable state separate from transient progress.

## Bridge an MCP server

MCP is an extension-level integration. The harness does not grant it ambient
authority. A trusted bridge should:

1. start one fixed executable with an argv array, a minimal environment, and a canonical workspace;
2. negotiate one bounded protocol version and validate every framed JSON-RPC message;
3. allowlist server tools before registering corresponding rigyn tools;
4. translate cancellation and retain correlation IDs without exposing host session or credential state;
5. deny server-initiated sampling, roots, filesystem access, and arbitrary subprocess requests unless the package explicitly implements and documents them;
6. cancel the managed process when the bridge retires early; refresh and close cancel it automatically.

Use `rigyn.exec` for a one-request worker. A long-lived standard-input/output
server should use `rigyn.processes` with pipe mode. The host bounds buffers,
applies backpressure, and owns process-tree cleanup; the extension still frames
and validates every message. Protocol discovery is not package trust.

The portable package loader currently supports skills only. It ignores a root
`mcp.json`; that file does not start a process or register tools. A package that
needs an MCP bridge must provide the reviewed rigyn extension described here.

## Add web fetch or search

Prefer one fixed HTTPS origin controlled by the integration. Do not accept a
model-supplied URL. Put the search term in `URLSearchParams`. Forward the tool
signal, limit redirects and response bytes, accept only documented content
types, and return a small citation-focused result.

Keep API keys in an environment credential or registered provider auth flow.
Use them only in request headers. Never return headers or secrets in tool
details.

An arbitrary-URL fetcher is a network boundary. It must check the resolved
address after every redirect. It must reject loopback, private, link-local,
multicast, metadata, and non-HTTP targets. It must also defend against DNS
rebinding. If that policy is not implemented and tested, expose a fixed-origin
tool instead.

## Add browser automation

Run browser control in a reviewed worker with a separate profile. Use a closed
action schema, such as navigate, click a selected locator, fill, capture text,
and screenshot.

Do not expose arbitrary JavaScript evaluation, browser profile selection,
extension loading, file downloads, or unrestricted local URLs. Limit page text
and images. Forward cancellation. Close browser contexts after every outcome.
Report only sanitized status through `onUpdate`.

The worker uses the operating-system permissions of its browser process. A
tool-call guard is not a browser sandbox. Keep authenticated profiles opt-in
and out of example packages.

## Add LSP diagnostics

An LSP extension should start one fixed `rigyn.processes` language-server worker
for each canonical workspace. It should implement bounded `Content-Length`
framing and normalize document URIs through the workspace boundary.

Register a read-only diagnostics tool. It should open or update only explicit
documents, wait for the matching publication and version, and return a bounded
list of ranges, severities, codes, and messages. Deny dynamic executable
changes and `workspace/executeCommand` unless they receive a separate review.
Cancel pending requests explicitly when retiring early; generation shutdown
closes the server automatically.

## Enforce permission and protected-path policy

[`state-and-policy`](../examples/state-and-policy/README.md) blocks selected
built-in file calls before execution when they target protected names or leave
the workspace. [`input-guard`](../examples/input-guard/README.md) shows input
transformation and shell-call blocking.

These hooks intercept policy; they do not create isolation. Another active
tool or trusted extension may keep broader authority. For a hard boundary,
limit the active tools and use an external execution backend.

## Execute tools remotely over SSH

Use the tested fixed adapter in
[`execution-backends/remote-ssh.mjs`](../examples/execution-backends/remote-ssh.mjs)
and follow [External execution backends](execution-backends.md). The adapter
fixes the SSH binary, destination, identity, known-hosts database, remote
worker, and workspace. It disables configuration loading, forwarding, and
interactive authentication. Each call carries one bounded protocol record.

The remote account should have no provider credentials or privilege
escalation.

## Register a custom provider

[`provider-catalog`](../examples/provider-catalog/README.md) is the managed
catalog and OAuth skeleton.
[`provider-override`](../examples/provider-override/README.md) shows
generation-owned replacement and restoration.

Use a unique provider ID, exact model metadata, a fixed secure endpoint,
credential-broker integration, bounded refresh results, and `onDispose` for
owned transport resources. The sample authorization callback does nothing by
design. Replace it only with a reviewed flow.

## Stream subprocess-worker status

[`subprocess-workers`](../examples/subprocess-workers/README.md) emits a
bounded stage-level `onUpdate` snapshot after each specialist finishes. Each
snapshot reports the mode, completed and total work, and bounded status for
each worker. The final result contains the authoritative report and aggregated
usage.

`rigyn.exec` is buffered, so the example does not claim token-by-token child
output. For live child events, use `rigyn.processes` pipe mode and decode its
framed stream incrementally. Combine updates, enforce byte and event limits,
forward the callback signal, and still return one complete final tool result.

RPC shell commands expose a separate correlated `bash_execution_update`
stream, documented in [RPC](rpc.md).

## Measure deterministic harness and authoring paths

```sh
npm run benchmark:offline --workspace rigyn
npm run benchmark:extensions --workspace rigyn
```

Both commands are credential-free. The first measures core harness plumbing.
The second validates managed extension candidates through install, discovery,
activation, refresh, and removal. It reports verifier pass@1 and pass@3.
Neither benchmark measures model intelligence.
