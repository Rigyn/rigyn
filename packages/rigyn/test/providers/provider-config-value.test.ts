import assert from "node:assert/strict";
import test from "node:test";

import {
  providerConfigValueUsesCommand,
  resolveProviderConfigValue,
} from "../../src/providers/provider-config-value.js";

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `eval(Buffer.from("${encoded}", "base64").toString("utf8"))`,
  )}`;
}

test("provider configuration values expand environment references once", async () => {
  const values = new Map([
    ["TOKEN", "secret"],
    ["SUFFIX", "tail"],
  ]);
  const context = {
    async env(name: string) {
      return values.get(name);
    },
  };
  assert.equal(
    await resolveProviderConfigValue("prefix-$TOKEN-${SUFFIX}-$$-$!", context),
    "prefix-secret-tail-$-!",
  );
  assert.equal(await resolveProviderConfigValue("$MISSING", context), undefined);
  assert.equal(await resolveProviderConfigValue("$!printf should-not-run", context), "!printf should-not-run");
});

test("provider configuration command resolution is uncached and preserves internal lines", async () => {
  const command = nodeCommand("process.stdout.write(`  first\\nsecond  \\n`)");
  assert.equal(providerConfigValueUsesCommand(command), true);
  assert.equal(providerConfigValueUsesCommand(` ${command}`), false);
  assert.equal(await resolveProviderConfigValue(command, { async env() { return undefined; } }), "first\nsecond");

  const random = nodeCommand("process.stdout.write(String(Math.random()))");
  const first = await resolveProviderConfigValue(random, { async env() { return undefined; } });
  const second = await resolveProviderConfigValue(random, { async env() { return undefined; } });
  assert.notEqual(first, second);
});

test("provider configuration commands inherit ambient env and apply scoped overrides", async () => {
  const name = "RIGYN_PROVIDER_CONFIG_VALUE_TEST";
  const previous = process.env[name];
  process.env[name] = "ambient";
  try {
    const command = nodeCommand(`process.stdout.write(process.env.${name} ?? "missing")`);
    assert.equal(
      await resolveProviderConfigValue(command, { async env() { return undefined; } }),
      "ambient",
    );
    assert.equal(
      await resolveProviderConfigValue(command, {
        async env() { return undefined; },
        environment: { [name]: "scoped" },
      }),
      "scoped",
    );
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("provider configuration command failures do not expose output", async () => {
  const secret = "command-stderr-secret";
  await assert.rejects(
    resolveProviderConfigValue(
      nodeCommand(`process.stderr.write(${JSON.stringify(secret)}); process.exit(7)`),
      { async env() { return undefined; } },
    ),
    (error: unknown) => error instanceof Error &&
      /command failed/u.test(error.message) &&
      !error.message.includes(secret),
  );
});
