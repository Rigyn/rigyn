# Custom tool example

`text_metrics` shows the smallest useful runtime tool: one stable name, a closed JSON schema, deterministic output, and no filesystem or network authority.

From this `custom-tool` directory:

```sh
node --test runtime.activation.mjs
rigyn install .
rigyn --tools read,text_metrics -p "Use text_metrics on: one two three"
rigyn remove custom-tool-example
```

The first command is a dependency-free package-local activation test: it imports
`./runtime/index.mjs` from the activation check and supplies only the host method the
runtime uses. The later commands exercise the real installed host. Keep these two
verification layers separate when the package does not install Rigyn as a
resolvable development dependency.

The tool uses the host's top-level `status`, `summary`, and `nextActions` result fields. `content` is always a string, so structured domain data is serialized with `JSON.stringify(...)` and parsed by the test. The package targets extension manifest schema 1 and the public APIs documented for the installed Rigyn build.
