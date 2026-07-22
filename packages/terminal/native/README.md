# Native terminal helpers

The Darwin helper reads modifier state for terminals that cannot distinguish Return from Shift+Return. The Windows helper enables virtual-terminal input after Node enters raw mode.

Release builds compile each C source as an N-API module for x64 and arm64. `targets.json` is the authoritative list of source and output paths.

Run `npm run native:build` on each matching macOS or Windows architecture, then run `npm run native:verify` on that worker to load the result. The release workflow uploads each verified output separately and downloads it into the path declared by `targets.json`. After all four are collected, `npm run native:verify -- --release` checks the complete set before staging. Release staging also checks that every declared output is present in the packed `@rigyn/terminal` archive, and each matching platform verifier loads the helper from an installed copy of that archive. The package's `prepublishOnly` script enforces the complete artifact check for a direct package publication.
