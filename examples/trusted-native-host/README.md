# Trusted native host example

This example demonstrates Rigyn's explicitly privileged extension tier. It can observe or replace provider behavior, read raw session and live prompt state, resolve credential metadata, update user configuration, and mount native terminal UI.

Do not copy all six permissions into an ordinary extension. Start with the normal runtime API and request only a capability that cannot be implemented safely through it. Privileged packages must be locally trusted and manually reviewed because their Node.js code already runs with the invoking user's process authority.

The example keeps every effect command-driven:

- `/native-inspect [provider]` reports safe host and session metadata. It never prints credential values.
- `/native-wire <provider|off>` observes the host's redacted provider-response telemetry.
- `/native-override <provider> [model]` replaces an existing provider with an offline adapter; `/native-override off` restores it.
- `/native-theme-config <theme>` explicitly updates the user-level theme setting.

The mounted widget and input observer demonstrate native UI ownership without consuming keystrokes or replacing the editor. Reloading or unloading the extension disposes all registrations and restores provider state.

Run from a source checkout:

```bash
npm run dev -- --extension ./examples/trusted-native-host
```
