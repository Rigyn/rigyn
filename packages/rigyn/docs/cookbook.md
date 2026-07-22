# Runtime cookbook

These recipes use shipped interfaces and keep authority in the active harness process.

## Run one isolated, unsaved review

```sh
rigyn --no-session --tools read,grep,find,ls --print \
  "Review this repository. Report concrete evidence and do not modify files."
```

`--tools` is an allowlist. `--no-session` prevents durable conversation storage; it does not create an operating-system sandbox.

## Continue or branch work

```sh
rigyn --continue "Run the remaining verification"
rigyn --fork SESSION_REF "Try the smaller implementation"
```

Continuation reuses the workspace-scoped durable thread. Forking preserves the original event graph and creates a new branch head.

## Export a session

Inside the TUI, `/export archive.jsonl` writes the versioned machine-readable format. `/export archive.html` creates a self-contained interactive viewer. JSONL is the round-trip representation; HTML is for reading and inspection. See [the export contract](session-export.md).

Convert an existing JSONL session without loading a provider runtime:

```sh
rigyn --export path/to/session.jsonl share.html
```

An ordinary HTML export is protected against session content becoming active viewer markup, but it is not redacted. Use `/share FILE` or `/export --redact FILE` for a review-required redacted copy, and still inspect the complete result before publishing it.

## Inspect resource loading without executing an agent run

```sh
rigyn extensions doctor
rigyn diagnostics ./support.json
```

The first command reports the active extension catalog. The diagnostic bundle performs static resource checks and adds path ownership and local timing information without reading credentials or sessions.

## Add a shared skill

Create `SKILL.md` under one of:

```text
~/.agents/skills/NAME/
~/.claude/skills/NAME/
~/.codex/skills/NAME/
```

Workspace equivalents are discovered only after project trust. Later roots win name collisions in the order shown, and the diagnostic names both paths. Only skill name and description enter the base prompt; full instructions load on invocation.

## Build and verify an extension package

Use `/build-extension <request>` in a disposable workspace. The authoring resource directs the agent to a fresh directory and the actual managed install/reload/remove path. For a manual baseline:

```sh
cp -R packages/rigyn/examples/starter ./my-extension
rigyn install ./my-extension
rigyn extensions doctor
rigyn list --json
rigyn remove PACKAGE_ID
```

Runtime tools, commands, providers, UI contributions, prompts, custom themes, and skills run inside the active harness. Agent-style subprocess extensions use the bounded `rigyn.exec` boundary; the extension owns its argv, protocol, cancellation, concurrency, and result presentation.

## Measure deterministic harness and authoring paths

```sh
npm run benchmark:offline --workspace rigyn
npm run benchmark:extensions --workspace rigyn
```

Both are credential-free. The first measures core harness plumbing. The second validates managed extension candidates through install, discovery, activation, reload, and removal and reports verifier pass@1/pass@3. Neither is a claim about model intelligence.
