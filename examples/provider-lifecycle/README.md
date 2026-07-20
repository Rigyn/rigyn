# Provider lifecycle example

`lifecycle-offline` is a deterministic provider used to demonstrate provider ownership. `/provider-lifecycle disable` awaits the disposer returned by `registerProvider`; enabling creates a fresh owned registration. Repeated disable is idempotent, and the host owns final generation cleanup during reload or shutdown.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --provider lifecycle-offline --model lifecycle-offline-v1 -p "Verify the provider is active."
rigyn remove provider-lifecycle-example
```

The example is offline and has no credential authority. A network provider should additionally declare brokered authentication and must still keep its disposer so live disable and reload remove both the adapter and associated auth registration.
