import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  getAgentDir,
  getAuthPath,
  getExtensionsDir,
  getModelsPath,
  getProjectSettingsPath,
  getSessionsDir,
  getSettingsPath,
  getSkillsDir,
} from "../../src/config/paths.js";
import {
  canonicalizePath,
  filesystemPathIdentity,
  getCwdRelativePath,
  isLocalPath,
  markPathIgnoredByCloudSync,
  normalizePath,
  resolvePath,
  sameFilesystemPath,
} from "../../src/utils/paths.js";

test("agent paths use one direct home and honor explicit overrides", () => {
  const defaults = getAgentDir({});
  assert.equal(defaults, join(homedir(), ".rigyn", "agent"));
  assert.equal(getSettingsPath({}), join(defaults, "settings.json"));
  assert.equal(getAuthPath({}), join(defaults, "auth.json"));
  assert.equal(getModelsPath({}), join(defaults, "models.json"));
  assert.equal(getSessionsDir({}), join(defaults, "sessions"));
  assert.equal(getExtensionsDir({}), join(defaults, "extensions"));
  assert.equal(getSkillsDir({}), join(defaults, "skills"));
  assert.equal(getProjectSettingsPath("/workspace"), join("/workspace", ".rigyn", "settings.json"));

  const environment = {
    RIGYN_CODING_AGENT_DIR: "~/agent-test",
    RIGYN_CODING_AGENT_SESSION_DIR: "~/sessions-test",
  };
  assert.equal(getAgentDir(environment), join(homedir(), "agent-test"));
  assert.equal(getSessionsDir(environment), join(homedir(), "sessions-test"));
});

test("path normalization handles local sources, file URLs, tilde, and unicode spaces", () => {
  const cwd = join(tmpdir(), "rigyn-path-root");
  assert.equal(normalizePath("~"), homedir());
  assert.equal(resolvePath("~draft.md", cwd), resolve(cwd, "~draft.md"));
  assert.equal(
    normalizePath("@Screenshot\u202fOne.png", {
      stripAtPrefix: true,
      normalizeUnicodeSpaces: true,
    }),
    "Screenshot One.png",
  );
  assert.equal(resolvePath(pathToFileURL(join(cwd, "space name")).href), join(cwd, "space name"));
  assert.equal(isLocalPath("file:///tmp/test"), true);
  assert.equal(isLocalPath("./extension"), true);
  for (const source of ["npm:pkg", "git:https://host/repo", "https://host/pkg", "ssh://host/repo"]) {
    assert.equal(isLocalPath(source), false);
  }
});

test("canonical and cwd-relative paths preserve the containment boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-paths-"));
  const target = join(root, "target");
  const alias = join(root, "alias");
  await mkdir(target);
  await writeFile(join(target, "file.txt"), "ok");
  await symlink(target, alias, "dir");
  assert.equal(canonicalizePath(alias), target);
  assert.equal(getCwdRelativePath(join(root, "..config", "AGENTS.md"), root), join("..config", "AGENTS.md"));
  assert.equal(getCwdRelativePath(join(root, "..", "outside"), root), undefined);
});

test("filesystem path identity follows native case semantics", () => {
  assert.equal(
    filesystemPathIdentity(String.raw`C:\Repo\File.ts`),
    filesystemPathIdentity("c:/repo/file.ts"),
  );
  assert.equal(sameFilesystemPath(String.raw`C:\Repo\File.ts`, "c:/repo/file.ts"), true);
  if (process.platform !== "win32") assert.equal(sameFilesystemPath("/Repo/File.ts", "/repo/file.ts"), false);
});

test("cloud-sync cache hints never make cache creation fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-cloud-ignore-"));
  assert.doesNotThrow(() => markPathIgnoredByCloudSync(root));
});
