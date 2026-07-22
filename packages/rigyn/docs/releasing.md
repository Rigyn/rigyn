# Release policy and procedure

## Version policy

rigyn uses `major.minor.patch` versions and `v<version>` Git tags. While the project is below 1.0:

- patch releases contain backward-compatible fixes, security updates, and documentation corrections;
- minor releases may add features and may contain a documented breaking change;
- every breaking change needs a `Breaking` changelog section and concrete migration steps;
- durable session-format or storage upgrade-floor changes, public subpath changes, CLI removals, and configuration incompatibilities are always release-impacting.

After 1.0, incompatible changes require a major version. A released version is immutable and is never reused.

The same version must appear in all four release workspace manifests, their internal dependency pins and `package-lock.json` entries, `packages/rigyn/src/version.ts`, the changelog release heading, and the Git tag. `Unreleased` stays at the top of the changelog. Release-visible work is classified under `Added`, `Changed`, `Fixed`, `Security`, `Deprecated`, `Removed`, or `Breaking`.

## Distribution model

Every release contains a dependency-ordered set of four npm-compatible package archives, six standalone runtime archives, and one versioned source archive. The package set contains `@rigyn/terminal`, `@rigyn/models`, `@rigyn/kernel`, and the `rigyn` product. JavaScript and declarations are platform-neutral; npm resolves their pinned native production dependencies for the consumer's operating system and architecture. The `@rigyn/terminal` archive additionally carries the four N-API helpers declared by `packages/terminal/native/targets.json`. Matching macOS and Windows x64/arm64 workers build and load those helpers before staging; staging cannot proceed until all four outputs have been collected at their declared package paths.

The source archive is `rigyn-v<version>-source.tar.gz`, rooted at `rigyn-v<version>/`. It is created from the exact release commit with `git archive`, not from the mutable workflow checkout, then compressed with normalized gzip metadata. Dependencies, build directories, and generated native binaries are excluded. Staging rejects an archive that escapes its versioned root or omits the root lockfile, workspace source/build inputs, native helper sources, or private source installer. Its commit, SHA-256, size, filename, and archive root are recorded in the release manifest.

Each target worker installs the exact staged npm graph, copies the pinned official Node 24.15.0 runtime and its license, creates a deterministic `tar.gz`, and executes real version, help, and offline RPC startup checks before upload. A finalization job verifies every target sidecar and checksum before it adds those archives to the release manifest. The verification matrix then extracts the matching archive and repeats its runtime checks, in addition to exercising the npm CLI, public imports, image native module, ripgrep binary, and packed terminal helper. A macOS or Windows verifier loads the helper matching its own platform and architecture.

Artifact assembly prefers the runner's npm cache but may contact the public registry to hydrate missing production dependencies from the exact staged package manifests. Credential variables are stripped from this install environment. Offline guarantees apply to the completed standalone runtime checks, which do not depend on registry or provider access.

The staged output contains:

- `rigyn-terminal-<version>.tgz`, `rigyn-models-<version>.tgz`, `rigyn-kernel-<version>.tgz`, and `rigyn-<version>.tgz`;
- `rigyn-v<version>-source.tar.gz`;
- `rigyn-v<version>-<platform>-<arch>.tar.gz` for every declared target;
- `SHA256SUMS`;
- `release-manifest.json`, including npm integrity, every artifact SHA-256 and size, the Node range, the exact embedded Node version, and verified targets;
- `RELEASE_NOTES.md`, extracted from the matching changelog section.
- `.rigyn-release-output.json`, which marks the directory as staging-owned before a later run may replace it.

Staging refuses to replace a directory without that exact ownership marker and swaps a completed staging directory into place without first deleting the previous output. It includes no timestamp, host path, credentials, or generated release prose. The archives are built once and attached only to the GitHub release after verification. All four first-party package manifests are registry-private; the `.tgz` format remains an installation and verification format rather than an npm registry publication path.

## Maintainer checklist

1. Move classified entries from `Unreleased` into a dated `[version]` section.
2. Update the four release workspace manifests, their internal dependency pins, `package-lock.json`, and `packages/rigyn/src/version.ts` together.
3. Review migrations, public API changes, provider behavior, security impact, and platform notes.
4. On macOS or Windows, first run `npm run native:build --workspace @rigyn/terminal` so the local native verification has a matching helper. Then run `npm run check`, `npm run test:coverage:risk`, and `npm run benchmark:runtime`. Run `npm run release:stage` only after all four native outputs have been collected; the release workflow performs that collection automatically. A local standalone build additionally requires the official Node 24.15.0 distribution root and uses `npm run release:standalone -- --directory .release --output .standalone --runtime-root <node-root>`.
5. Inspect `.release/RELEASE_NOTES.md`, `.release/release-manifest.json`, the versioned source archive, and `SHA256SUMS`.
6. Create and push the exact `v<version>` tag. Do not move or reuse a published tag.
7. Let the release workflow verify the complete archive set on every declared target.

On a tag, independent risk-coverage and runtime-performance guards and all four matching native builds must pass before release staging begins. Each native build is uploaded as a workflow artifact, downloaded directly into its manifest-declared package path, and checked as a complete set before `npm pack --ignore-scripts` runs. The six matching target workers must then build and execute their standalone archives; no target result is inferred from another host. Before GitHub release publication, the Linux x64 verifier also extracts the staged source archive into a clean directory, installs from its lockfile, and runs the complete monorepo build. The workflow creates or updates a draft GitHub release, uploads the finalized files, and makes the release public only after every declared platform verifies both distribution paths and the source rebuild. It has no npm registry publication step, publication registry configuration, npm token, or OIDC publication permission.

GitHub Releases are the sole first-party distribution channel. A release carries the complete four-archive package graph for npm-based installation, plus standalone archives that require neither Node.js nor npm. Publishing a release requires no npm account, registry token, or trusted-publisher configuration.

Manual workflow dispatch performs the regression guards, staging, and full platform verification without publishing a GitHub release.

## Failure handling

Do not publish a rebuilt archive under an existing version. If staging or platform verification fails, fix the source and create a new commit before tagging. If draft creation or asset upload fails, rerun the same tagged commit so the workflow resumes the existing draft with the same verified source. If released bytes are wrong, document the issue and release a new version.
