import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  getAgentDir,
  getAuthPath,
  getCrashDir,
  getDiagnosticsDir,
  getExtensionsDir,
  getLogsDir,
  getModelsPath,
  getProjectSettingsPath,
  getSessionsDir,
  getSettingsPath,
  getSkillsDir,
} from "../../src/config/paths.js";
import {
  canonicalizePath,
  filesystemPathIdentity,
  isLocalPath,
  markPathIgnoredByCloudSync,
  normalizePath,
  resolvePath,
  sameFilesystemPath,
} from "../../src/utils/paths.js";
import { projectConfigRootMatchesAgentDir } from "../../src/utils/project-scope.js";

test("agent paths use one direct home and honor explicit overrides", () => {
  const defaults = getAgentDir({});
  assert.equal(defaults, join(homedir(), ".rigyn"));
  assert.equal(getSettingsPath({}), join(defaults, "config.json"));
  assert.equal(getAuthPath({}), join(defaults, "auth.json"));
  assert.equal(getModelsPath({}), join(defaults, "models.json"));
  assert.equal(getSessionsDir({}), join(defaults, "sessions"));
  assert.equal(getExtensionsDir({}), join(defaults, "extensions"));
  assert.equal(getSkillsDir({}), join(defaults, "skills"));
  assert.equal(getLogsDir({}), join(defaults, "logs"));
  assert.equal(getDiagnosticsDir({}), join(defaults, "diagnostics"));
  assert.equal(getCrashDir({}), join(defaults, "crash"));
  assert.equal(getProjectSettingsPath("/workspace"), join("/workspace", ".rigyn", "config.json"));

  const environment = {
    RIGYN_HOME: "~/rigyn-test",
    RIGYN_SESSION_DIR: "~/sessions-test",
  };
  assert.equal(getAgentDir(environment), join(homedir(), "rigyn-test"));
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
  const fileUrl = pathToFileURL(join(cwd, "space name")).href;
  assert.equal(resolvePath(fileUrl), join(cwd, "space name"));
  assert.equal(resolvePath(fileUrl.replace(/^file:/u, "FILE:")), join(cwd, "space name"));
  assert.equal(resolvePath(fileUrl.replace(/^file:/u, "FiLe:")), join(cwd, "space name"));
  assert.equal(isLocalPath("file:///tmp/test"), true);
  assert.equal(isLocalPath("./extension"), true);
  for (const source of ["npm:pkg", "git:https://host/repo", "https://host/pkg", "ssh://host/repo"]) {
    assert.equal(isLocalPath(source), false);
  }
});

test("canonical paths preserve filesystem aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-paths-"));
  const target = join(root, "target");
  const alias = join(root, "alias");
  await mkdir(target);
  await writeFile(join(target, "file.txt"), "ok");
  await symlink(target, alias, "dir");
  assert.equal(canonicalizePath(alias), target);
  assert.equal(sameFilesystemPath(alias, target), true);
});

test("filesystem path identity follows native case semantics", () => {
  assert.equal(
    filesystemPathIdentity(String.raw`C:\Repo\File.ts`),
    filesystemPathIdentity("c:/repo/file.ts"),
  );
  assert.equal(sameFilesystemPath(String.raw`C:\Repo\File.ts`, "c:/repo/file.ts"), true);
  if (process.platform !== "win32") assert.equal(sameFilesystemPath("/Repo/File.ts", "/repo/file.ts"), false);
});

test("project scope resolves existing aliases before comparing a missing config root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-project-scope-alias-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "actual-home");
  const alias = join(root, "home-alias");
  const other = join(root, "other-home");
  await Promise.all([mkdir(workspace), mkdir(other)]);
  try {
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Directory aliases are unavailable on this Windows host");
      return;
    }
    throw error;
  }

  assert.equal(projectConfigRootMatchesAgentDir(workspace, join(alias, ".rigyn")), true);
  assert.equal(projectConfigRootMatchesAgentDir(workspace, join(other, ".rigyn")), false);

  await Promise.all([mkdir(join(workspace, ".rigyn")), mkdir(join(other, ".rigyn"))]);
  assert.equal(projectConfigRootMatchesAgentDir(workspace, join(alias, ".rigyn")), true);
  assert.equal(projectConfigRootMatchesAgentDir(workspace, join(other, ".rigyn")), false);
});

test("cloud-sync cache hints never make cache creation fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-cloud-ignore-"));
  assert.doesNotThrow(() => markPathIgnoredByCloudSync(root));
});
