#!/usr/bin/env node

const invocation = process.argv.slice(2);
const metadataOnly = invocation.length === 1
	&& ["--help", "-h", "--version", "-v"].includes(invocation[0]!);

if (!metadataOnly) {
	process.argv.splice(2, invocation.length, "--mode", "rpc", ...invocation);
}

await import("./bin/rigyn.js");
