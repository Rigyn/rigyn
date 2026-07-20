import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { sha256 } from "../../src/tools/hash.js";

const source = `export default function activate(api) {
  api.registerProviderAuth({
    provider: "managed-provider",
    methods: [{
      kind: "managed_oauth",
      id: "subscription",
      async login() {
        return {
          accessToken: "fixture-access",
          refreshToken: "fixture-refresh",
          expiresAt: Date.now() + 60000
        };
      },
      async refresh(credential) { return credential; }
    }]
  });
}
`;

test("managed provider authentication requires both trusted code and manifest credentialAccess", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-managed-auth-permission-"));
  const sourcePath = join(root, "managed-auth.mjs");
  await writeFile(sourcePath, source);
  t.after(async () => await rm(root, { recursive: true, force: true }));

  for (const fixture of [
    { name: "missing permission", trusted: true, credentialAccess: false },
    { name: "untrusted code", trusted: false, credentialAccess: true },
  ] as const) {
    await t.test(fixture.name, async () => {
      const host = await loadRuntimeExtensions([{
        extensionId: `managed-${fixture.name.replaceAll(" ", "-")}`,
        sourcePath,
        sha256: sha256(source),
        trusted: fixture.trusted,
        permissions: { credentialAccess: fixture.credentialAccess },
      }], { workspace: root });
      try {
        assert.deepEqual(host.providerAuth(), []);
        assert.match(
          host.diagnostics()[0]?.message ?? "",
          /Managed provider authentication requires a trusted manifest with permissions\.credentialAccess enabled/u,
        );
      } finally {
        await host.close();
      }
    });
  }

  await t.test("trusted manifest permission", async () => {
    const host = await loadRuntimeExtensions([{
      extensionId: "managed-authorized",
      sourcePath,
      sha256: sha256(source),
      trusted: true,
      permissions: { credentialAccess: true },
    }], { workspace: root });
    try {
      assert.deepEqual(
        host.providerAuth().map((entry) => ({
          extensionId: entry.extensionId,
          provider: entry.descriptor.provider,
          methods: entry.descriptor.methods.map((method) => method.kind),
        })),
        [{
          extensionId: "managed-authorized",
          provider: "managed-provider",
          methods: ["managed_oauth"],
        }],
      );
      assert.deepEqual(host.diagnostics(), []);
    } finally {
      await host.close();
    }
  });
});
