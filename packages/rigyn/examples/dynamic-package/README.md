# Dynamic package extension

This package uses the `resources_discover` event to add its `skills/` and `prompts/` directories during startup and reload. Use dynamic discovery only when resource paths depend on runtime initialization; fixed resources should be declared directly in `package.json`.

```text
rigyn install ./packages/rigyn/examples/dynamic-package
```

After `/reload`, `/example-dynamic-ready` confirms activation and the `dynamic-review` skill and prompt appear in resource discovery.
