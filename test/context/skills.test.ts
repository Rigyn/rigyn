import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { discoverSkillsDetailed } from "../../src/context/index.js";
import { buildSystemPrompt } from "../../src/prompts/system.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function skill(root: string, relativeDirectory: string, manifest: string): string {
  const path = join(root, relativeDirectory);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), manifest);
  return path;
}

function manifest(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`;
}

test("skill metadata uses YAML block scalars and preserves invocation controls", async () => {
  const root = directory("harness-skill-yaml-");
  skill(root, "manual-review", [
    "---",
    "name: manual-review",
    "description: |-",
    "  Reviews a proposed change.",
    "  Use it before merging.",
    "metadata:",
    "  owner: harness-team",
    "  revision: \"7\"",
    "disable-model-invocation: true",
    "---",
    "",
    "# Manual review",
  ].join("\n"));

  const result = await discoverSkillsDetailed([
    { path: root, scope: "user", trusted: true },
  ]);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.description, "Reviews a proposed change.\nUse it before merging.");
  assert.deepEqual(result.skills[0]?.metadata, { owner: "harness-team", revision: "7" });
  assert.equal(result.skills[0]?.disableModelInvocation, true);

  const prompt = buildSystemPrompt({
    workspace: root,
    instructions: { entries: [], totalBytes: 0, truncated: false },
    skills: result.skills,
  });
  assert.doesNotMatch(prompt, /manual-review/u);
});

test("invalid manifests produce structured diagnostics without hiding valid siblings", async () => {
  const root = directory("harness-skill-invalid-");
  skill(root, "good-skill", manifest("good-skill", "A valid sibling."));
  skill(root, "missing-frontmatter", "# Instructions only\n");
  skill(root, "unterminated", "---\nname: unterminated\ndescription: Missing the closing fence.\n");
  skill(root, "invalid-yaml", "---\nname: invalid-yaml\ndescription: [unfinished\n---\n");
  skill(root, "missing-name", "---\ndescription: No name was supplied.\n---\n");
  skill(root, "missing-description", "---\nname: missing-description\n---\n");
  skill(root, "bad--name", manifest("bad--name", "Consecutive hyphens are unsafe."));
  skill(root, "declared-name", manifest("different-name", "The directory does not match."));
  skill(root, "bad-metadata", "---\nname: bad-metadata\ndescription: Metadata values must remain strings.\nmetadata:\n  revision: 7\n---\n");
  skill(root, "unsafe-manual", "---\nname: unsafe-manual\ndescription: A mistyped invocation policy must fail closed.\ndisable-model-invocation: \"true\"\n---\n");

  const result = await discoverSkillsDetailed([
    { path: root, scope: "workspace", trusted: false },
  ]);

  assert.deepEqual(result.skills.map((entry) => entry.name), ["bad--name", "different-name", "good-skill"]);
  assert.deepEqual(
    new Set(result.diagnostics.map((entry) => entry.code)),
    new Set([
      "SKILL_FRONTMATTER_MISSING",
      "SKILL_FRONTMATTER_UNTERMINATED",
      "SKILL_FRONTMATTER_INVALID",
      "SKILL_NAME_REQUIRED",
      "SKILL_DESCRIPTION_REQUIRED",
      "SKILL_FIELD_INVALID",
      "SKILL_METADATA_INVALID",
      "SKILL_NAME_INVALID",
      "SKILL_NAME_MISMATCH",
    ]),
  );
  assert.ok(result.diagnostics.every((entry) => entry.path.endsWith("SKILL.md")));
  assert.equal(result.diagnostics.find((entry) => entry.code === "SKILL_NAME_INVALID")?.severity, "warning");
});

test("skill validation rejects every unsafe name form and reports unknown fields", async () => {
  const root = directory("harness-skill-names-");
  for (const name of ["Uppercase", "under_score", "-leading", "trailing-", "two--hyphens", "x".repeat(65)]) {
    skill(root, name, manifest(name, `Invalid name ${name}.`));
  }
  skill(root, "known-skill", [
    "---",
    "name: known-skill",
    "description: A valid skill with an extension field.",
    "author: local-team",
    "---",
  ].join("\n"));

  const result = await discoverSkillsDetailed([
    { path: root, scope: "user", trusted: true },
  ]);

  assert.deepEqual(result.skills.map((entry) => entry.name), [
    "-leading",
    "Uppercase",
    "known-skill",
    "trailing-",
    "two--hyphens",
    "under_score",
    "x".repeat(65),
  ]);
  assert.equal(result.diagnostics.filter((entry) => entry.code === "SKILL_NAME_INVALID").length, 6);
  assert.ok(result.diagnostics.filter((entry) => entry.code === "SKILL_NAME_INVALID").every((entry) => entry.severity === "warning"));
  const unknown = result.diagnostics.find((entry) => entry.code === "SKILL_UNKNOWN_FIELD");
  assert.equal(unknown?.field, "author");
  assert.equal(unknown?.severity, "warning");
});

test("root manifests stop recursion while manifest-free directories are searched deterministically", async () => {
  const root = directory("harness-skill-recursive-");
  skill(root, "owned", manifest("owned", "The directory owner."));
  skill(root, join("owned", "ignored-child"), manifest("ignored-child", "Must not be discovered."));
  skill(root, join("group", "nested-skill"), manifest("nested-skill", "A nested skill."));

  const result = await discoverSkillsDetailed([
    { path: root, scope: "workspace", trusted: true },
  ]);

  assert.deepEqual(result.skills.map((entry) => entry.name), ["nested-skill", "owned"]);
  assert.equal(result.diagnostics.length, 0);
});

test("native skill roots discover direct Markdown skills while compatibility roots can opt out", async () => {
  const root = directory("harness-skill-root-markdown-");
  writeFileSync(join(root, "review.md"), manifest("review", "A direct Markdown skill."));
  skill(root, join("nested", "helper"), manifest("helper", "A nested directory skill."));

  const native = await discoverSkillsDetailed([
    { path: root, scope: "user", trusted: true },
  ]);
  assert.deepEqual(native.skills.map((entry) => entry.name), ["helper", "review"]);

  const compatibility = await discoverSkillsDetailed([
    { path: root, scope: "user", trusted: true, rootMarkdown: false },
  ]);
  assert.deepEqual(compatibility.skills.map((entry) => entry.name), ["helper"]);
});

test("recursive skill discovery applies layered ignore files and nested negation", async () => {
  const root = directory("harness-skill-ignore-");
  skill(root, "visible", manifest("visible", "A visible skill."));
  skill(root, "git-drop", manifest("git-drop", "Ignored by gitignore."));
  skill(root, "ignore-drop", manifest("ignore-drop", "Ignored by ignore."));
  skill(root, "fd-drop", manifest("fd-drop", "Ignored by fdignore."));
  skill(root, "restored", manifest("restored", "Restored by a later ignore file."));
  skill(root, join("group", "drop"), manifest("drop", "Ignored below a group."));
  skill(root, join("group", "keep"), manifest("keep", "Restored by a nested negation."));
  skill(root, join("container", "nested"), manifest("nested", "Found below an ignored root manifest."));
  writeFileSync(join(root, ".gitignore"), [
    "git-drop/",
    "restored/",
    "group/*",
    "",
  ].join("\n"));
  writeFileSync(join(root, ".ignore"), "ignore-drop/\n!restored/\n!restored/**\n");
  writeFileSync(join(root, ".fdignore"), "fd-drop/\n");
  writeFileSync(join(root, "group", ".ignore"), "!keep/\n!keep/**\n");
  writeFileSync(join(root, "container", "SKILL.md"), manifest("container", "Its manifest is ignored."));
  writeFileSync(join(root, "container", ".gitignore"), "/SKILL.md\n");

  const first = await discoverSkillsDetailed([{ path: root, scope: "workspace", trusted: true }]);
  const second = await discoverSkillsDetailed([{ path: root, scope: "workspace", trusted: true }]);

  assert.deepEqual(first.skills.map((entry) => entry.name), ["keep", "nested", "restored", "visible"]);
  assert.deepEqual(second.skills.map((entry) => entry.manifestPath), first.skills.map((entry) => entry.manifestPath));
  assert.equal(first.diagnostics.length, 0);
});

test("explicit manifests bypass recursive ignores while hidden and dependency directories stay excluded", async () => {
  const root = directory("harness-skill-explicit-");
  const explicit = skill(root, join("ignored", "explicit"), manifest("explicit", "An explicitly selected skill."));
  skill(root, join(".private", "hidden"), manifest("hidden", "Must remain hidden."));
  skill(root, join("node_modules", "dependency"), manifest("dependency", "Must remain excluded."));
  skill(root, "visible", manifest("visible", "A visible skill."));
  writeFileSync(join(root, ".gitignore"), "ignored/\n!.private/\n!node_modules/\n");

  const recursive = await discoverSkillsDetailed([{ path: root, scope: "workspace", trusted: false }]);
  assert.deepEqual(recursive.skills.map((entry) => entry.name), ["visible"]);

  const selected = await discoverSkillsDetailed([{
    path: join(explicit, "SKILL.md"),
    scope: "workspace",
    trusted: false,
  }]);
  assert.deepEqual(selected.skills.map((entry) => entry.name), ["explicit"]);
  assert.equal(selected.skills[0]?.scope, "workspace");
  assert.equal(selected.skills[0]?.trusted, false);
});

test("skill ignore files are bounded and ignore-file symlinks are not followed", async () => {
  const root = directory("harness-skill-ignore-bound-");
  const outside = directory("harness-skill-ignore-outside-");
  skill(root, "visible", manifest("visible", "A visible skill."));
  const outsideRules = join(outside, "rules");
  writeFileSync(outsideRules, "*\n");
  symlinkSync(outsideRules, join(root, ".gitignore"), "file");

  const safe = await discoverSkillsDetailed([{ path: root, scope: "workspace", trusted: true }]);
  assert.deepEqual(safe.skills.map((entry) => entry.name), ["visible"]);

  rmSync(join(root, ".gitignore"));
  writeFileSync(join(root, ".fdignore"), Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(
    discoverSkillsDetailed([{ path: root, scope: "workspace", trusted: true }]),
    /Skill ignore file exceeds 1048576 bytes/u,
  );
});

test("later skill roots win collisions with stable winner and loser diagnostics", async () => {
  const first = directory("harness-skill-first-");
  const second = directory("harness-skill-second-");
  const firstDirectory = skill(first, "calendar", manifest("calendar", "First calendar."));
  const secondDirectory = skill(second, "calendar", manifest("calendar", "Second calendar."));

  const result = await discoverSkillsDetailed([
    { path: first, scope: "user", trusted: true },
    { path: second, scope: "workspace", trusted: false },
  ]);

  assert.equal(result.skills[0]?.description, "Second calendar.");
  assert.equal(result.skills[0]?.scope, "workspace");
  const collision = result.diagnostics.find((entry) => entry.code === "SKILL_COLLISION");
  assert.equal(collision?.winnerPath, join(secondDirectory, "SKILL.md"));
  assert.equal(collision?.loserPath, join(firstDirectory, "SKILL.md"));
  assert.equal(collision?.winnerRootPath, second);
  assert.equal(collision?.loserRootPath, first);
  assert.match(collision?.message ?? "", /later root.*takes precedence/u);

  const reversed = await discoverSkillsDetailed([
    { path: second, scope: "workspace", trusted: false },
    { path: first, scope: "user", trusted: true },
  ]);
  assert.equal(reversed.skills[0]?.description, "First calendar.");
});

test("a truncated frontmatter candidate is isolated from other skills", async () => {
  const root = directory("harness-skill-truncated-");
  skill(root, "first-valid", manifest("first-valid", "A valid skill."));
  skill(root, "large-metadata", [
    "---",
    "name: large-metadata",
    `description: ${"x".repeat(512)}`,
    "---",
  ].join("\n"));

  const result = await discoverSkillsDetailed(
    [{ path: root, scope: "user", trusted: true }],
    { maxMetadataBytes: 128 },
  );

  assert.deepEqual(result.skills.map((entry) => entry.name), ["first-valid"]);
  assert.equal(result.diagnostics.some((entry) => entry.code === "SKILL_FRONTMATTER_TRUNCATED"), true);
});
