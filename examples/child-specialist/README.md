# Child specialist example

`specialist_review` delegates one focused review inside the active Rigyn process. The child receives an explicit read-only tool allowlist, a short timeout, an output bound, and either appended task guidance or a deliberate replacement role. The host still enforces its non-recursive child invariant.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools read,grep,find,ls,specialist_review -p "Use specialist_review to inspect the configuration parser."
rigyn remove child-specialist-example
```

Prefer `appendSystemPrompt` when ordinary host instructions should remain. Use `systemPrompt` only when the child genuinely needs a complete role replacement. This example never launches another Rigyn process and keeps child sessions ephemeral.
