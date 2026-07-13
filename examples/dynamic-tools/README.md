# Dynamic tools example

This package keeps one loader tool available while atomically adding or removing two focused text tools for the next provider turn. Existing active tools from the host or other packages are preserved.

From this `dynamic-tools` directory:

```sh
rigyn install .
rigyn
```

Run `/dynamic-tools loader-only`, then ask the model to activate the text toolset. `load_text_toolset` returns the exact queued selection; on the following provider turn the model can call `text_uppercase` or `text_lowercase`. Run `/dynamic-tools loader-only` again to unload them. Remove the package with `rigyn remove dynamic-tools-example`.

`setActiveTools` changes a session branch at the next safe provider boundary. It does not mutate an executing batch, and it rejects unavailable names. This is the portable dynamic-loading contract; providers still receive complete definitions for the selected tools. The package targets extension manifest schema 1 and Rigyn 0.1.x.
