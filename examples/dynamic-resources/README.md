# Dynamic resources

This focused runtime extension contributes one skill, prompt, and theme through `resources_discover` after activation. Run it from this `dynamic-resources` directory:

```sh
rigyn --offline --extension ./index.mjs
```

Relative result paths resolve from this directory. Reloading rebuilds and atomically replaces the discovered resources.
