import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  discoverInstructions,
  discoverSkills,
  loadSkill,
  renderInstructions,
} from "../../src/context/index.js";

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

test("instructions load user then root-to-cwd with nearest override and provenance", async () => {
  const root = directory("harness-instructions-");
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root rules");
  writeFileSync(join(nested, "AGENTS.md"), "ordinary nested rules");
  writeFileSync(join(nested, "AGENTS.override.md"), "override nested rules");

  const discovered = await discoverInstructions({
    workspaceRoot: root,
    cwd: nested,
    trusted: false,
    userInstructions: { text: "user rules", source: "profile" },
  });
  assert.deepEqual(discovered.entries.map((entry) => entry.text), [
    "user rules",
    "root rules",
    "override nested rules",
  ]);
  assert.deepEqual(discovered.entries.map((entry) => entry.scope), ["user", "workspace", "workspace"]);
  assert.equal(discovered.entries[0]?.trusted, true);
  assert.equal(discovered.entries[1]?.trusted, false);
  assert.match(renderInstructions(discovered), /untrusted/);
  assert.doesNotMatch(renderInstructions(discovered), /ordinary nested rules/);
});

test("CLAUDE.md is a fallback when a directory has no AGENTS instruction file", async () => {
  const root = directory("harness-claude-instructions-");
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeFileSync(join(root, "CLAUDE.md"), "compatible root rules");
  writeFileSync(join(nested, "CLAUDE.md"), "shadowed compatible rules");
  writeFileSync(join(nested, "AGENTS.md"), "native nested rules");

  const discovered = await discoverInstructions({
    workspaceRoot: root,
    cwd: nested,
    trusted: true,
  });
  assert.deepEqual(discovered.entries.map((entry) => entry.text), [
    "compatible root rules",
    "native nested rules",
  ]);
});

test("global user instructions load before workspace files and file loading can be disabled per run", async () => {
  const root = directory("harness-global-instructions-");
  const config = directory("harness-global-config-");
  const globalInstructions = join(config, "AGENTS.md");
  writeFileSync(globalInstructions, "global rules");
  writeFileSync(join(root, "AGENTS.md"), "workspace rules");

  const discovered = await discoverInstructions({
    workspaceRoot: root,
    cwd: root,
    trusted: true,
    userInstructions: { text: "embedded rules", source: "profile" },
    userInstructionFile: globalInstructions,
  });
  assert.deepEqual(discovered.entries.map((entry) => entry.text), [
    "embedded rules",
    "global rules",
    "workspace rules",
  ]);
  assert.deepEqual(discovered.entries.map((entry) => entry.scope), ["user", "user", "workspace"]);

  const disabled = await discoverInstructions({
    workspaceRoot: root,
    cwd: root,
    trusted: true,
    userInstructions: { text: "embedded rules", source: "profile" },
    userInstructionFile: globalInstructions,
    includeFiles: false,
  });
  assert.deepEqual(disabled.entries.map((entry) => entry.text), ["embedded rules"]);
});

test("global user instruction files cannot escape their config directory through symlinks", async () => {
  const root = directory("harness-global-boundary-workspace-");
  const config = directory("harness-global-boundary-config-");
  const outside = directory("harness-global-boundary-outside-");
  const outsideInstructions = join(outside, "outside.md");
  writeFileSync(outsideInstructions, "outside instructions");
  const globalInstructions = join(config, "AGENTS.md");
  symlinkSync(outsideInstructions, globalInstructions);

  await assert.rejects(discoverInstructions({
    workspaceRoot: root,
    cwd: root,
    trusted: true,
    userInstructionFile: globalInstructions,
  }), /filesystem boundary/u);
});

test("instruction byte budgets are global, deterministic, and reported", async () => {
  const root = directory("harness-instruction-cap-");
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeFileSync(join(root, "AGENTS.md"), "r".repeat(100));
  writeFileSync(join(nested, "AGENTS.md"), "n".repeat(100));

  const discovered = await discoverInstructions({
    workspaceRoot: root,
    cwd: nested,
    trusted: true,
    userInstructions: { text: "u".repeat(10) },
    maxFileBytes: 50,
    maxTotalBytes: 30,
  });
  assert.equal(discovered.totalBytes, 30);
  assert.equal(discovered.truncated, true);
  assert.equal(discovered.entries.length, 2);
  assert.equal(discovered.entries[0]?.bytesRead, 10);
  assert.equal(discovered.entries[1]?.bytesRead, 20);
  assert.equal(discovered.entries[1]?.truncated, true);
});

test("instruction files and working directories cannot escape through symlinks", async () => {
  const root = directory("harness-instruction-boundary-");
  const outside = directory("harness-instruction-outside-");
  writeFileSync(join(outside, "outside.md"), "outside instructions");
  symlinkSync(join(outside, "outside.md"), join(root, "AGENTS.md"));
  await assert.rejects(
    discoverInstructions({ workspaceRoot: root, cwd: root, trusted: false }),
    /filesystem boundary/,
  );

  const linkedDirectory = join(root, "linked");
  symlinkSync(outside, linkedDirectory, "dir");
  await assert.rejects(
    discoverInstructions({ workspaceRoot: root, cwd: linkedDirectory, trusted: false }),
    /filesystem boundary/,
  );
});

test("skill discovery exposes metadata only and explicit load returns bounded instructions", async () => {
  const userRoot = directory("harness-user-skills-");
  const workspaceRoot = directory("harness-workspace-skills-");
  const userSkill = join(userRoot, "review");
  const workspaceSkill = join(workspaceRoot, "review");
  mkdirSync(userSkill);
  mkdirSync(workspaceSkill);
  writeFileSync(
    join(userSkill, "SKILL.md"),
    "---\nname: review\ndescription: user review\n---\nUSER BODY",
  );
  writeFileSync(
    join(workspaceSkill, "SKILL.md"),
    "---\nname: review\ndescription: workspace review\n---\nWORKSPACE SECRET BODY",
  );

  const skills = await discoverSkills([
    { path: userRoot, scope: "user", trusted: true },
    { path: workspaceRoot, scope: "workspace", trusted: false },
  ]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.description, "workspace review");
  assert.equal(skills[0]?.scope, "workspace");
  assert.equal("instructions" in (skills[0] ?? {}), false);

  const loaded = await loadSkill(skills[0]!, 64);
  assert.match(loaded.instructions, /WORKSPACE/);
  assert.equal(loaded.truncated, true);
  assert.equal(loaded.trusted, false);
});

test("skill roots reject symlink escapes and enforce discovery caps", async () => {
  const root = directory("harness-skill-boundary-");
  const outside = directory("harness-skill-outside-");
  const outsideSkill = join(outside, "bad");
  mkdirSync(outsideSkill);
  writeFileSync(join(outsideSkill, "SKILL.md"), "---\nname: bad\ndescription: bad\n---\nbody");
  symlinkSync(outsideSkill, join(root, "bad"), "dir");
  await assert.rejects(
    discoverSkills([{ path: root, scope: "workspace", trusted: false }]),
    /escapes its root/,
  );

  rmSync(join(root, "bad"));
  for (const name of ["one", "two"]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nbody`);
  }
  await assert.rejects(
    discoverSkills([{ path: root, scope: "workspace", trusted: true }], { maxSkills: 1 }),
    /exceeds 1/,
  );
});
