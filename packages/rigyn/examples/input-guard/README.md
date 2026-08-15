# Input and permission guard

This example shows two separate controls:

- bounded user-input interception;
- a fail-closed guard for the built-in `bash` tool.

```text
rigyn install ./packages/rigyn/examples/input-guard
```

It handles `/example-ignore`, shortens oversized submitted text, and blocks
three privileged command names before execution. This guard is a policy hook,
not an operating-system sandbox.
