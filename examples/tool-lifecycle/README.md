# Tool lifecycle example

This package registers `guarded_echo`, blocks only calls whose text starts with `private:`, and transforms successful results into a reviewed JSON observation. The guard and transform are scoped by tool name, so unrelated tools are unchanged.

From this `tool-lifecycle` directory:

```sh
rigyn install .
rigyn
```

Ask the model to call `guarded_echo` with ordinary text, then with `private: do not echo`. The first result contains `{"echo":"...","reviewed":true}`; the second call becomes a model-visible blocked result without executing the tool. Remove the package with `rigyn remove tool-lifecycle-example`.

Lifecycle listeners receive cloned, bounded values and run in deterministic extension order. A guard failure blocks execution, while a result-listener failure leaves the already-produced tool result visible and records a diagnostic. The package targets extension manifest schema 1 and the public APIs documented for the installed Rigyn build.
