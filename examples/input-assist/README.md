# Safe input assistance

This extension demonstrates generation-owned autocomplete, editor middleware, and bounded structural editor rendering without accessing the terminal controller or emitting ANSI.

Run it from the package root:

```sh
rigyn --offline --extension ./examples/input-assist/runtime/index.mjs
```

Type `:r` and press Tab to choose a completion. Typing a second semicolon after an existing semicolon replaces the pair with an em dash. The renderer adds a compact prompt and keeps the cursor visible; the host still owns the draft, editing, submission, interrupts, and terminal protocol. Core interrupt, exit, suspension, and application shortcuts never enter the middleware.
