# Contributing

## Before changing code

Open or reference an issue for changes that affect public behavior, storage, provider protocols, security boundaries, or package compatibility. State the user-visible outcome and a reproducible acceptance check. Small corrections can go directly to a pull request.

Keep changes narrow. Provider wire formats belong under `src/providers/`, credentials under `src/auth/`, and filesystem boundary decisions in `src/tools/paths.ts`. Preserve append-only session history and opaque provider state. Do not expose hidden reasoning.

## Development

Use Node.js 24.15+ or 26+ and install the exact lockfile:

```sh
npm ci --ignore-scripts
npm run check
```

Add tests for every behavior change. Prefer a focused regression test first, then run the complete check before requesting review. Live-provider tests are opt-in and must not print or persist credentials.

## Pull requests

A pull request should explain the problem, the chosen boundary, verification evidence, user-facing or migration impact, and any remaining risk. Update `CHANGELOG.md` for release-visible changes. Update public API, installation, or release documentation when those contracts change.

Do not mix unrelated cleanup into a functional change. Do not commit generated `dist/`, local sessions, credentials, `.env` files, packed archives, or installation directories.

By submitting a contribution, you agree to license it under the [MIT License](LICENSE).

## Releases and compatibility

Public entry points and version rules are defined in [`docs/public-api.md`](docs/public-api.md) and [`docs/releasing.md`](docs/releasing.md). A change that removes or changes a documented entry point, configuration contract, durable schema, or command behavior needs an explicit compatibility assessment and migration note.
