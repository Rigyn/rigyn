# Provider request hooks

This example adds one non-secret metadata field and one correlation header
before a provider request.

```text
rigyn install ./packages/rigyn/examples/provider-hooks
```

Direct provider hooks are trusted in-process code. Header hooks receive the
complete assembled request and response headers, including headers that carry
credentials.

This example stores only the response status and a bounded request identifier.
The response hook does not receive response bodies. Run
`/example-provider-hooks` after a request to inspect the latest redacted
observation.
