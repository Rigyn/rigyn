# Package discovery index

`resources/package-gallery.json` is the bundled package-discovery index. It is intentionally empty until independently published packages have immutable sources and reviewed metadata. The index is a directory of claims, not an allowlist, security endorsement, installer, or executable registry.

The machine-readable schema is [`resources/schemas/package-gallery-v1.json`](../resources/schemas/package-gallery-v1.json). Validate and normalize an index with:

```sh
rigyn extensions author index ./gallery.json --json
```

The parser rejects unknown keys, duplicate IDs, moving npm selectors, short or named Git refs, credential-bearing URLs, malformed timestamps, and unbounded record collections. Its output is sorted by package ID; media and warning lists are normalized so identical input records produce identical index bytes after JSON serialization.

## Record contract

Each package record contains:

- package ID, display name, exact semantic version, and optional description;
- either an exact npm version with SRI archive integrity or a credential-free HTTPS Git repository with a full commit ID;
- Rigyn host-version range;
- counts for runtime entries, tools, commands, skills, prompts, themes, and providers;
- HTTPS README, optional homepage, and bounded image/video metadata;
- publication timestamp;
- explicit integrity and provenance status;
- bounded security warnings and production dependency count.

An npm record installs through the ordinary `npm:NAME@VERSION` source. A Git record installs through the ordinary immutable `git:URL#REVISION` source. A gallery consumer must compare the record's host-version range before offering installation; converting a record with `extensionGalleryInstallSource()` does not perform that policy check. The normal package manager still stages privately, validates resource paths, disables lifecycle scripts by default, records provenance, and commits atomically. Gallery metadata never bypasses those controls.

`verified` means the index publisher checked the supplied digest or provenance evidence. It does not make trusted Node.js runtime code safe. Keep warnings factual and specific, and use `unverified` or `unknown` when evidence is unavailable.

## Publishing workflow

From the package root:

```sh
rigyn extensions author validate .
rigyn extensions author inspect .
rigyn extensions author smoke .
rigyn extensions author reload .
rigyn extensions author report .
rigyn extensions author pack . ./artifacts
```

`validate` resolves a temporary managed copy without importing its runtime. `inspect` reports the exact `npm pack --dry-run` file set for its required `package.json`. `smoke` activates and disposes a temporary copy through the direct runtime loader. `reload` activates a candidate generation before disposing the first generation. `report` runs the four non-mutating checks and returns deterministic `status`, `summary`, `nextActions`, `artifacts`, and per-check details. `pack` is the only author action that creates a durable artifact, requires an explicit destination, and resolves that exact archive through the normal package validator before returning it.

The npm subprocess receives a private empty npm configuration, no registry credentials, disabled lifecycle scripts, bounded output, and a timeout. It is packaging, not an operating-system sandbox. Extension runtime entries execute as trusted in-process Node.js modules during smoke and reload checks.
