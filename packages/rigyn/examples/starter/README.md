# Starter extension

This is the smallest complete rigyn package in the example corpus. It registers the `/example-hello` command and the `example_text_length` model tool.

From the rigyn source checkout:

```text
rigyn install ./packages/rigyn/examples/starter
```

Run `/reload`, then enter `/example-hello Ada`. Use `rigyn list --json` to find the installed package ID, then remove it with `rigyn remove PACKAGE_ID`.

The package has no network, process, credential, or filesystem authority.
