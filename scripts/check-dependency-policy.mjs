import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const packageDirectories = (await readdir(join(repositoryRoot, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(repositoryRoot, "packages", entry.name));
const manifests = [
  { path: join(repositoryRoot, "package.json"), value: rootManifest },
  ...await Promise.all(packageDirectories.map(async (directory) => ({
    path: join(directory, "package.json"),
    value: JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
  }))),
];
const workspaceVersions = new Map(
  manifests.slice(1).map(({ value }) => [value.name, value.version]),
);
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const failures = [];

for (const { path, value } of manifests) {
  for (const section of sections) {
    for (const [name, version] of Object.entries(value[section] ?? {})) {
      const label = `${path.slice(repositoryRoot.length + 1)}:${section}.${name}`;
      if (typeof version !== "string" || !exactVersion.test(version)) {
        failures.push(`${label} must use an exact registry version, received ${String(version)}`);
        continue;
      }
      const workspaceVersion = workspaceVersions.get(name);
      if (workspaceVersion !== undefined && version !== workspaceVersion) {
        failures.push(`${label} must match workspace version ${workspaceVersion}`);
      }
    }
  }
}

if (failures.length > 0) throw new Error(`Dependency policy failed:\n${failures.join("\n")}`);
process.stdout.write(`Dependency policy passed for ${manifests.length - 1} workspaces.\n`);
