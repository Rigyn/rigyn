# Session tools example

`session_catalog` provides two bounded actions: `list` searches and pages session metadata from the current workspace, while `transcript` reads one explicitly selected branch using an exclusive `afterSequence` cursor. `/session-name` sets or clears the active session's display name.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools session_catalog -p "List sessions named parser, then inspect only the session I select."
rigyn remove session-tools-example
```

Never treat a model-known thread ID as permission to cross workspace boundaries. The host enforces workspace scope, but a product should still ask the user to select a session before reading its transcript and should preserve the opaque catalog and numeric transcript cursors exactly.
