import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialStore } from "../../src/cli/runtime.js";
import type { HarnessPaths } from "../../src/cli/paths.js";

test("interactive fallback creates its encrypted credential store only on first write", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-local-credentials-"));
  const paths: HarnessPaths = {
    configDirectory: join(root, "config"),
    stateDirectory: join(root, "state"),
    globalConfig: join(root, "config", "config.jsonc"),
    trustStore: join(root, "config", "trust.json"),
    credentialStore: join(root, "config", "credentials.enc"),
    credentialKey: join(root, "config", "credentials.key"),
    database: join(root, "state", "sessions.sqlite"),
    modelCatalog: join(root, "state", "models.json"),
    userSkills: join(root, "config", "skills"),
    userExtensions: join(root, "config", "extensions"),
    userPrompts: join(root, "config", "prompts"),
    userThemes: join(root, "config", "themes"),
  };
  const store = await createCredentialStore(paths, { createLocalKey: true, environment: {}, allowPlatformKeychain: false });
  await assert.rejects(stat(paths.credentialKey), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(paths.credentialStore), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "never-plaintext-secret" });
  assert.equal((await store.read("fixture"))?.kind, "api_key");
  assert.doesNotMatch(await readFile(paths.credentialStore, "utf8"), /never-plaintext-secret/u);
  if (process.platform !== "win32") assert.equal((await stat(paths.credentialKey)).mode & 0o077, 0);

  const reopened = await createCredentialStore(paths, { environment: {}, allowPlatformKeychain: false });
  const credential = await reopened.read("fixture");
  assert.equal(credential?.kind, "api_key");
  if (credential?.kind === "api_key") assert.equal(credential.apiKey, "never-plaintext-secret");
});
