# Native platform helpers

The Darwin N-API module reads modifier state for terminals that cannot distinguish Return from Shift+Return. The
Windows N-API module enables virtual-terminal input after Node enters raw mode. Darwin releases also include the
`rigyn-keychain-helper` executable, which accesses the current user's generic-password items through Apple's
Security framework.

`targets.json` is the authoritative list of source and output paths. Its four platform/architecture targets produce
six artifacts: four N-API modules and one Keychain executable for each Darwin architecture.

The Keychain executable accepts one bounded, versioned JSON request on standard input and writes one bounded JSON
response on standard output. Service names, account names, and secrets are never command-line arguments or
environment variables. Protocol and Security-framework failures return only a generic error.

Run `npm run native:build` on each matching macOS or Windows architecture, then run `npm run native:verify` on that
worker to load and exercise the matching artifacts. The release workflow uploads each target directory and downloads
it into the paths declared by `targets.json`. After all four target directories are collected,
`npm run native:verify -- --release` checks the complete six-artifact set before staging. Release staging also checks
that every declared output is present in the packed `@rigyn/terminal` archive, and each matching platform verifier
loads or executes the artifacts from an installed copy of that archive.
