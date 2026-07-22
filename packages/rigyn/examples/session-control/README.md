# Session control extension

This package demonstrates the host-owned session transition methods available to command handlers:

- `/example-session-new`
- `/example-session-fork ENTRY_ID`
- `/example-session-switch PATH`
- `/example-session-status` snapshots `hasPendingMessages()` and `getSystemPromptOptions()`, waits for active work with `waitForIdle()`, then displays bounded state.
- `/example-session-abort` requests cancellation of active agent work.
- `/example-session-reload` reloads host-owned extensions and resources and treats reload as terminal for that command handler.
- `/example-session-shutdown` requests graceful host shutdown.

Transitions run only while the current session is idle and remain subject to the host's normal validation and lifecycle events. Abort and shutdown are requests to the host; the host owns final cancellation and cleanup.

```text
rigyn install ./packages/rigyn/examples/session-control
```
