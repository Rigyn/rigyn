# Managed provider catalog

Registers a custom provider with a refreshable model catalog and managed OAuth callbacks. The callback bodies are inert placeholders: login refuses until an author replaces it with a reviewed authorization flow, refresh returns the existing credential, and API-key extraction remains inside the host credential boundary.

The example has no working endpoint and must not be used as a credential flow unchanged. It is an executable registration contract for authors who already operate a provider service.

```text
rigyn install ./packages/rigyn/examples/provider-catalog
```
