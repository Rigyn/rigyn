# Safe input assistance

This extension demonstrates generation-owned autocomplete and editor middleware without accessing the terminal controller or emitting ANSI.

Run it from the package root:

```sh
rigyn --offline --extension ./examples/input-assist/runtime/index.mjs
```

Type `:r` and press Tab to choose a completion. Typing a second semicolon after an existing semicolon replaces the pair with an em dash. The middleware uses only the bounded editor snapshot/replacement contract; core interrupt, exit, suspension, and application shortcuts never enter it.
