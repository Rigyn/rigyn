# Brokered custom provider

This protocol example registers a provider and an API-key login method while keeping the key behind the host credential broker. The extension declares one exact HTTPS origin and calls `api.auth.fetch`; it never reads, stores, logs, or returns a credential string.

The `.invalid` endpoint is deliberate. Copy the package, replace the origin and normalized response parser with the real provider contract, and keep provider wire behavior inside this adapter. Do not accept caller-supplied authorization headers or broaden the origin to user input.

```sh
rigyn extensions author report .
rigyn --package .
```

After configuring the copied provider, use `/login`, select `Brokered gallery provider`, and choose its available model through `/model`. Runtime code is trusted Node.js code; authenticated request brokering protects credential bytes but is not a code sandbox.
