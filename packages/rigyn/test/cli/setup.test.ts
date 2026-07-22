import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { persistDefaultSelection } from "../../src/cli/setup.js";
import type { AgentPaths } from "../../src/cli/paths.js";

function pathsFor(root: string): AgentPaths {
  const agentDirectory = join(root, ".rigyn", "agent");
  return {
    agentDirectory,
    settings: join(agentDirectory, "settings.json"),
    keybindings: join(agentDirectory, "keybindings.json"),
    trustStore: join(agentDirectory, "trusted-workspaces.json"),
    auth: join(agentDirectory, "auth.json"),
    sessions: join(agentDirectory, "sessions"),
    modelCatalog: join(agentDirectory, "models.json"),
    userSkills: join(agentDirectory, "skills"),
    userExtensions: join(agentDirectory, "extensions"),
    userPrompts: join(agentDirectory, "prompts"),
    userThemes: join(agentDirectory, "themes"),
  };
}

test("settings updates preserve external edits and remain private", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-update-"));
  try {
    const paths = pathsFor(root);
    const manager = SettingsManager.create(root, paths.agentDirectory);
    manager.updateGlobalSettings({ quietStartup: true });
    await manager.flush();
    await writeFile(paths.settings, JSON.stringify({ quietStartup: true, showCacheMissNotices: true }, null, 2));
    await persistDefaultSelection(manager, { provider: "fixture", model: "fixture-model" });
    const settings = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
    assert.deepEqual(settings, {
      quietStartup: true,
      showCacheMissNotices: true,
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
    });
    if (process.platform !== "win32") assert.equal((await stat(paths.settings)).mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
