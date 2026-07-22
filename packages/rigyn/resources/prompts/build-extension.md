---
description: Build or repair a verified, installable Rigyn extension or package.
argument-hint: "<extension request>"
---
Build the following Rigyn extension or package end to end:

{{input}}

First load and follow the available `build-extension` skill. If skill discovery was intentionally disabled, read `{{promptDir}}/../../docs/extensions.md`, `{{promptDir}}/../../docs/packages.md`, and the smallest relevant example under `{{promptDir}}/../../examples/` before writing code. Those paths resolve inside the installed Rigyn package and are read-only references. Define a compact acceptance matrix, implement real user-visible behavior, add focused failure-aware tests, and exercise the result through the normal install and reload path. Use only APIs verified in this installed version. Do not stop at a manifest, mock UI, decorative dashboard, or activation-only demo.

Create the result in a fresh package directory inside the active user workspace. Bundled Rigyn examples and installed documentation are read-only references: do not edit them or use an installed example directory as the output unless the user explicitly requested maintenance of that exact example.
