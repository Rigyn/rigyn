# Resource discovery example

`discover_resources` reads the same bounded catalog used by the host for commands, prompt templates, and skills. It performs local kind and text filtering over callback-free metadata and preserves the host's truncation and omission counts.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools discover_resources -p "Find available review prompts and testing skills."
rigyn remove resource-discovery-example
```

Use `getDiscoveryView` when one interface needs all three resource types. Use synchronous `getCommands` only when an extension specifically needs runtime command registrations and no prompts or skills.
