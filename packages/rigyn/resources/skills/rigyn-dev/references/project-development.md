# Develop a software project

Use the project's own checked-in contract. Do not impose rigyn's repository commands, package manager, release process, or architecture on another product.

## Establish the workflow

1. Read the nearest `AGENTS.md` and repository documentation that applies to the working directory.
2. Inspect manifests, lockfiles, task definitions, and CI workflows before choosing commands. Treat checked-in scripts as evidence; never guess a package manager or invent a build pipeline.
3. Inspect the current version-control status and preserve unrelated user changes.
4. State the requested behavior and the smallest focused check that proves it before editing.
5. Re-read a file before changing it when another process or agent may have modified it. Let a conflicting edit fail visibly instead of overwriting newer content.

## Change and verify

- Reproduce a defect with a focused test when practical, make the smallest coherent change, and run that check first.
- Run only the repository's documented lint, typecheck, test, build, or benchmark commands. Escalate to broad gates when the repository contract or change risk requires them.
- Keep generated output, dependencies, caches, coverage data, and temporary files out of source changes unless the repository explicitly tracks them.
- Do not reset, discard, reformat, or commit unrelated work. Do not create or delete a worktree unless the user requests that source-control operation.
- Report exact commands, pass/fail/skip counts, and any platform, credential, or network boundary that was not exercised.

## Run a development server safely

For a one-shot smoke test, use one visible, bounded shell operation:

1. Use the exact documented server command and working directory.
2. Capture the process or process-group identity created by that operation.
3. Wait for the documented loopback health URL or port with a bounded deadline.
4. Run the requested smoke check.
5. Stop only the captured process in guaranteed cleanup, including failure and cancellation paths.

Never use a pattern-based kill, scan unrelated machine ports, silently leave a background process running, or claim a persistent server is managed after the tool call finishes. If the user needs a server to remain available, run it visibly in the foreground for them to control or build a reviewed host extension with explicit lifecycle ownership.

## Respect operational authority

Building and testing local project files does not authorize deployment, publication, infrastructure changes, release creation, remote messages, credential use, or destructive data operations. Perform those actions only when the user explicitly places them in scope, then follow the project's own release and rollback instructions.

Keep project-specific cloud, deployment, and secret procedures in that project's instructions, skill, or extension. Do not turn this general workflow into a universal deployment engine.
