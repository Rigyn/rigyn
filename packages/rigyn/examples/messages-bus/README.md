# Messages and event bus

This example connects the process-local event bus to session messages.

```text
rigyn install ./packages/rigyn/examples/messages-bus
```

`/example-message TEXT` publishes one local topic. The listener appends a
custom session message and renders it as a structured row. The extension
disposes the subscription when its runtime generation is replaced.

The Markdown transformer turns `[[example-note]]` into a bold “Example note:”
label in user and assistant Markdown without changing the stored message.
