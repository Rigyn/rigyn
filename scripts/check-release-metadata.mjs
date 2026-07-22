import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { RIGYN_PACKAGE_GRAPH } from "../packages/rigyn/scripts/lifecycle-common.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const RELEASE_CATEGORIES = new Set([
  "Added",
  "Breaking",
  "Changed",
  "Deprecated",
  "Fixed",
  "Removed",
  "Security",
]);
const REQUIRED_PRODUCT_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "docs/install.md",
  "docs/public-api.md",
  "docs/releasing.md",
];
const REQUIRED_REPOSITORY_FILES = [
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
];
const EXPECTED_TARGETS = [
  { platform: "linux", arch: "x64", runner: "ubuntu-24.04" },
  { platform: "linux", arch: "arm64", runner: "ubuntu-24.04-arm" },
  { platform: "darwin", arch: "x64", runner: "macos-15-intel" },
  { platform: "darwin", arch: "arm64", runner: "macos-15" },
  { platform: "win32", arch: "x64", runner: "windows-2025" },
  { platform: "win32", arch: "arm64", runner: "windows-11-arm" },
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readText(root, path) {
  const text = await readFile(join(root, path), "utf8");
  assert.notEqual(text.trim(), "", `${path} must not be empty`);
  return text;
}

async function readJson(root, path) {
  return JSON.parse(await readText(root, path));
}

export function extractReleaseNotes(changelog, version) {
  assert.match(version, VERSION_PATTERN, `Invalid release version: ${version}`);
  const normalizedChangelog = changelog.replace(/\r\n?/gu, "\n");
  const heading = new RegExp(`^## \\[${escapeRegex(version)}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "mu");
  const match = heading.exec(normalizedChangelog);
  assert.ok(match, `CHANGELOG.md must contain a dated [${version}] release heading`);
  const bodyStart = match.index + match[0].length;
  const nextHeading = normalizedChangelog.slice(bodyStart).search(/^## /mu);
  const body = normalizedChangelog.slice(bodyStart, nextHeading === -1 ? undefined : bodyStart + nextHeading).trim();
  assert.notEqual(body, "", `CHANGELOG.md release ${version} must not be empty`);
  const categories = [...body.matchAll(/^### (.+)$/gmu)].map((entry) => entry[1]);
  assert.ok(categories.length > 0, `CHANGELOG.md release ${version} needs a change category`);
  for (const category of categories) {
    assert.ok(RELEASE_CATEGORIES.has(category), `Unsupported changelog category: ${category}`);
  }
  assert.match(body, /^- .+/mu, `CHANGELOG.md release ${version} needs at least one list item`);
  return { date: match[1], body };
}

function expectedExport(subpath) {
  if (subpath === "./package.json") return "./package.json";
  if (subpath === "./rpc-entry") return { import: "./dist/rpc-entry.js" };
  const layer = subpath === "." ? "" : `${subpath.slice(2)}/`;
  return {
    types: `./dist/${layer}index.d.ts`,
    import: `./dist/${layer}index.js`,
  };
}

async function checkActionPins(root) {
  const workflowDirectory = join(root, ".github", "workflows");
  const workflows = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/u.test(name)).sort();
  assert.ok(workflows.length > 0, "At least one GitHub Actions workflow is required");
  let actionCount = 0;
  for (const workflow of workflows) {
    const contents = await readText(root, `.github/workflows/${workflow}`);
    for (const [index, line] of contents.split(/\r?\n/u).entries()) {
      const match = /^\s*-?\s*uses:\s*([^\s#]+)/u.exec(line);
      if (match === null || match[1].startsWith("./")) continue;
      actionCount += 1;
      assert.match(
        match[1],
        /^[^@\s]+@[0-9a-f]{40}$/u,
        `${workflow}:${index + 1} must pin the action to a full commit SHA`,
      );
    }
  }
  assert.ok(actionCount > 0, "No external GitHub Actions were checked");
  return actionCount;
}

function validateIssueTemplate(path, document) {
  assert.equal(typeof document?.name, "string", `${path} needs a name`);
  assert.equal(typeof document?.description, "string", `${path} needs a description`);
  assert.ok(Array.isArray(document?.body) && document.body.length > 0, `${path} needs form fields`);
  assert.ok(
    document.body.some((entry) => entry?.validations?.required === true),
    `${path} needs at least one required field`,
  );
}

export function assertWorkspaceLockIdentity(lockfile, { name, directory }) {
  const workspaceEntry = lockfile.packages?.[directory];
  assert.ok(workspaceEntry, `package-lock must contain ${directory}`);
  const canonicalUnscopedPath = !name.includes("/") && directory === `packages/${name}`;
  if (workspaceEntry.name !== undefined || !canonicalUnscopedPath) {
    assert.equal(workspaceEntry.name, name, `package-lock ${directory} name must match package.json`);
  }

  const linkEntry = lockfile.packages?.[`node_modules/${name}`];
  assert.equal(linkEntry?.link, true, `package-lock node_modules/${name} must be a workspace link`);
  assert.equal(linkEntry?.resolved, directory, `package-lock node_modules/${name} must resolve to ${directory}`);
}

export function assertRootLockIdentity(lockfile, rootManifest, productVersion) {
  assert.equal(rootManifest.version, productVersion, "Root package version must match rigyn");
  const rootEntry = lockfile.packages?.[""];
  assert.ok(rootEntry, "package-lock must contain the repository root");
  assert.equal(rootEntry.name, rootManifest.name, "package-lock root name must match package.json");
  assert.equal(rootEntry.version, rootManifest.version, "package-lock root version must match package.json");
}

export async function checkReleaseMetadata(root = REPOSITORY_ROOT) {
  const repositoryRoot = resolve(root);
  const productRoot = resolve(repositoryRoot, "packages/rigyn");
  const workspaceDirectories = (await readdir(resolve(repositoryRoot, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
  const [rootManifest, packageManifests, workspaceManifests, lockfile, changelog, subpathPolicy, platformPolicy, nativeTargets] = await Promise.all([
    readJson(repositoryRoot, "package.json"),
    Promise.all(RIGYN_PACKAGE_GRAPH.map(async ({ directory }) => await readJson(repositoryRoot, `${directory}/package.json`))),
    Promise.all(workspaceDirectories.map(async (directory) => await readJson(repositoryRoot, `${directory}/package.json`))),
    readJson(repositoryRoot, "package-lock.json"),
    readText(productRoot, "CHANGELOG.md"),
    readJson(productRoot, "release/public-subpaths.json"),
    readJson(productRoot, "release/platforms.json"),
    readJson(repositoryRoot, "packages/terminal/native/targets.json"),
  ]);
  const manifests = new Map(packageManifests.map((manifest) => [manifest.name, manifest]));
  const manifest = manifests.get("rigyn");

  assert.equal(manifests.size, RIGYN_PACKAGE_GRAPH.length, "Release package names must be unique");
  assert.deepEqual(
    [...manifests.keys()].sort(),
    workspaceManifests
      .filter((workspaceManifest) => workspaceManifest.publishConfig?.access === "public")
      .map((workspaceManifest) => workspaceManifest.name)
      .sort(),
    "Release graph must contain every public workspace package",
  );
  assert.ok(manifest, "packages/rigyn/package.json must declare rigyn");
  assertRootLockIdentity(lockfile, rootManifest, manifest.version);
  assert.match(manifest.devDependencies?.["@types/node"] ?? "", VERSION_PATTERN, "rigyn must pin @types/node exactly");
  for (const { name, directory } of RIGYN_PACKAGE_GRAPH) {
    const packageManifest = manifests.get(name);
    assert.ok(packageManifest, `${directory}/package.json must declare ${name}`);
    assert.equal(packageManifest.version, manifest.version, `${name} version must match rigyn`);
    assertWorkspaceLockIdentity(lockfile, { name, directory });
    assert.equal(lockfile.packages?.[directory]?.version, packageManifest.version, `package-lock ${directory} version must match package.json`);
    assert.equal(packageManifest.license, "MIT", `${name} must declare the MIT license`);
    assert.equal(packageManifest.publishConfig?.access, "public", `${name} releases must be explicitly public`);
  }
  const expectedInternalDependencies = new Map([
    ["@rigyn/terminal", []],
    ["@rigyn/models", []],
    ["@rigyn/kernel", ["@rigyn/models"]],
    ["rigyn", ["@rigyn/kernel", "@rigyn/models", "@rigyn/terminal"]],
  ]);
  const internalNames = new Set(RIGYN_PACKAGE_GRAPH.map(({ name }) => name));
  for (const { name, directory } of RIGYN_PACKAGE_GRAPH) {
    const packageManifest = manifests.get(name);
    const actual = Object.keys(packageManifest.dependencies ?? {}).filter((dependency) => internalNames.has(dependency)).sort();
    assert.deepEqual(actual, expectedInternalDependencies.get(name), `${name} internal dependency graph is invalid`);
    for (const dependency of actual) {
      const version = manifests.get(dependency).version;
      assert.equal(packageManifest.dependencies[dependency], version, `${name} must pin ${dependency} exactly`);
      assert.equal(lockfile.packages?.[directory]?.dependencies?.[dependency], version, `package-lock ${directory} must pin ${dependency} exactly`);
    }
  }

  assert.equal(typeof manifest.version, "string");
  assert.match(manifest.version, VERSION_PATTERN, "package.json version must be semantic");
  assert.equal(lockfile.packages?.["packages/rigyn"]?.version, manifest.version, "package-lock product version must match package.json");
  assert.equal(manifest.license, "MIT", "package.json must declare the MIT license");
  assert.equal(lockfile.packages?.["packages/rigyn"]?.license, manifest.license, "package-lock product license must match package.json");
  assert.equal(manifest.homepage, "https://github.com/Rigyn/rigyn#readme", "package.json homepage must target the public repository");
  assert.deepEqual(manifest.bugs, { url: "https://github.com/Rigyn/rigyn/issues" }, "package.json bugs URL must target the public repository");
  assert.deepEqual(
    manifest.repository,
    { type: "git", url: "git+https://github.com/Rigyn/rigyn.git", directory: "packages/rigyn" },
    "package.json repository must target the public repository",
  );
  assert.equal(manifest.publishConfig?.access, "public", "npm releases must be explicitly public");
  const versionSource = await readText(productRoot, "src/version.ts");
  assert.equal(
    versionSource.trim(),
    `export const RIGYN_VERSION = ${JSON.stringify(manifest.version)};`,
    "src/version.ts must contain only the package version export",
  );
  const unreleasedIndex = changelog.search(/^## Unreleased$/mu);
  assert.ok(unreleasedIndex >= 0, "CHANGELOG.md must contain an Unreleased section");
  const release = extractReleaseNotes(changelog, manifest.version);
  const releaseIndex = changelog.search(new RegExp(`^## \\[${escapeRegex(manifest.version)}\\] -`, "mu"));
  assert.ok(unreleasedIndex < releaseIndex, "Unreleased must appear before the current release");

  assert.equal(subpathPolicy.schemaVersion, 1, "Unsupported public-subpath policy schema");
  assert.equal(subpathPolicy.runtime, "^24.15.0 || >=26.0.0");
  assert.equal(subpathPolicy.module, "esm");
  assert.ok(Array.isArray(subpathPolicy.subpaths));
  assert.equal(new Set(subpathPolicy.subpaths).size, subpathPolicy.subpaths.length, "Public subpaths must be unique");
  assert.deepEqual(Object.keys(manifest.exports ?? {}), subpathPolicy.subpaths, "package exports must match public-subpaths.json exactly");
  for (const subpath of subpathPolicy.subpaths) {
    assert.deepEqual(manifest.exports[subpath], expectedExport(subpath), `Unexpected export mapping for ${subpath}`);
  }
  assert.equal(manifest.type, "module", "Published JavaScript must remain ESM");
  assert.equal(manifest.engines?.node, "^24.15.0 || >=26.0.0", "The release runtime floor must remain explicit");
  for (const required of ["dist", "docs", "CHANGELOG.md", "LICENSE", "SECURITY.md", "README.md"]) {
    assert.ok(manifest.files?.includes(required), `package.json files must include ${required}`);
  }

  assert.equal(platformPolicy.schemaVersion, 1, "Unsupported platform policy schema");
  assert.equal(platformPolicy.packaging, "npm-and-standalone");
  assert.deepEqual(platformPolicy.nodeRuntime, {
    version: "24.15.0",
    source: "official-node-distribution",
  }, "Standalone releases must pin the official Node runtime");
  assert.deepEqual(platformPolicy.targets, EXPECTED_TARGETS, "Release targets must cover the declared x64/arm64 matrix");
  const targetKeys = platformPolicy.targets.map((target) => `${target.platform}/${target.arch}`);
  assert.equal(new Set(targetKeys).size, targetKeys.length, "Release targets must be unique");
  assert.equal(nativeTargets.schemaVersion, 1, "Unsupported native target manifest schema");
  assert.ok(Array.isArray(nativeTargets.targets), "Native target manifest must contain targets");
  assert.equal(nativeTargets.targets.length, 4, "Native target manifest must contain four targets");
  const nativeTargetKeys = nativeTargets.targets.map((target) => `${target.platform}/${target.arch}`);
  assert.equal(new Set(nativeTargetKeys).size, nativeTargetKeys.length, "Native targets must be unique");
  for (const target of nativeTargets.targets) {
    assert.ok(
      platformPolicy.targets.some((candidate) => candidate.platform === target.platform && candidate.arch === target.arch),
      `Native target ${target.platform}/${target.arch} is outside the release matrix`,
    );
    assert.match(target.output, /^native\/(?:darwin|win32)\/prebuilds\/(?:darwin|win32)-(?:arm64|x64)\/[\w-]+\.node$/u);
  }

  const productContents = new Map();
  for (const path of REQUIRED_PRODUCT_FILES) productContents.set(path, await readText(productRoot, path));
  const repositoryContents = new Map();
  for (const path of REQUIRED_REPOSITORY_FILES) repositoryContents.set(path, await readText(repositoryRoot, path));
  assert.equal(productContents.get("LICENSE"), repositoryContents.get("LICENSE"), "Package LICENSE must match the repository license");
  assert.equal(productContents.get("SECURITY.md"), repositoryContents.get("SECURITY.md"), "Package SECURITY.md must match repository policy");
  const publicApi = productContents.get("docs/public-api.md");
  for (const subpath of subpathPolicy.subpaths) {
    const display = subpath === "." ? "rigyn" : `rigyn/${subpath.slice(2)}`;
    assert.ok(publicApi.includes(display), `docs/public-api.md must list ${display}`);
  }
  assert.match(repositoryContents.get("SECURITY.md"), /private vulnerability-reporting/iu);
  assert.match(repositoryContents.get("CONTRIBUTING.md"), /npm run check/u);
  assert.match(repositoryContents.get("LICENSE"), /^MIT License$/mu);
  assert.match(repositoryContents.get("CODE_OF_CONDUCT.md"), /Report conduct concerns privately/u);
  assert.match(productContents.get("docs/install.md"), /## Windows/u);
  assert.match(productContents.get("docs/install.md"), /## Termux/u);
  assert.match(productContents.get("docs/install.md"), /## tmux/u);
  assert.match(productContents.get("docs/releasing.md"), /standalone runtime archive/u);
  assert.match(productContents.get("docs/releasing.md"), /versioned source archive/u);

  for (const path of [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ]) validateIssueTemplate(path, parseYaml(repositoryContents.get(path)));

  const ciWorkflow = await readText(repositoryRoot, ".github/workflows/ci.yml");
  const ciCheck = parseYaml(ciWorkflow)?.jobs?.check;
  const ciCheckText = JSON.stringify(ciCheck);
  assert.ok(
    ciCheckText.includes("npm run native:build --workspace @rigyn/terminal"),
    "ci.yml check must build the matching native helper before verification",
  );
  assert.ok(
    ciCheckText.includes("TheMrMilchmann/setup-msvc-dev@79dac248aac9d0059f86eae9d8b5bfab4e95e97c"),
    "ci.yml Windows check must initialize the native compiler with a pinned action",
  );
  const releaseWorkflow = await readText(repositoryRoot, ".github/workflows/release.yml");
  for (const target of EXPECTED_TARGETS) assert.ok(releaseWorkflow.includes(target.runner), `release.yml must use ${target.runner}`);
  const releaseDocument = parseYaml(releaseWorkflow);
  const releaseGuards = releaseDocument?.jobs?.["regression-guards"];
  const releaseGuardCommands = new Set(
    (releaseGuards?.steps ?? []).map((step) => step?.run).filter((command) => typeof command === "string"),
  );
  for (const command of ["npm run test:coverage:risk", "npm run benchmark:runtime"]) {
    assert.ok(releaseGuardCommands.has(command), `release.yml regression-guards must run ${command}`);
  }
  const nativeBuild = releaseDocument?.jobs?.["native-build"];
  const nativeMatrix = nativeBuild?.strategy?.matrix?.include;
  assert.ok(Array.isArray(nativeMatrix), "release.yml native-build must use an explicit target matrix");
  assert.deepEqual(
    nativeMatrix.map(({ platform, arch, runner, output }) => ({ platform, arch, runner, output })),
    nativeTargets.targets.map((target) => ({
      platform: target.platform,
      arch: target.arch,
      runner: platformPolicy.targets.find((candidate) =>
        candidate.platform === target.platform && candidate.arch === target.arch)?.runner,
      output: target.output,
    })),
    "release.yml native-build matrix must match native/targets.json",
  );
  const standaloneBuild = releaseDocument?.jobs?.["standalone-build"];
  const standaloneMatrix = standaloneBuild?.strategy?.matrix?.include;
  assert.ok(Array.isArray(standaloneMatrix), "release.yml standalone-build must use an explicit target matrix");
  assert.deepEqual(standaloneMatrix, EXPECTED_TARGETS, "release.yml standalone-build matrix must match release/platforms.json");
  const standaloneBuildText = JSON.stringify(standaloneBuild);
  for (const fragment of [
    '"node-version":"24.15.0"',
    "npm run release:standalone -- --directory .release --output .standalone",
    "rigyn-standalone-${{ matrix.platform }}-${{ matrix.arch }}",
  ]) assert.ok(standaloneBuildText.includes(fragment), `release.yml standalone-build must contain ${fragment}`);
  const standaloneUpload = standaloneBuild?.steps?.find((step) => step?.name === "Upload standalone archive");
  assert.equal(
    standaloneUpload?.with?.["include-hidden-files"],
    true,
    "release.yml must preserve archives written beneath the hidden standalone directory",
  );
  assert.deepEqual(
    releaseDocument?.jobs?.finalize?.needs,
    ["stage", "standalone-build"],
    "release finalization must wait for npm staging and every standalone build",
  );
  const finalizeText = JSON.stringify(releaseDocument?.jobs?.finalize);
  for (const fragment of [
    '"pattern":"rigyn-standalone-*"',
    '"merge-multiple":true',
    "npm run release:finalize -- --directory .release --standalone-directory .standalone",
  ]) assert.ok(finalizeText.includes(fragment), `release.yml finalize must contain ${fragment}`);
  assert.equal(releaseDocument?.jobs?.verify?.needs, "finalize", "release verification must use finalized artifacts");
  const sourceBuildStep = releaseDocument?.jobs?.verify?.steps?.find((step) =>
    step?.name === "Extract and build the release source archive");
  assert.equal(sourceBuildStep?.if, "matrix.platform == 'linux' && matrix.arch == 'x64'",
    "release source verification must run on exactly one Linux target");
  assert.equal(sourceBuildStep?.run, "node scripts/verify-source-archive.mjs --directory .release --build",
    "release source verification must extract and build the staged archive");
  for (const target of nativeMatrix.filter(({ platform }) => platform === "win32")) {
    assert.equal(target.msvc_arch, target.arch, `Windows native compiler architecture must match ${target.arch}`);
  }
  const nativeBuildText = JSON.stringify(nativeBuild);
  for (const fragment of [
    "TheMrMilchmann/setup-msvc-dev@79dac248aac9d0059f86eae9d8b5bfab4e95e97c",
    "npm run native:build --workspace @rigyn/terminal",
    "npm run native:verify --workspace @rigyn/terminal",
    "rigyn-native-${{ matrix.platform }}-${{ matrix.arch }}",
  ]) assert.ok(nativeBuildText.includes(fragment), `release.yml native-build must contain ${fragment}`);
  assert.deepEqual(
    releaseDocument?.jobs?.stage?.needs,
    ["regression-guards", "native-build"],
    "release staging must wait for regression guards and every native build",
  );
  const stageCommands = new Set(
    (releaseDocument?.jobs?.stage?.steps ?? []).map((step) => step?.run).filter((command) => typeof command === "string"),
  );
  for (const command of [
    "npm run native:verify --workspace @rigyn/terminal -- --release",
    "npm run check",
    "npm run build",
    'npm run release:stage -- --output .release --source-ref "$GITHUB_SHA"',
  ]) {
    assert.ok(stageCommands.has(command), `release.yml stage must run ${command}`);
  }
  const stageSteps = releaseDocument?.jobs?.stage?.steps ?? [];
  for (const target of nativeTargets.targets) {
    const key = `${target.platform}-${target.arch}`;
    const download = stageSteps.find((step) => step?.name === `Download ${key} native helper`);
    assert.equal(download?.with?.name, `rigyn-native-${key}`, `release.yml must download the ${key} native helper`);
    assert.equal(
      download?.with?.path,
      `packages/terminal/${target.output.slice(0, target.output.lastIndexOf("/"))}`,
      `release.yml must collect the ${key} helper at its declared package path`,
    );
  }
  const stagedUpload = releaseDocument?.jobs?.stage?.steps?.find((step) => step?.name === "Upload staged release");
  assert.equal(
    stagedUpload?.with?.["include-hidden-files"],
    true,
    "release.yml must preserve the hidden staged-release ownership marker",
  );
  for (const fragment of [
    "npm run release:stage",
    "scripts/verify-source-archive.mjs",
    "scripts/verify-release-artifact.mjs",
    "SHA256SUMS",
    "RELEASE_NOTES.md",
    "manifest.archives",
    "*.tar.gz",
    'gh release view "$GITHUB_REF_NAME" --json isDraft --jq .isDraft',
    "npm publish",
    "--provenance",
  ]) assert.ok(releaseWorkflow.includes(fragment), `release.yml must contain ${fragment}`);
  assert.ok(
    !releaseWorkflow.includes('releases/tags/$GITHUB_REF_NAME'),
    "release.yml must not use the published-tag endpoint to inspect draft releases",
  );
  const actionCount = await checkActionPins(repositoryRoot);

  return {
    version: manifest.version,
    releaseDate: release.date,
    releaseBody: release.body,
    subpathCount: subpathPolicy.subpaths.length,
    targetCount: platformPolicy.targets.length,
    nativeTargetCount: nativeTargets.targets.length,
    actionCount,
    packageCount: RIGYN_PACKAGE_GRAPH.length,
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkReleaseMetadata();
    writeFileSync(1,
      `Release metadata policy passed for ${result.version}: ${result.packageCount} packages, ${result.subpathCount} public subpaths, ${result.targetCount} platform targets, ${result.nativeTargetCount} native artifacts, ${result.actionCount} pinned action uses.\n`,
    );
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
