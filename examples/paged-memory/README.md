# Paged memory example

`session_memory` stores small notes as durable, extension-owned session messages. Recall reads at most 50 entries and pages toward older history with the first returned `eventId` as the next exclusive `beforeEventId` cursor. Notes are not injected into model context or the generic transcript; the extension owns their renderer.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools session_memory -p "Remember that the parser preserves unknown-field rejection, then recall the latest notes."
rigyn remove paged-memory-example
```

The cursor is opaque and namespace-bound. Do not derive ordering from its text, reuse a cursor from another extension, or replace paging with an unbounded history scan.
