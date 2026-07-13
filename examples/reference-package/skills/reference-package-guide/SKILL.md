---
name: reference-package-guide
description: Verify the reference extension package without network access.
---

# Reference package guide

Use this skill when checking whether the example package is installed and active.

1. Confirm the selected provider is `reference-offline` and the model is `reference-offline-v1`.
2. Confirm the available tools include `reference_echo`.
3. Ask the model to echo a short, non-secret marker through `reference_echo`.
4. Report the tool result and the final provider response. Do not use the network or modify workspace files.
