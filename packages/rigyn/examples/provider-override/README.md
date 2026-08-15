# Provider override extension

This package replaces the active `ollama` catalog with one local
OpenAI-compatible model. rigyn restores the original registration when the
extension generation unloads.

```text
rigyn install ./packages/rigyn/examples/provider-override
```

`/example-provider-disable` removes the replacement earlier through the host
API.

The endpoint is fixed to `127.0.0.1`. The package does not embed or request a
remote credential. Change the model metadata in a copy before using it with a
real local server.
