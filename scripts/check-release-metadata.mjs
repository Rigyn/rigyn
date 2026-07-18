import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
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
const REQUIRED_FILES = [
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "SECURITY.md",
  "docs/install.md",
  "docs/public-api.md",
  "docs/releasing.md",
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

export async function checkReleaseMetadata(root = PROJECT_ROOT) {
  const projectRoot = resolve(root);
  const [manifest, lockfile, changelog, subpathPolicy, platformPolicy] = await Promise.all([
    readJson(projectRoot, "package.json"),
    readJson(projectRoot, "package-lock.json"),
    readText(projectRoot, "CHANGELOG.md"),
    readJson(projectRoot, "release/public-subpaths.json"),
    readJson(projectRoot, "release/platforms.json"),
  ]);

  assert.equal(typeof manifest.version, "string");
  assert.match(manifest.version, VERSION_PATTERN, "package.json version must be semantic");
  assert.equal(lockfile.version, manifest.version, "package-lock.json version must match package.json");
  assert.equal(lockfile.packages?.[""]?.version, manifest.version, "package-lock root version must match package.json");
  assert.equal(manifest.license, "MIT", "package.json must declare the MIT license");
  assert.equal(lockfile.packages?.[""]?.license, manifest.license, "package-lock root license must match package.json");
  assert.equal(manifest.homepage, "https://github.com/Rigyn/rigyn#readme", "package.json homepage must target the public repository");
  assert.deepEqual(manifest.bugs, { url: "https://github.com/Rigyn/rigyn/issues" }, "package.json bugs URL must target the public repository");
  assert.deepEqual(
    manifest.repository,
    { type: "git", url: "git+https://github.com/Rigyn/rigyn.git" },
    "package.json repository must target the public repository",
  );
  assert.equal(manifest.publishConfig?.access, "public", "npm releases must be explicitly public");
  const versionSource = await readText(projectRoot, "src/version.ts");
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
  assert.equal(platformPolicy.packaging, "node-native-npm");
  assert.deepEqual(platformPolicy.targets, EXPECTED_TARGETS, "Release targets must cover the declared x64/arm64 matrix");
  const targetKeys = platformPolicy.targets.map((target) => `${target.platform}/${target.arch}`);
  assert.equal(new Set(targetKeys).size, targetKeys.length, "Release targets must be unique");

  const requiredContents = new Map();
  for (const path of REQUIRED_FILES) requiredContents.set(path, await readText(projectRoot, path));
  const publicApi = requiredContents.get("docs/public-api.md");
  for (const subpath of subpathPolicy.subpaths) {
    const display = subpath === "." ? "rigyn" : `rigyn/${subpath.slice(2)}`;
    assert.ok(publicApi.includes(display), `docs/public-api.md must list ${display}`);
  }
  assert.match(requiredContents.get("SECURITY.md"), /private vulnerability-reporting/iu);
  assert.match(requiredContents.get("CONTRIBUTING.md"), /npm run check/u);
  assert.match(requiredContents.get("LICENSE"), /^MIT License$/mu);
  assert.match(requiredContents.get("CODE_OF_CONDUCT.md"), /Report conduct concerns privately/u);
  assert.match(requiredContents.get("docs/install.md"), /## Windows/u);
  assert.match(requiredContents.get("docs/install.md"), /## Termux/u);
  assert.match(requiredContents.get("docs/install.md"), /## tmux/u);
  assert.match(requiredContents.get("docs/releasing.md"), /Node-native npm archive/u);

  for (const path of [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ]) validateIssueTemplate(path, parseYaml(requiredContents.get(path)));

  const releaseWorkflow = await readText(projectRoot, ".github/workflows/release.yml");
  for (const target of EXPECTED_TARGETS) assert.ok(releaseWorkflow.includes(target.runner), `release.yml must use ${target.runner}`);
  const releaseDocument = parseYaml(releaseWorkflow);
  const releaseGuards = releaseDocument?.jobs?.["regression-guards"];
  const releaseGuardCommands = new Set(
    (releaseGuards?.steps ?? []).map((step) => step?.run).filter((command) => typeof command === "string"),
  );
  for (const command of ["npm run test:coverage:risk", "npm run benchmark:runtime"]) {
    assert.ok(releaseGuardCommands.has(command), `release.yml regression-guards must run ${command}`);
  }
  assert.equal(
    releaseDocument?.jobs?.stage?.needs,
    "regression-guards",
    "release staging must wait for the regression guards",
  );
  const stagedUpload = releaseDocument?.jobs?.stage?.steps?.find((step) => step?.name === "Upload staged release");
  assert.equal(
    stagedUpload?.with?.["include-hidden-files"],
    true,
    "release.yml must preserve the hidden staged-release ownership marker",
  );
  for (const fragment of [
    "npm run release:stage",
    "scripts/verify-release-artifact.mjs",
    "SHA256SUMS",
    "RELEASE_NOTES.md",
    'gh release view "$GITHUB_REF_NAME" --json isDraft --jq .isDraft',
    "npm publish",
    "--provenance",
  ]) assert.ok(releaseWorkflow.includes(fragment), `release.yml must contain ${fragment}`);
  assert.ok(
    !releaseWorkflow.includes('releases/tags/$GITHUB_REF_NAME'),
    "release.yml must not use the published-tag endpoint to inspect draft releases",
  );
  const actionCount = await checkActionPins(projectRoot);

  return {
    version: manifest.version,
    releaseDate: release.date,
    releaseBody: release.body,
    subpathCount: subpathPolicy.subpaths.length,
    targetCount: platformPolicy.targets.length,
    actionCount,
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkReleaseMetadata();
    writeFileSync(1,
      `Release metadata policy passed for ${result.version}: ${result.subpathCount} public subpaths, ${result.targetCount} platform targets, ${result.actionCount} pinned action uses.\n`,
    );
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
