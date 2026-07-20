# Advanced UI example

This package demonstrates the explicitly trusted `advancedUi` tier without accessing terminal bytes or taking over input. It installs one bounded structural component in each persistent header, widget, and footer slot; supplies short working frames; labels collapsed reasoning; expands completed tool output for its generation; and observes normalized key names without consuming them or reading typed text.

The manifest must opt in with `permissions.advancedUi: true`, and the package must load from a trusted scope. Every override belongs to the active extension generation and is restored when that generation is replaced or closed. The observer's returned disposer is also registered for cleanup.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn
```

Remove the example with `rigyn remove advanced-ui-example`. Persistent component factories return only validated lines and semantic spans. They cannot emit ANSI, intercept submission, consume shortcuts, read raw key bytes, or own the screen.
