# Managed provider catalog

This example registers a custom provider with a refreshable model catalog and
managed OAuth callbacks.

```text
rigyn install ./packages/rigyn/examples/provider-catalog
```

The callback bodies are safe placeholders:

- login refuses until an author adds a reviewed authorization flow;
- refresh returns the existing credential;
- API-key extraction stays inside the host credential boundary.

The example has no working endpoint. Do not use it unchanged as a credential
flow. It is an executable registration contract for authors who already
operate a provider service.
