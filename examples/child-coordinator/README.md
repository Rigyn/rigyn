# Child coordinator example

`coordinate_reviews` demonstrates parallel child delegation inside the active Rigyn process. Each child inherits the parent model and stable branch context, receives an explicit read-only tool allowlist, reports bounded progress in the parent tool row, follows parent cancellation, and is awaited through `Promise.allSettled` before the parent continues.

This is an authoring reference, not a bundled subagent product. From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools read,grep,find,ls,coordinate_reviews -p "Use coordinate_reviews for separate security and persistence reviews."
rigyn remove child-coordinator-example
```

The example uses ephemeral children. A product that deliberately retains child sessions must document retention, cleanup, and user navigation.
