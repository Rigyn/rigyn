# Package discovery index

`resources/package-gallery.json` is the bundled package-discovery index. It stays empty until independently published packages have immutable sources and reviewed metadata.

The index is a directory of claims. It is not an allowlist, security endorsement, installer, or executable registry.

The machine-readable schema is [`resources/schemas/package-gallery-v1.json`](../resources/schemas/package-gallery-v1.json). It is a portable structural preflight, not the authoritative validator. JSON Schema cannot express every UTF-8 byte limit, semantic-version range, cross-field equality, canonical URL and timestamp rule, or duplicate package-ID check in this contract. Always validate and normalize an index with:

```sh
rigyn extensions author index ./gallery.json --json
```

The parser rejects unknown keys, duplicate IDs, moving npm selectors, short or named Git refs, credential-bearing URLs, malformed timestamps, and unbounded record collections.

Output is sorted by package ID. Media and warning lists are normalized, so identical input records produce identical serialized bytes.

## Record contract

Each package record contains:

- package ID, display name, exact semantic version, and optional description;
- either an exact npm version with SRI archive integrity or a credential-free HTTPS Git repository with a full commit ID;
- rigyn host-version range;
- counts for runtime entries, tools, commands, skills, prompts, custom themes, and providers;
- HTTPS README, optional homepage, and bounded image/video metadata;
- publication timestamp;
- explicit integrity and provenance status;
- bounded security warnings and production dependency count.

An npm record installs through the ordinary `npm:NAME@VERSION` source. A Git record installs through the immutable `git:URL#REVISION` source.

A gallery consumer must check the record's host-version range before offering installation. `extensionGalleryInstallSource()` converts the source; it does not perform that policy check.

The normal package manager still stages privately, validates resource paths, disables lifecycle scripts by default, records provenance, and commits atomically. Gallery metadata never bypasses those controls.

`verified` means the index publisher checked the supplied digest or provenance evidence. It does not make trusted Node.js runtime code safe. Keep warnings factual and specific, and use `unverified` or `unknown` when evidence is unavailable.

## Exact Git consumption

A Git-backed package must live at the repository root and use a full lowercase commit ID. The gallery package version is also exact; consumers should check `compatibility.hostVersion`, then verify that the installed manifest reports the indexed package version. A minimal source record is:

```json
{
  "version": "1.2.3",
  "source": {
    "kind": "git",
    "repository": "https://code.example/acme/rigyn-memory.git",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "compatibility": { "hostVersion": ">=0.1.0 <0.2.0" }
}
```

`extensionGalleryInstallSource()` converts that source to:

```text
git:https://code.example/acme/rigyn-memory.git#0123456789abcdef0123456789abcdef01234567
```

Install only that exact string. Never replace the revision with a branch, tag, abbreviated hash, or default branch.

The managed lock records the resolved immutable identity. Updating means selecting and reviewing a new gallery record and commit, not moving the existing record.

## Publishing workflow

From the package root:

```sh
rigyn extensions author validate .
rigyn extensions author inspect .
rigyn extensions author smoke .
rigyn extensions author refresh .
rigyn extensions author report .
rigyn extensions author pack . ./artifacts
```

| Command | Result |
| --- | --- |
| `validate` | Resolve a temporary managed copy without importing its runtime. |
| `inspect` | Report the exact `npm pack --dry-run` file set for its required `package.json`. |
| `smoke` | Activate and dispose a temporary copy through the direct runtime loader. |
| `refresh` | Activate a candidate generation before disposing the first generation. |
| `report` | Run the four non-mutating checks and return deterministic `status`, `summary`, `nextActions`, `artifacts`, and per-check details. |
| `pack` | Create a durable artifact at an explicit destination without overwriting an existing filename, then resolve those exact bytes through the normal package validator. |

The npm subprocess receives a private empty npm configuration, no registry credentials, disabled lifecycle scripts, bounded output, and a timeout. It is packaging, not an operating-system sandbox. Extension runtime entries execute as trusted in-process Node.js modules during smoke and refresh checks.
