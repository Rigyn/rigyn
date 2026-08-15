import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const workspaceLock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
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

const installScriptPackages = new Set();
for (const [path, value] of Object.entries(workspaceLock.packages ?? {})) {
  if (value?.hasInstallScript !== true) continue;
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(path);
  if (match?.[1] !== undefined) installScriptPackages.add(match[1]);
}
const allowScripts = rootManifest.allowScripts ?? {};
for (const name of installScriptPackages) {
  if (allowScripts[name] !== false) failures.push(`allowScripts.${name} must explicitly deny its install script`);
}
for (const [name, allowed] of Object.entries(allowScripts)) {
  if (!installScriptPackages.has(name)) failures.push(`allowScripts.${name} does not match a locked install script`);
  if (allowed !== false) failures.push(`allowScripts.${name} must be false`);
}

if (failures.length > 0) throw new Error(`Dependency policy failed:\n${failures.join("\n")}`);
process.stdout.write(`Dependency policy passed for ${manifests.length - 1} workspaces.\n`);
