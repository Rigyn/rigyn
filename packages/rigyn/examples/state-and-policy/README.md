# Workspace state and path policy

This example stores persistent memory and task state under the extension-owned
`context.paths.workspaceData` directory. It registers `example_memory`,
`example_tasks`, `/example-state`, `/example-policy`, and a narrow preflight
guard for built-in file tools.

```text
rigyn install ./packages/rigyn/examples/state-and-policy
```

The state file is bounded and schema-checked. It is private to this extension
and canonical workspace, and it uses user-only file permissions. Recalled
notes become visible to the model. Do not store credentials or data that
should not enter a session.

Sequential tool mode prevents overlapping writes inside one rigyn process.
Several rigyn processes still require an external lock or transactional store.

`/example-policy [on|off]` stores the guard setting in `rigyn.config` with the
revision returned by `read` as `replace.expectedRevision`. A concurrent writer
therefore causes a visible conflict instead of silently losing an update. The
policy is on when no workspace configuration exists.

The guard blocks built-in `read`, `write`, and `edit` calls that target `.env`,
`.git`, `.ssh`, `auth.json`, or a path outside the workspace. This is a policy
example, not a sandbox. Other tools and extension code keep their own
authority. A strict deployment should also limit active tools or route them
through a protected execution backend.
