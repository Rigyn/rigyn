# Shared in-process events

This package has two runtime entries. The sender implements `/event-pulse`; the receiver observes the bounded JSON payload and updates status. Both entries load into the active Rigyn process. No second harness or background service is launched.

```sh
rigyn extensions author report .
rigyn --package .
```

Run `/event-pulse index refreshed`. Shared events are ephemeral coordination, not durable storage. Use namespaced session state for restart-safe data, validate every payload, keep topics stable, and dispose listeners through the normal generation lifecycle.
