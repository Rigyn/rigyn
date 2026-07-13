import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const nonExact = [];

for (const section of sections) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      nonExact.push(`${section}.${name}=${String(version)}`);
    }
  }
}

if (nonExact.length > 0) {
  throw new Error(`Direct dependencies must use exact registry versions:\n${nonExact.join("\n")}`);
}

process.stdout.write("Direct dependency policy passed.\n");
