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
  "docs/cli-reference.md",
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
const ATTEST_ACTION = "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6";
const NODE_ENGINE = ">=26.7.0";
const NODE_RUNTIME = "26.7.0";

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
  let checkoutCount = 0;
  let nodeSetupCount = 0;
  for (const workflow of workflows) {
    const contents = await readText(root, `.github/workflows/${workflow}`);
    const document = parseYaml(contents);
    for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.uses !== "string") continue;
        if (step.uses.startsWith("actions/checkout@")) {
          checkoutCount += 1;
          assert.equal(
            step.with?.["persist-credentials"],
            false,
            `${workflow} ${jobName} checkout must disable persisted credentials`,
          );
        }
        if (step.uses.startsWith("actions/setup-node@")) {
          nodeSetupCount += 1;
          const configured = step.with?.["node-version"];
          if (configured === NODE_RUNTIME) continue;
          assert.equal(configured, "${{ matrix.node }}",
            `${workflow} ${jobName} must use Node ${NODE_RUNTIME}`);
          const matrix = job?.strategy?.matrix;
          const versions = [
            ...(Array.isArray(matrix?.node) ? matrix.node : []),
            ...(Array.isArray(matrix?.include)
              ? matrix.include.map((entry) => entry?.node).filter((version) => version !== undefined)
              : []),
          ];
          assert.ok(versions.length > 0, `${workflow} ${jobName} must declare its Node matrix`);
          assert.equal(versions.every((version) => version === NODE_RUNTIME), true,
            `${workflow} ${jobName} must use only Node ${NODE_RUNTIME}`);
        }
      }
    }
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
  assert.ok(checkoutCount > 0, "No GitHub checkout actions were checked");
  assert.ok(nodeSetupCount > 0, "No GitHub Node setup actions were checked");
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
  const [rootManifest, packageManifests, workspaceManifests, lockfile, changelog, subpathPolicy, platformPolicy, nativeTargets, kernelNativeTargets] = await Promise.all([
    readJson(repositoryRoot, "package.json"),
    Promise.all(RIGYN_PACKAGE_GRAPH.map(async ({ directory }) => await readJson(repositoryRoot, `${directory}/package.json`))),
    Promise.all(workspaceDirectories.map(async (directory) => await readJson(repositoryRoot, `${directory}/package.json`))),
    readJson(repositoryRoot, "package-lock.json"),
    readText(productRoot, "CHANGELOG.md"),
    readJson(productRoot, "release/public-subpaths.json"),
    readJson(productRoot, "release/platforms.json"),
    readJson(repositoryRoot, "packages/terminal/native/targets.json"),
    readJson(repositoryRoot, "packages/kernel/native/targets.json"),
  ]);
  const manifests = new Map(packageManifests.map((manifest) => [manifest.name, manifest]));
  const manifest = manifests.get("rigyn");

  assert.equal(manifests.size, RIGYN_PACKAGE_GRAPH.length, "Release package names must be unique");
  assert.deepEqual(
    [...manifests.keys()].sort(),
    workspaceManifests
      .map((workspaceManifest) => workspaceManifest.name)
      .sort(),
    "Release graph must contain every workspace package",
  );
  assert.ok(manifest, "packages/rigyn/package.json must declare rigyn");
  const productTestCommand = manifest.scripts?.test?.split(/\s+/u) ?? [];
  assert.ok(productTestCommand.includes("test/*.test.ts"), "The product test command must include root test files");
  assert.ok(productTestCommand.includes("test/**/*.test.ts"), "The product test command must include nested test files");
  assert.ok(
    manifest.scripts?.["test:release"]?.includes("test/release/test-home-isolation.test.mjs"),
    "The release test command must include the user-home isolation suite",
  );
  assertRootLockIdentity(lockfile, rootManifest, manifest.version);
  const runtimeEngine = NODE_ENGINE;
  assert.equal(rootManifest.engines?.node, runtimeEngine, "The workspace Node policy must remain explicit");
  assert.match(manifest.devDependencies?.["@types/node"] ?? "", VERSION_PATTERN, "rigyn must pin @types/node exactly");
  for (const { name, directory } of RIGYN_PACKAGE_GRAPH) {
    const packageManifest = manifests.get(name);
    assert.ok(packageManifest, `${directory}/package.json must declare ${name}`);
    assert.equal(packageManifest.version, manifest.version, `${name} version must match rigyn`);
    assertWorkspaceLockIdentity(lockfile, { name, directory });
    assert.equal(lockfile.packages?.[directory]?.version, packageManifest.version, `package-lock ${directory} version must match package.json`);
    assert.equal(packageManifest.license, "MIT", `${name} must declare the MIT license`);
    assert.equal(packageManifest.private, true, `${name} release archives must be registry-private`);
    assert.equal(packageManifest.publishConfig, undefined, `${name} must not declare registry publication settings`);
    assert.equal(packageManifest.engines?.node, runtimeEngine, `${name} must use the workspace Node policy`);
    assert.equal(
      lockfile.packages?.[directory]?.engines?.node,
      runtimeEngine,
      `package-lock ${directory} must use the workspace Node policy`,
    );
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
  assert.equal(manifest.homepage, "https://github.com/rigyn/rigyn#readme", "package.json homepage must target the public repository");
  assert.deepEqual(manifest.bugs, { url: "https://github.com/rigyn/rigyn/issues" }, "package.json bugs URL must target the public repository");
  assert.deepEqual(
    manifest.repository,
    { type: "git", url: "git+https://github.com/rigyn/rigyn.git", directory: "packages/rigyn" },
    "package.json repository must target the public repository",
  );
  assert.equal(manifest.private, true, "The rigyn release archive must be registry-private");
  assert.equal(manifest.publishConfig, undefined, "rigyn must not declare registry publication settings");
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
  assert.equal(subpathPolicy.runtime, runtimeEngine);
  assert.equal(subpathPolicy.module, "esm");
  assert.ok(Array.isArray(subpathPolicy.subpaths));
  assert.equal(new Set(subpathPolicy.subpaths).size, subpathPolicy.subpaths.length, "Public subpaths must be unique");
  assert.deepEqual(Object.keys(manifest.exports ?? {}), subpathPolicy.subpaths, "package exports must match public-subpaths.json exactly");
  for (const subpath of subpathPolicy.subpaths) {
    assert.deepEqual(manifest.exports[subpath], expectedExport(subpath), `Unexpected export mapping for ${subpath}`);
  }
  assert.equal(manifest.type, "module", "Packaged JavaScript must remain ESM");
  assert.equal(manifest.engines?.node, runtimeEngine, "The release runtime floor must remain explicit");
  for (const required of ["dist", "docs", "CHANGELOG.md", "LICENSE", "SECURITY.md", "README.md"]) {
    assert.ok(manifest.files?.includes(required), `package.json files must include ${required}`);
  }

  assert.equal(platformPolicy.schemaVersion, 1, "Unsupported platform policy schema");
  assert.equal(platformPolicy.packaging, "github-release");
  assert.deepEqual(platformPolicy.nodeRuntime, {
    version: NODE_RUNTIME,
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
  const nativeArtifactOutputs = [];
  for (const target of nativeTargets.targets) {
    assert.ok(
      platformPolicy.targets.some((candidate) => candidate.platform === target.platform && candidate.arch === target.arch),
      `Native target ${target.platform}/${target.arch} is outside the release matrix`,
    );
    assert.match(target.output, /^native\/(?:darwin|win32)\/prebuilds\/(?:darwin|win32)-(?:arm64|x64)\/[\w-]+\.node$/u);
    nativeArtifactOutputs.push(target.output);
    if (target.platform === "darwin") {
      assert.deepEqual(target.keychain, {
        source: "native/darwin/src/rigyn-keychain-helper.swift",
        output: `native/darwin/prebuilds/darwin-${target.arch}/rigyn-keychain-helper`,
      }, `Darwin target ${target.arch} must package the fixed keychain helper`);
      nativeArtifactOutputs.push(target.keychain.output);
    } else {
      assert.equal(target.keychain, undefined, `Non-Darwin target ${target.arch} must not declare a keychain helper`);
    }
  }
  assert.equal(new Set(nativeArtifactOutputs).size, nativeArtifactOutputs.length, "Native artifact outputs must be unique");
  assert.equal(kernelNativeTargets.schemaVersion, 1, "Unsupported kernel native target manifest schema");
  assert.equal(kernelNativeTargets.targets?.length, 2, "Kernel native target manifest must contain two targets");
  const kernelNativeTargetKeys = kernelNativeTargets.targets.map((target) => `${target.platform}/${target.arch}`);
  assert.deepEqual(kernelNativeTargetKeys, ["win32/x64", "win32/arm64"], "Kernel native targets must cover Windows x64 and arm64");
  const kernelNativeArtifactOutputs = [];
  for (const target of kernelNativeTargets.targets) {
    assert.equal(target.source, "native/win32/src/rigyn-job-launcher.c");
    assert.equal(target.output, `native/win32/prebuilds/win32-${target.arch}/rigyn-job-launcher.exe`);
    kernelNativeArtifactOutputs.push(target.output);
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
  assert.ok(
    productContents.get("docs/cli-reference.md").includes("`config path [--scope user\\|project] [--json]`"),
    "docs/cli-reference.md must document structured config-path output",
  );
  assert.match(productContents.get("docs/releasing.md"), /standalone runtime archive/u);
  assert.match(productContents.get("docs/releasing.md"), /versioned source archive/u);
  const installerTag = `v${manifest.version}`;
  const installCommands = [
    `https://raw.githubusercontent.com/rigyn/rigyn/${installerTag}/install.sh`,
    `https://raw.githubusercontent.com/rigyn/rigyn/${installerTag}/install.ps1`,
  ];
  for (const [root, path] of [
    [repositoryRoot, "README.md"],
    [productRoot, "README.md"],
    [productRoot, "docs/getting-started.md"],
    [productRoot, "docs/install.md"],
  ]) {
    const contents = await readText(root, path);
    for (const command of installCommands) {
      assert.ok(contents.includes(command), `${path} must pin the installer bootstrap to ${installerTag}`);
    }
    assert.ok(
      !/raw\.githubusercontent\.com\/rigyn\/rigyn\/(?:main|master)\/install\.(?:sh|ps1)/u.test(contents),
      `${path} must not execute an installer bootstrap from a mutable branch`,
    );
  }

  for (const path of [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ]) validateIssueTemplate(path, parseYaml(repositoryContents.get(path)));

  const ciWorkflow = await readText(repositoryRoot, ".github/workflows/ci.yml");
  const ciDocument = parseYaml(ciWorkflow);
  const ciCheck = ciDocument?.jobs?.check;
  const ciCheckText = JSON.stringify(ciCheck);
  assert.deepEqual(ciCheck?.strategy?.matrix?.node, [NODE_RUNTIME],
    "ci.yml must test only the exact supported Node runtime");
  assert.equal(ciCheck?.strategy?.matrix?.include, undefined,
    "ci.yml must not retain a second Node runtime lane");
  assert.ok(
    ciCheckText.includes("npm run native:build --workspace @rigyn/terminal"),
    "ci.yml check must build the matching native helper before verification",
  );
  assert.ok(
    ciCheckText.includes("npm run native:build --workspace @rigyn/kernel"),
    "ci.yml Windows check must build the kernel process launcher before verification",
  );
  assert.ok(
    ciCheckText.includes("TheMrMilchmann/setup-msvc-dev@368ef7d1ee4d1171b31d4a7f67f4d954f903f5a9"),
    "ci.yml Windows check must initialize the native compiler with a pinned action",
  );
  const securityWorkflow = parseYaml(await readText(repositoryRoot, ".github/workflows/security.yml"));
  const securityCommands = new Set(
    (securityWorkflow?.jobs?.dependencies?.steps ?? [])
      .map((step) => step?.run)
      .filter((command) => typeof command === "string"),
  );
  assert.ok(
    securityCommands.has("npm audit --omit=dev --audit-level=moderate"),
    "security.yml must fail on moderate production dependency vulnerabilities",
  );
  const releaseWorkflow = await readText(repositoryRoot, ".github/workflows/release.yml");
  for (const target of EXPECTED_TARGETS) assert.ok(releaseWorkflow.includes(target.runner), `release.yml must use ${target.runner}`);
  const releaseDocument = parseYaml(releaseWorkflow);
  const releaseGuards = releaseDocument?.jobs?.["regression-guards"];
  const releaseGuardCommands = new Set(
    (releaseGuards?.steps ?? []).map((step) => step?.run).filter((command) => typeof command === "string"),
  );
  for (const command of [
    "npm audit --audit-level=moderate",
    "npm audit --omit=dev --audit-level=moderate",
    "npm audit signatures",
    "npm run test:coverage:risk",
    "npm run benchmark:runtime",
  ]) {
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
    `"node-version":"${NODE_RUNTIME}"`,
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
    "release finalization must wait for package staging and every standalone build",
  );
  const finalizeText = JSON.stringify(releaseDocument?.jobs?.finalize);
  for (const fragment of [
    '"pattern":"rigyn-standalone-*"',
    '"merge-multiple":true',
    "npm run release:finalize -- --directory .release --standalone-directory .standalone",
  ]) assert.ok(finalizeText.includes(fragment), `release.yml finalize must contain ${fragment}`);
  const sbomStep = releaseDocument?.jobs?.finalize?.steps?.find((step) => step?.name === "Generate SPDX 2.3 SBOM");
  assert.equal(sbomStep?.shell, "bash", "release.yml must generate the SBOM in a fail-closed shell step");
  assert.ok(
    sbomStep?.run?.includes("npm sbom --sbom-format spdx --package-lock-only"),
    "release.yml must generate its SPDX SBOM from package-lock.json",
  );
  assert.ok(
    sbomStep?.run?.includes('.release/rigyn-v${version}.spdx.json'),
    "release.yml must write the versioned SPDX SBOM into the finalized release",
  );
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
    "TheMrMilchmann/setup-msvc-dev@368ef7d1ee4d1171b31d4a7f67f4d954f903f5a9",
    "npm run native:build --workspace @rigyn/terminal",
    "npm run native:verify --workspace @rigyn/terminal",
    "rigyn-native-${{ matrix.platform }}-${{ matrix.arch }}",
    "npm run native:build --workspace @rigyn/kernel",
    "npm run native:verify --workspace @rigyn/kernel",
    "rigyn-kernel-native-${{ matrix.platform }}-${{ matrix.arch }}",
  ]) assert.ok(nativeBuildText.includes(fragment), `release.yml native-build must contain ${fragment}`);
  const nativeUpload = nativeBuild?.steps?.find((step) => step?.name === "Upload native helper");
  assert.equal(
    nativeUpload?.with?.path,
    "packages/terminal/native/${{ matrix.platform }}/prebuilds/${{ matrix.platform }}-${{ matrix.arch }}",
    "release.yml must upload every native artifact for the selected target",
  );
  const kernelNativeUpload = nativeBuild?.steps?.find((step) => step?.name === "Upload kernel process launcher");
  assert.equal(
    kernelNativeUpload?.with?.path,
    "packages/kernel/native/win32/prebuilds/${{ matrix.platform }}-${{ matrix.arch }}",
    "release.yml must upload each kernel process launcher",
  );
  const platformChecks = releaseDocument?.jobs?.["platform-checks"];
  assert.deepEqual(
    platformChecks?.strategy?.matrix?.include,
    [
      { os: "macos-latest", node: NODE_RUNTIME },
      { os: "windows-latest", node: NODE_RUNTIME },
    ],
    "release.yml platform-checks must cover the full-suite matrix not already covered by staging",
  );
  assert.equal(platformChecks?.env?.RIGYN_REQUIRE_PROCESS_TESTS, "1",
    "release.yml platform-checks must require process-level tests");
  const platformCheckText = JSON.stringify(platformChecks);
  for (const fragment of [
    '"node-version":"${{ matrix.node }}"',
    "TheMrMilchmann/setup-msvc-dev@368ef7d1ee4d1171b31d4a7f67f4d954f903f5a9",
    "npm run native:build --workspace @rigyn/terminal",
    "npm run native:build --workspace @rigyn/kernel",
    "npm run check",
  ]) assert.ok(platformCheckText.includes(fragment), `release.yml platform-checks must contain ${fragment}`);
  const stage = releaseDocument?.jobs?.stage;
  assert.equal(stage?.["runs-on"], "ubuntu-24.04",
    "release staging must supply the Linux full-check platform leg");
  assert.equal(stage?.env?.RIGYN_REQUIRE_PROCESS_TESTS, "1",
    "release staging must require process-level tests");
  const stageNodeSetup = stage?.steps?.find((step) =>
    step?.uses === "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
  assert.equal(stageNodeSetup?.with?.["node-version"], NODE_RUNTIME,
    "release staging must use the exact minimum Node runtime");
  assert.deepEqual(
    stage?.needs,
    ["regression-guards", "native-build", "platform-checks"],
    "release staging must wait for regression guards, every native build, and every additional platform check",
  );
  const stageCommands = new Set(
    (stage?.steps ?? []).map((step) => step?.run).filter((command) => typeof command === "string"),
  );
  for (const command of [
    "npm run native:verify --workspace @rigyn/terminal -- --release",
    "npm run native:verify --workspace @rigyn/kernel -- --release",
    "npm run check",
    "npm run build",
    'npm run release:stage -- --output .release --source-ref "$GITHUB_SHA"',
  ]) {
    assert.ok(stageCommands.has(command), `release.yml stage must run ${command}`);
  }
  assert.ok(
    stageCommands.has("chmod 0755 packages/terminal/native/darwin/prebuilds/darwin-x64/rigyn-keychain-helper packages/terminal/native/darwin/prebuilds/darwin-arm64/rigyn-keychain-helper"),
    "release.yml stage must restore executable modes lost by artifact transfer",
  );
  const stageSteps = stage?.steps ?? [];
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
  for (const target of kernelNativeTargets.targets) {
    const key = `${target.platform}-${target.arch}`;
    const download = stageSteps.find((step) => step?.name === `Download ${key} kernel process launcher`);
    assert.equal(download?.with?.name, `rigyn-kernel-native-${key}`, `release.yml must download the ${key} kernel process launcher`);
    assert.equal(
      download?.with?.path,
      `packages/kernel/${target.output.slice(0, target.output.lastIndexOf("/"))}`,
      `release.yml must collect the ${key} kernel process launcher at its declared package path`,
    );
  }
  const stagedUpload = stage?.steps?.find((step) => step?.name === "Upload staged release");
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
    "*.tgz",
    "*.tar.gz",
    "*.spdx.json",
    'gh release view "$GITHUB_REF_NAME" --json isDraft,assets',
    'gh api --method DELETE "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}"',
    "GitHub draft asset inventory mismatch",
    'gh release upload "$GITHUB_REF_NAME"',
    'gh release edit "$GITHUB_REF_NAME" --draft=false --latest',
  ]) assert.ok(releaseWorkflow.includes(fragment), `release.yml must contain ${fragment}`);
  for (const fragment of ["NPM_PUBLISH_ENABLED", "registry.npmjs.org", "npm publish", "npm view", "--provenance"]) {
    assert.ok(!releaseWorkflow.includes(fragment), `release.yml must not contain ${fragment}`);
  }
  assert.deepEqual(
    releaseDocument?.jobs?.publish?.permissions,
    {
      "id-token": "write",
      attestations: "write",
      "artifact-metadata": "write",
      contents: "write",
    },
    "GitHub-only publication must request exactly the release and attestation authorities",
  );
  assert.deepEqual(releaseDocument?.permissions, { contents: "read" },
    "Non-publishing release jobs must retain read-only repository contents");
  for (const [name, job] of Object.entries(releaseDocument?.jobs ?? {})) {
    if (name !== "publish") assert.equal(job?.permissions, undefined, `${name} must not elevate workflow permissions`);
  }
  const publishSteps = releaseDocument?.jobs?.publish?.steps ?? [];
  const draftReleaseStep = publishSteps.find((step) => step?.name === "Create or update draft release");
  const draftReleaseRun = draftReleaseStep?.run ?? "";
  for (const fragment of [
    '--json isDraft,assets',
    'gh api --method DELETE "/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}"',
    'gh release upload "$GITHUB_REF_NAME"',
    "GitHub draft asset inventory mismatch",
  ]) assert.ok(draftReleaseRun.includes(fragment), `release draft reconciliation must contain ${fragment}`);
  assert.ok(
    draftReleaseRun.indexOf("gh api --method DELETE") < draftReleaseRun.indexOf("gh release upload"),
    "release draft reconciliation must remove previous assets before uploading the verified inventory",
  );
  assert.ok(
    draftReleaseRun.indexOf("gh release upload") < draftReleaseRun.indexOf("GitHub draft asset inventory mismatch"),
    "release draft reconciliation must verify the exact uploaded inventory",
  );
  const releaseMetadataStep = publishSteps.find((step) => step?.name === "Verify staged checksum");
  assert.equal(releaseMetadataStep?.id, "release-metadata",
    "release publication must expose the checksum-verified SBOM path");
  assert.ok(releaseMetadataStep?.run?.includes('echo "sbom=.release/$sbom" >> "$GITHUB_OUTPUT"'),
    "release publication must derive the attested SBOM path from the release manifest version");
  assert.ok(releaseMetadataStep?.run?.includes('source="$(node -p "require(\'./release-manifest.json\').source.file")"'),
    "release publication must derive the SBOM subject from the finalized source archive");
  assert.ok(releaseMetadataStep?.run?.includes("SHA256SUMS > SBOM-SUBJECTS"),
    "release publication must select a separate checksum set for the SBOM subject");
  assert.ok(releaseMetadataStep?.run?.includes("$2 == source { print; matches += 1 }"),
    "release publication must select the source checksum by its exact filename field");
  assert.ok(releaseMetadataStep?.run?.includes("if (matches != 1) exit 1"),
    "release publication must reject a missing or duplicate source checksum");
  assert.ok(releaseMetadataStep?.run?.includes(
    'echo "sbom-subjects=.release/SBOM-SUBJECTS" >> "$GITHUB_OUTPUT"',
  ), "release publication must expose the source-only SBOM subject checksums");
  const attestationSteps = publishSteps.filter((step) => step?.uses === ATTEST_ACTION);
  assert.equal(attestationSteps.length, 2,
    "release publication must use the pinned attestation action for provenance and SBOM");
  const provenanceAttestation = attestationSteps.find((step) => step?.name === "Attest release build provenance");
  assert.deepEqual(provenanceAttestation?.with, {
    "subject-checksums": ".release/SHA256SUMS",
  }, "build provenance must attest every SHA256SUMS subject");
  const sbomAttestation = attestationSteps.find((step) => step?.name === "Attest release SBOM");
  assert.deepEqual(sbomAttestation?.with, {
    "subject-checksums": "${{ steps.release-metadata.outputs.sbom-subjects }}",
    "sbom-path": "${{ steps.release-metadata.outputs.sbom }}",
  }, "the workspace SPDX predicate must attest only the matching source archive");
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
    nativeTargetCount: nativeTargets.targets.length + kernelNativeTargets.targets.length,
    nativeArtifactCount: nativeArtifactOutputs.length + kernelNativeArtifactOutputs.length,
    actionCount,
    packageCount: RIGYN_PACKAGE_GRAPH.length,
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkReleaseMetadata();
    writeFileSync(1,
      `Release metadata policy passed for ${result.version}: ${result.packageCount} packages, ${result.subpathCount} public subpaths, ${result.targetCount} platform targets, ${result.nativeArtifactCount} native artifacts across ${result.nativeTargetCount} native targets, ${result.actionCount} pinned action uses.\n`,
    );
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
