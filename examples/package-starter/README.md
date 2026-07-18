# Package starter

This is the smallest complete package in the gallery: one manifest, one trusted runtime entry, and one public-loader activation test. Copy this directory into a new directory in the active workspace, then change the manifest `id`, `name`, `version`, and command implementation.

```sh
node --test activation.test.mjs
rigyn --package . --offline --list-models
rigyn install .
rigyn
```

Run `/starter-review authentication flow` in the TUI. Remove the installed copy with `rigyn remove package-starter`.

The test imports the public `rigyn/extensions` loader. A copied npm project should declare `rigyn` as a compatible development and peer dependency so the same test resolves without bundling a second host runtime. The example targets extension manifest schema 1 and the public APIs documented for the installed Rigyn build. Runtime modules execute with the invoking user's operating-system access, so review every runtime file and production dependency before installation. Add only the resources the package actually needs; see [Package authoring and gallery](../../docs/packages.md) before publishing.
