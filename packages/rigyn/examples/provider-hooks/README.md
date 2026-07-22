# Provider request hooks

Adds one non-secret metadata field before a provider request and adds a correlation header. Direct provider hooks are trusted in-process code, so the header hooks receive the complete assembled request and response headers, including credential-bearing headers. This example retains only response status plus a bounded request identifier; the response hook does not receive response bodies.

Run `/example-provider-hooks` after a request to inspect the latest redacted observation.

```text
rigyn install ./packages/rigyn/examples/provider-hooks
```
