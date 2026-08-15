# Dynamic package extension

This package uses `resources_discover` to add its `skills/` and `prompts/`
directories during startup and refresh.

```text
rigyn install ./packages/rigyn/examples/dynamic-package
```

After `/refresh`, `/example-dynamic-ready` confirms activation. The
`dynamic-review` skill and prompt also appear in resource discovery.

Use dynamic discovery only when a resource path depends on runtime
initialization. Declare fixed resource paths directly in `package.json`.
