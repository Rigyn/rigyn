# Prompt inspector example

`/prompt-info` reads the latest host-owned system-prompt snapshot for the active branch, then displays only byte count, digest, model identity, and redaction status. It deliberately does not copy prompt text into notifications, model context, files, network requests, or extension state.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn
```

After at least one model run, enter `/prompt-info`. The host redacts recognized secret patterns before returning a snapshot, but the remaining text can still contain private project instructions. Treat the full `text` field as sensitive local data even when `redacted` is true.
