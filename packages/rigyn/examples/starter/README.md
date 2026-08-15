# Starter extension

This is the smallest runnable rigyn package and a starter for a distributable extension. It registers:

- the `/example-hello` command;
- the `example_text_length` model tool.

The bundled example is `private` to prevent accidental publication from the rigyn repository. A distributable copy should use its own package name and remove `private` only when it is ready to publish. The declared `peerDependencies.rigyn` range is the host compatibility gate and prevents a nested rigyn runtime.

From this package directory, test callback behavior and then exercise the real package loader without installing it:

```text
npm test
rigyn extensions author report .
```

`checks/runtime.test.mjs` uses only Node's test runner and the public extension factory shape. The author report adds validation, staged activation/disposal, and valid-candidate refresh checks.

From the rigyn source checkout:

```text
rigyn install ./packages/rigyn/examples/starter
```

Run `/refresh`, then enter `/example-hello Ada`.

Use `rigyn list --json` to find the installed package ID. Remove it with
`rigyn remove SOURCE`.

The package has no network, process, credential, or filesystem authority.
