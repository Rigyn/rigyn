# Custom provider example

This package implements the provider-neutral adapter contract directly. It has one deterministic model, makes no network requests, uses no provider SDK, and needs no credential. That makes it useful for extension development and end-to-end harness tests.

From this `custom-provider` directory:

```sh
rigyn install .
rigyn --list-models gallery-offline
rigyn --provider gallery-offline --model gallery-offline-v1 --no-session --print -p "hello"
rigyn remove custom-provider-example
```

The final text is `Offline provider: hello`. Production providers must normalize their wire protocol into the same response, text, reasoning, tool-call, usage, end, and error events. Keep wire-specific parsing inside the package and keep credentials behind `api.auth`. The package targets extension manifest schema 1 and Rigyn 0.1.x.
