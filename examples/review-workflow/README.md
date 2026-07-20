# Review workflow example

`review_workflow` is a complete in-process vertical slice: a model-callable tool delegates a bounded read-only review, awaits its normalized result, appends a durable namespaced state record, and returns only after persistence succeeds. The latest completion renders in the session transcript.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools read,grep,find,ls,review_workflow -p "Use review_workflow to review the session persistence boundary."
rigyn remove review-workflow-example
```

The durable record is intentionally a result snapshot, not a second transcript. It bounds copied output, retains child status and identity, and never starts a detached process or a second harness instance.
