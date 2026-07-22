import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/tools/hash.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

const source = `export default function activate(rigyn) {
  rigyn.registerProvider("managed-provider", {
    name: "Managed provider",
    api: "openai-chat-completions",
    baseUrl: "https://managed.example.test/v1",
    models: [{
      id: "managed-model", name: "Managed model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048
    }],
    oauth: {
      name: "Managed subscription",
      async login() {
        return { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60000 };
      },
      async refreshToken(credential) { return credential; },
      getApiKey(credential) { return credential.access; }
    }
  });
}
`;

test("managed provider authentication uses the single direct-runtime trust boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-managed-auth-trust-"));
  const sourcePath = join(root, "managed-auth.mjs");
  await writeFile(sourcePath, source);
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await t.test("untrusted code is not imported", async () => {
    const host = await loadTestDirectExtensions([{
      extensionId: "managed-untrusted",
      sourcePath,
      sha256: sha256(source),
      trusted: false,
    }], { workspace: root });
    try {
      assert.deepEqual(host.directProviderRegistrations(), []);
      assert.match(host.diagnostics()[0]?.message ?? "", /not trusted/u);
    } finally {
      await host.close();
    }
  });

  await t.test("trusted code receives managed OAuth callbacks without a second permission tier", async () => {
    const host = await loadTestDirectExtensions([{
      extensionId: "managed-authorized",
      sourcePath,
      sha256: sha256(source),
      trusted: true,
    }], { workspace: root });
    try {
      const registration = host.directProviderRegistrations()[0];
      assert.equal(registration?.name, "managed-provider");
      assert.ok(registration !== undefined && "config" in registration);
      assert.equal(registration.config.oauth?.name, "Managed subscription");
      assert.equal(typeof registration.config.oauth?.login, "function");
      assert.equal(typeof registration.config.oauth?.refreshToken, "function");
      assert.equal(typeof registration.config.oauth?.getApiKey, "function");
      assert.deepEqual(host.diagnostics(), []);
    } finally {
      await host.close();
    }
  });
});
