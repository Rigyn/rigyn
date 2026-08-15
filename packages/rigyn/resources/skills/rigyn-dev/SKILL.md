---
name: rigyn-dev
description: Configure, extend, debug, test, or release rigyn and develop other software projects with their own repository-defined workflows. Use when working with config.json, AGENTS.md, extensions, tools, commands, providers, skills, prompts, themes, terminal UI, sessions, compaction, transports, the rigyn source repository, another product repository, diagnostics, errors, logs, stats, crash reports, builds, tests, development servers, packages, or release verification.
---

# Develop rigyn

Work against the installed or checked-out rigyn version. Treat its documentation, declarations, tests, and focused examples as authoritative; do not invent APIs from memory.

## Route the task

Read only the relevant reference, but read that file completely before changing anything:

| Task | Reference |
| --- | --- |
| Edit settings, keybindings, resource paths, or instructions | [Configuration](references/configuration.md) |
| Build or repair an extension, package, tool, command, skill, prompt, theme, worker, or local dashboard | [Extensions](references/extensions.md) |
| Change rigyn core, sessions, compaction, transports, providers, or terminal UI | [Core, TUI, and providers](references/core-tui-providers.md) |
| Develop, build, test, or run another software project | [Project development](references/project-development.md) |
| Diagnose, test, benchmark, install, package, or release | [Testing and release](references/testing-release.md) |

Read more than one reference only when the request crosses those boundaries.

## Work method

1. Identify whether the target is user configuration, a separate extension package, or the rigyn source repository.
2. Inspect the nearest current docs, declarations, available source and tests, and one focused example before editing.
3. State the smallest observable acceptance criteria, target hosts, and any authority the result needs.
4. Change only the requested surface. Add a regression test for changed behavior.
5. Run focused verification first, then the documented boundary or release checks.
6. Report the changed root, user-visible behavior, checks, and any remaining limitation.

Prefer configuration or a declarative resource when code is unnecessary. Use an extension for optional, project-specific, or integration behavior that the public API can express. Change rigyn source only for a product-wide invariant, a shared correctness or security fix, or a required host capability that the public extension API does not expose. When an extension needs a missing host capability, add the smallest general public capability in core, then keep the product behavior in the extension.

For an extension request, create the product in a fresh directory in the active workspace. Do not modify the installed rigyn package, bundled examples, or a source checkout unless the user explicitly asks to maintain that exact target. Do not create or bundle another agent runtime or grant child-agent authority as part of ordinary extension work.

Keep user personalization separate. rigyn creates the global `AGENTS.md` empty and preserves it; edit instruction files only when the user asks.

## Apply changes

Use `/refresh` for normal `config.json`, keybinding, extension, skill, prompt, theme, and instruction-file changes. It preserves the active session and replaces the runtime generation transactionally.

`/refresh` does not load changed rigyn source or rebuilt JavaScript modules. After a verified source change, build the exact runtime, wait for work to become idle, then tell the user to exit and relaunch the same durable session. Never restart the process automatically. Relaunch only for changed source or other process-bound state such as the Node runtime, native helper, launcher, inherited process environment, or a failure that prevents `/refresh` from running. Do not recommend a relaunch for ordinary resource or settings edits.
