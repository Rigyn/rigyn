import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesRoot = join(repositoryRoot, "packages");
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name));
const packages = await Promise.all(packageDirectories.map(async (directory) => ({
  directory,
  manifest: JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
})));
const failures = [];

if (rootManifest.private !== true || rootManifest.name !== "rigyn-workspace") {
  failures.push("The repository root must be the private rigyn-workspace workspace container");
}
for (const forbidden of ["main", "types", "exports", "bin", "files", "publishConfig", "dependencies"]) {
  if (rootManifest[forbidden] !== undefined) failures.push(`Root package.json must not define ${forbidden}`);
}
const productPackages = packages.filter(({ manifest }) => manifest.name === "rigyn");
if (productPackages.length !== 1 || !productPackages[0]?.directory.endsWith(`${sep}rigyn`)) {
  failures.push("Exactly packages/rigyn must own the rigyn package");
}
const version = productPackages[0]?.manifest.version;
for (const { directory, manifest } of packages) {
  if (manifest.version !== version) failures.push(`${relative(repositoryRoot, directory)} has version ${manifest.version}, expected ${version}`);
  const license = await readFile(join(directory, "LICENSE"), "utf8").catch(() => undefined);
  const rootLicense = await readFile(join(repositoryRoot, "LICENSE"), "utf8");
  if (license !== rootLicense) failures.push(`${relative(repositoryRoot, directory)}/LICENSE differs from the repository license`);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, dependency] of Object.entries(manifest[section] ?? {})) {
      if (typeof dependency === "string" && /^(?:file|link|workspace):/u.test(dependency)) {
        failures.push(`${relative(repositoryRoot, directory)}/package.json ${section}.${name} uses a local resolution`);
      }
    }
  }
}
const productSecurity = await readFile(join(packagesRoot, "rigyn", "SECURITY.md"), "utf8").catch(() => undefined);
const rootSecurity = await readFile(join(repositoryRoot, "SECURITY.md"), "utf8");
if (productSecurity !== rootSecurity) failures.push("packages/rigyn/SECURITY.md differs from root SECURITY.md");

const sourceFiles = [];
async function walk(directory) {
  const info = await stat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:c|m)?(?:j|t)sx?$/u.test(entry.name)) sourceFiles.push(path);
  }
}
for (const { directory } of packages) await walk(join(directory, "src"));
const importPattern = /(?:from\s*|import\s*\()(["'])([^"']+)\1/gu;
for (const file of sourceFiles) {
  const owner = packages.find(({ directory }) => file.startsWith(`${directory}${sep}`));
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    if (/^@rigyn\/[^/]+\/(?:src|dist)(?:\/|$)/u.test(specifier)) {
      failures.push(`${relative(repositoryRoot, file)} imports another package's private output: ${specifier}`);
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    const targetPackage = packages.find(({ directory }) => target.startsWith(`${directory}${sep}`));
    if (owner !== undefined && targetPackage !== undefined && owner.directory !== targetPackage.directory) {
      failures.push(`${relative(repositoryRoot, file)} crosses a workspace by relative import: ${specifier}`);
    }
  }
}

if (failures.length > 0) throw new Error(`Workspace boundary check failed:\n${failures.join("\n")}`);
process.stdout.write(`Workspace boundaries passed for ${packages.length} packages.\n`);
