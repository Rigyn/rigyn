# Reload safety

This minimal package is a probe for candidate-first reload. `extensions author reload .` activates a second generation before disposing the first. In a live invocation, `/reload` follows the same ownership rule: an invalid candidate is discarded and the current generation remains active.

```sh
rigyn extensions author reload .
rigyn --package .
```

Run `/reload-probe`, edit a copied package, and run `/reload`. To test rollback, introduce a deliberate activation error in the copy, confirm reload reports it, then run `/reload-probe` again. Remove the error and reload successfully. Every real extension must release package-owned timers, sockets, files, and child processes in `onDispose`.
