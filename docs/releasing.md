# Release policy and procedure

## Version policy

Rigyn uses `major.minor.patch` versions and `v<version>` Git tags. While the project is below 1.0:

- patch releases contain backward-compatible fixes, security updates, and documentation corrections;
- minor releases may add features and may contain a documented breaking change;
- every breaking change needs a `Breaking` changelog section and concrete migration steps;
- database upgrade-floor changes, public subpath changes, CLI removals, and configuration incompatibilities are always release-impacting.

After 1.0, incompatible changes require a major version. A published package version is immutable and is never reused.

The same version must appear in `package.json`, the root package in `package-lock.json`, `src/version.ts`, the changelog release heading, and the Git tag. `Unreleased` stays at the top of the changelog. Release-visible work is classified under `Added`, `Changed`, `Fixed`, `Security`, `Deprecated`, `Removed`, or `Breaking`.

## Distribution model

The release artifact is one Node-native npm archive rather than six bundled executables. JavaScript and declarations are platform-neutral; npm resolves the pinned native production dependencies for the consumer's operating system and architecture. The workflow installs that exact archive and exercises its CLI, public imports, image native module, and ripgrep binary on Linux, macOS, and Windows for x64 and arm64 before publication.

The staged output contains:

- `rigyn-<version>.tgz`;
- `SHA256SUMS`;
- `release-manifest.json`, including SHA-256, npm SHA-512 integrity, size, Node range, and verified targets;
- `RELEASE_NOTES.md`, extracted from the matching changelog section.
- `.rigyn-release-output.json`, which marks the directory as staging-owned before a later run may replace it.

Staging refuses to replace a directory without that exact ownership marker and swaps a completed staging directory into place without first deleting the previous output. It includes no timestamp, host path, credentials, or generated release prose. The archive is built once and attached to the GitHub release after verification. When npm publishing is enabled, those same bytes are also published to npm.

## Maintainer checklist

1. Move classified entries from `Unreleased` into a dated `[version]` section.
2. Update `package.json`, `package-lock.json`, and `src/version.ts` together.
3. Review migrations, public API changes, provider behavior, security impact, and platform notes.
4. Run `npm run check`, `npm run test:coverage:risk`, `npm run benchmark:runtime`, and `npm run release:stage`.
5. Inspect `.release/RELEASE_NOTES.md`, `.release/release-manifest.json`, and `SHA256SUMS`.
6. Create and push the exact `v<version>` tag. Do not move or reuse a published tag.
7. Let the release workflow verify the single archive on every declared target.

On a tag, independent risk-coverage and runtime-performance guards must pass before release staging begins. The workflow then creates or updates a draft GitHub release, uploads the staged files, and makes the release public only after every declared platform verifies the archive. Setting the repository variable `NPM_PUBLISH_ENABLED` to `true` also publishes the exact staged archive to npm with provenance before the GitHub release becomes public. Configure npm trusted publishing for `Rigyn/rigyn` and `release.yml` before enabling that variable. A rerun accepts an already-published npm version only when its registry integrity exactly matches the staged archive.

The first npm publication requires an npm owner to bootstrap the package. Publish only the exact verified archive, then configure the trusted publisher, remove the bootstrap credential, and enable `NPM_PUBLISH_ENABLED` for later releases. A GitHub-only release remains valid while npm publication is disabled. The default `rigyn self-update` path refuses to replace an installation with an older npm `latest`; after reviewing a rollback or alternate artifact, an operator may explicitly set `RIGYN_UPDATE_SPEC` to that exact version or archive.

Manual workflow dispatch performs the regression guards, staging, and full platform verification without publishing.

## Failure handling

Do not publish a rebuilt archive under an existing version. If staging or platform verification fails, fix the source and create a new commit before tagging. If npm publication succeeds but final GitHub release publication fails, rerun the same tagged commit; integrity comparison prevents different bytes from being accepted. If published bytes are wrong, document the issue and release a new version.
