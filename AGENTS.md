# rigyn development guide

This file gives automated contributors the rules for changing this repository.

## Work method

1. Read the nearest code, tests, and documentation before you edit.
2. State any assumption that can change the result.
3. Make the smallest change that solves the requested problem.
4. Add or update a test for every behavior change.
5. Run focused checks while you work.
6. Run `npm run check` before you report completion.

Do not refactor unrelated code. Preserve user changes in a dirty worktree. Do
not remove dead code unless the task asks for it or your change made it dead.

## Repository map

- `packages/models`: provider-neutral model types and standalone provider
  transports.
- `packages/kernel`: the reusable agent loop, context handling, tools, and V4
  session journal.
- `packages/terminal`: terminal input, layout, rendering, and components.
- `packages/rigyn`: product policy, providers, credentials, extensions, tools,
  TUI, CLI modes, RPC, serve mode, and SDK composition.
- `scripts`: workspace, release, model-catalog, and policy checks.

Keep product-integrated provider adapters in `packages/rigyn/src/providers/`.
Keep standalone protocol modules in `packages/models/src/api/` and standalone
provider factories in `packages/models/src/providers/`. When behavior overlaps,
update both paths and add conformance coverage for the shared contract.

## Runtime boundaries

- All product modes must use the same `AgentSession` runtime.
- Every tool execution must pass through the tool coordinator. Do not add a
  direct execution bypass.
- Keep file boundary checks in `packages/rigyn/src/tools/paths.ts`.
- A requested sandbox must fail closed if isolation cannot be established.
- Tool failures are model-visible results. Runtime invariant failures stop the
  run.
- Session commits are append-only. Derived state must be rebuildable from the
  journal.
- Preserve opaque provider state byte-for-byte. Never expose hidden reasoning.
- Keep extension contracts transport-neutral. A UI or protocol adapter must
  not become part of the core execution engine.

## Security and data

- Keep credential access behind `packages/rigyn/src/auth/`.
- Never log, return, or store a secret outside the selected credential backend.
- Validate tool input before and after an extension transforms it.
- Apply resource claims before execution.
- Treat paths, URLs, terminal controls, provider output, and extension input as
  untrusted data.
- Use bounded reads, queues, streams, and retained output.

## Compatibility and public APIs

- Keep the documented package exports stable unless the task requires a
  breaking change.
- Update public type tests, the export inventory, and documentation when a
  public contract changes.
- Keep interactive, print, JSON, RPC, serve, and SDK behavior aligned at the
  shared runtime boundary.
- Live provider discovery is authoritative. The bundled catalog is an offline
  fallback and must contain only reviewed, supported entries.

## Tests and release checks

Run the narrowest relevant test first. Then run:

```sh
npm run check
```

For installer or release work, also stage and verify the release artifact with
the scripts in the root `package.json`. Test install, update, and uninstall in
an isolated temporary home directory. Do not publish from an unclean or
untested worktree.

Keep the project-wide MIT notice in `LICENSE`. Do not add copied source, copied
prose, external project names, generated comparison files, or per-file
copyright headers.
