# Session control extension

This package shows the host-owned session controls available to command
handlers:

- `/example-session-new`
- `/example-session-fork ENTRY_ID`
- `/example-session-switch PATH`
- `/example-session-status` reads `hasPendingMessages()` and
  `getSystemPromptOptions()`, waits with `waitForIdle()`, and displays bounded
  state.
- `/example-session-abort` requests cancellation of active agent work.
- `/example-session-refresh` refreshes host-owned extensions and resources. The
  command handler stops after requesting refresh.
- `/example-session-shutdown` requests graceful host shutdown.

Transitions run only while the current session is idle. Normal host validation
and lifecycle events still apply. Abort and shutdown are requests; the host
owns final cancellation and cleanup.

```text
rigyn install ./packages/rigyn/examples/session-control
```
