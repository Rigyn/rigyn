import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatSkillsForPrompt, loadSkills } from "../../src/core/skills.js";

const manifest = (name: string, description: string, disabled = false): string =>
  `---\nname: ${name}\ndescription: ${description}\n${disabled ? "disable-model-invocation: true\n" : ""}---\nInstructions`;

test("direct skill loading discovers defaults, stops recursion, and reports name collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skills-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "skills", "review", "nested"), { recursive: true });
  await mkdir(join(cwd, ".rigyn", "skills", "review"), { recursive: true });
  await writeFile(join(agentDir, "skills", "review", "SKILL.md"), manifest("review", "User review"));
  await writeFile(join(agentDir, "skills", "review", "nested", "SKILL.md"), manifest("nested", "Ignored nested"));
  await writeFile(join(cwd, ".rigyn", "skills", "review", "SKILL.md"), manifest("review", "Project review"));

  const result = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  assert.deepEqual(result.skills.map((skill) => [skill.name, skill.description]), [["review", "User review"]]);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.type === "collision"), true);
});

test("direct skill loading deduplicates symlinks and honors ignore files", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-links-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const shared = join(root, "shared");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(join(shared, "one"), { recursive: true });
  await mkdir(join(shared, "ignored"), { recursive: true });
  await writeFile(join(shared, ".gitignore"), "ignored/\n");
  await writeFile(join(shared, "one", "SKILL.md"), manifest("one", "One"));
  await writeFile(join(shared, "ignored", "SKILL.md"), manifest("ignored", "Ignored"));
  const link = join(root, "shared-link");
  await symlink(shared, link);

  const result = loadSkills({ cwd, agentDir, skillPaths: [shared, link], includeDefaults: false });
  assert.deepEqual(result.skills.map((skill) => skill.name), ["one"]);
});

test("skill prompt formatting hides non-model skills and escapes XML", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-prompt-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const skills = join(root, "skills");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(join(skills, "visible"), { recursive: true });
  await mkdir(join(skills, "hidden"), { recursive: true });
  await writeFile(join(skills, "visible", "SKILL.md"), manifest("visible", "A & B"));
  await writeFile(join(skills, "hidden", "SKILL.md"), manifest("hidden", "Hidden", true));
  const result = loadSkills({ cwd, agentDir, skillPaths: [skills], includeDefaults: false });
  const prompt = formatSkillsForPrompt(result.skills);
  assert.match(prompt, /<name>visible<\/name>/u);
  assert.match(prompt, /A &amp; B/u);
  assert.doesNotMatch(prompt, /hidden/u);
});

test("invalid names warn without hiding an otherwise usable skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-warnings-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const skillRoot = join(root, "different-directory");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(skillRoot);
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: Mixed--Name\ndescription: Still usable\n---\nInstructions",
  );

  const result = loadSkills({ cwd, agentDir, skillPaths: [skillRoot], includeDefaults: false });
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.name, "Mixed--Name");
  assert.equal(result.diagnostics.some((entry) => entry.message.includes("invalid characters")), true);
  assert.equal(result.diagnostics.some((entry) => entry.message.includes("consecutive hyphens")), true);
  assert.equal(result.diagnostics.every((entry) => entry.type === "warning"), true);
});

test("only a missing description prevents a parsed skill from loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-description-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const missing = join(root, "missing-description");
  const long = join(root, "long-description");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(missing);
  await mkdir(long);
  await writeFile(join(missing, "SKILL.md"), "---\nname: missing\n---\nInstructions");
  await writeFile(
    join(long, "SKILL.md"),
    `---\nname: long\ndescription: ${"x".repeat(1_025)}\n---\nInstructions`,
  );

  const result = loadSkills({ cwd, agentDir, skillPaths: [missing, long], includeDefaults: false });
  assert.deepEqual(result.skills.map((skill) => skill.name), ["long"]);
  assert.equal(result.diagnostics.some((entry) => entry.message === "description is required"), true);
  assert.equal(result.diagnostics.some((entry) => entry.message.includes("exceeds 1024")), true);
});

test("a skill without a declared name uses its parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-fallback-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const skillRoot = join(root, "fallback-name");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(skillRoot);
  await writeFile(join(skillRoot, "SKILL.md"), "---\ndescription: Uses the directory\n---\nInstructions");

  const result = loadSkills({ cwd, agentDir, skillPaths: [skillRoot], includeDefaults: false });
  assert.equal(result.skills[0]?.name, "fallback-name");
});

test("missing frontmatter is treated as missing metadata while malformed YAML is a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-frontmatter-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const skills = join(root, "skills");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(join(skills, "plain"), { recursive: true });
  await mkdir(join(skills, "invalid"), { recursive: true });
  await writeFile(join(skills, "plain", "SKILL.md"), "# No metadata");
  await writeFile(join(skills, "invalid", "SKILL.md"), "---\nname: [broken\ndescription: invalid\n---\nBody");

  const result = loadSkills({ cwd, agentDir, skillPaths: [skills], includeDefaults: false });
  assert.deepEqual(result.skills, []);
  assert.equal(result.diagnostics.some((entry) => entry.path?.endsWith(join("plain", "SKILL.md")) && entry.message === "description is required"), true);
  assert.equal(result.diagnostics.some((entry) => entry.path?.endsWith(join("invalid", "SKILL.md")) && entry.type === "warning"), true);
  assert.equal(result.diagnostics.every((entry) => entry.type === "warning"), true);
});

test("multiline descriptions survive YAML parsing and prompt guidance anchors relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-skill-multiline-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const skillRoot = join(root, "multiline");
  await mkdir(cwd);
  await mkdir(agentDir);
  await mkdir(skillRoot);
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: multiline\ndescription: |\n  First line.\n  Second line.\n---\nInstructions",
  );

  const result = loadSkills({ cwd, agentDir, skillPaths: [skillRoot], includeDefaults: false });
  assert.match(result.skills[0]?.description ?? "", /First line\.\nSecond line\./u);
  assert.match(formatSkillsForPrompt(result.skills), /relative to that skill's directory/u);
});
