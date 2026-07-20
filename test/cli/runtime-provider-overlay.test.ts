import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";

test("trusted provider overlays retain host ownership and restore on runtime close", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-provider-overlay-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const extension = join(configHome, "rigyn", "extensions", "provider-overlay");
  await mkdir(join(extension, "runtime"), { recursive: true });
  await chmod(join(configHome, "rigyn"), 0o700);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "provider-overlay",
    name: "Provider Overlay",
    permissions: { providerOverride: true },
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(join(extension, "runtime", "index.mjs"), `
export default function activate(api) {
  api.native.providers.overlay({
    id: "ollama",
    displayName: "Local Overlay",
    models: [{
      id: "overlay-model",
      provider: "ollama",
      capabilities: {
        tools: { value: "unknown", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" },
        reasoning: { value: "unknown", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" },
        images: { value: "unknown", source: "provider", observedAt: "2026-01-01T00:00:00.000Z" }
      }
    }]
  });
}
`);

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const previousKey = process.env.RIGYN_CREDENTIAL_KEY;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 17).toString("base64url");
  try {
    const runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
      skills: false,
      promptTemplates: false,
      themes: false,
    });
    const overlayAdapter = runtime.providers.get("ollama");
    try {
      assert.equal(runtime.auth.binding("ollama").displayName, "Local Overlay");
      await runtime.providers.refreshModels("ollama", new AbortController().signal);
      assert.deepEqual(
        (await runtime.providers.listModels("ollama", new AbortController().signal)).map((model) => model.id),
        ["overlay-model"],
      );
    } finally {
      await runtime.close();
    }
    assert.equal(runtime.auth.binding("ollama").displayName, "Ollama");
    assert.notEqual(runtime.providers.get("ollama"), overlayAdapter);
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousKey === undefined) delete process.env.RIGYN_CREDENTIAL_KEY;
    else process.env.RIGYN_CREDENTIAL_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});
