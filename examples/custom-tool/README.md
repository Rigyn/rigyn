# Custom tool example

`text_metrics` shows the smallest useful runtime tool: one stable name, a closed JSON schema, deterministic output, and no filesystem or network authority.

From this `custom-tool` directory:

```sh
rigyn install .
rigyn --tools read,text_metrics -p "Use text_metrics on: one two three"
rigyn remove custom-tool-example
```

The tool uses the host's top-level `status`, `summary`, and `nextActions` result fields, while bounded domain data remains in `content`. The package targets extension manifest schema 1 and Rigyn 0.1.x.
