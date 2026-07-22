import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "../../src/service/agent-session-services.js";
import { SessionManager } from "../../src/storage/session-manager.js";

test("service composition returns the public agent-session result contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-services-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: await ModelRuntime.create({ models: createModels(), modelsPath: null }),
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  context.after(async () => await result.session.close());

  assert.deepEqual(Object.keys(result).sort(), ["extensionsResult", "modelFallbackMessage", "session"]);
  assert.equal(result.extensionsResult, services.resourceLoader.getExtensions());
  assert.equal("services" in result, false);
  assert.equal("diagnostics" in result, false);
});
