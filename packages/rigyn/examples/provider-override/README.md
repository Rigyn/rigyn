# Provider override extension

This package replaces the active `ollama` model catalog with one local OpenAI-compatible model. Rigyn owns restoration when the extension generation unloads. `/example-provider-disable` demonstrates an earlier, explicit removal.

The endpoint is fixed to `127.0.0.1`; no remote credential is embedded or requested. Change the model metadata in a copy before using it with a real local server.

```text
rigyn install ./packages/rigyn/examples/provider-override
```
