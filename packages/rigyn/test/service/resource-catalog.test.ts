import assert from "node:assert/strict";
import test from "node:test";

import type { ModelInfo } from "../../src/core/types.js";
import { ExtensionCatalog } from "../../src/extensions/catalog.js";
import type { ExtensionBundle, ExtensionMetadata } from "../../src/extensions/types.js";
import {
  HARNESS_RESOURCE_CATALOG_LIMITS,
  buildHarnessResourceCatalog,
  parseHarnessResourceCatalog,
} from "../../src/service/resource-catalog.js";
import type { HarnessTool } from "../../src/tools/types.js";

const HASH = "a".repeat(64);
const OBSERVED_AT = "2026-07-12T00:00:00.000Z";

function tool(name: string, description = `${name} description`, inputSchema: Record<string, unknown> = { type: "object" }): HarnessTool {
  return {
    definition: { name, description, inputSchema },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "ok", isError: false }; },
  } as HarnessTool;
}

function model(id: string, provider: string): ModelInfo {
  const capability = { value: "supported" as const, source: "provider" as const, observedAt: OBSERVED_AT };
  return {
    id,
    provider,
    displayName: `${id} display`,
    description: `${id} description`,
    contextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: { tools: capability, reasoning: capability, images: capability },
    metadata: { privateProviderState: "must-not-cross-catalog" },
  };
}

function extensionCatalog(): ExtensionCatalog {
  const metadata: ExtensionMetadata[] = [{
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
    scope: "project",
    trusted: false,
    status: "blocked",
    sourceRoot: "/private/source-root",
    extensionRoot: "/private/extension-root",
    manifestPath: "/private/package.json",
    manifestSha256: HASH,
    precedence: 2,
    contributions: { skillRoots: 0, prompts: 1, commands: 1, themes: 1, runtime: 1 },
  }];
  const bundle: ExtensionBundle = {
    skillRoots: [],
    prompts: [{
      id: "private-prompt",
      extensionId: "fixture",
      description: "Prompt metadata",
      sourcePath: "/private/prompt.md",
      sha256: HASH,
      template: "SECRET PROMPT CONTENT",
    }],
    commands: [{
      name: "fixture-command",
      extensionId: "fixture",
      sourcePath: "/private/command.md",
      sha256: HASH,
      template: "SECRET COMMAND CONTENT",
    }],
    themes: [{
      name: "fixture-theme",
      extensionId: "fixture",
      sourcePath: "/private/theme.json",
      sha256: HASH,
      definition: { schemaVersion: 1, name: "fixture-theme", base: "dark", styles: {} },
    }],
    runtime: [{ extensionId: "fixture", sourcePath: "/private/runtime.mjs", sha256: HASH }],
  };
  return new ExtensionCatalog(metadata, [{
    severity: "warning",
    code: "FIXTURE_WARNING",
    message: "Fixture is untrusted",
    path: "/private/diagnostic-path",
    extensionId: "fixture",
  }], bundle);
}

test("resource catalog is deterministic, callback-free, and omits private contents and paths", () => {
  const read = tool("read");
  const extensionTool = tool("z_extension");
  const catalog = buildHarnessResourceCatalog({
    tools: [extensionTool, read],
    toolOwner: (value) => value === extensionTool ? { kind: "extension", extensionId: "fixture" } : { kind: "builtin" },
    skills: [{
      name: "review",
      description: "Review changes",
      scope: "workspace",
      trusted: false,
      rootPath: "/private/skill",
      directory: "/private/skill",
      manifestPath: "/private/skill/SKILL.md",
      metadataTruncated: false,
      metadata: { private: "hidden" },
      disableModelInvocation: true,
      allowedTools: "read",
    }],
    providers: [
      { id: "z-provider", models: [model("z-model", "z-provider")] },
      { id: "a-provider", models: [model("a-model", "a-provider")] },
    ],
    runtimeCommands: [{
      extensionId: "fixture",
      name: "runtime-command",
      baseName: "runtime-command",
      scope: "project",
      trusted: false,
      description: "Runtime metadata",
    }],
    runtimeDiagnostics: [{ extensionId: "fixture", message: "Runtime warning" }],
    extensions: extensionCatalog(),
    packages: [{
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      scope: "project",
      packageRoot: "/private/package-root",
      manifestPath: "/private/package-root/package.json",
      manifestModified: false,
      provenance: {
        schemaVersion: 1,
        id: "fixture",
        scope: "project",
        installedAt: OBSERVED_AT,
        manifestSha256: HASH,
        kind: "local",
        sourcePath: "/private/original-source",
      },
    }],
    projectPackages: [{
      id: "fixture",
      source: { kind: "local", path: "packages/fixture" },
      disabledResources: ["command:fixture-command"],
      resolved: {
        kind: "local",
        path: "packages/fixture",
        manifestSha256: HASH,
        contentSha256: HASH,
      },
    }],
  });
  const second = buildHarnessResourceCatalog({
    tools: [extensionTool, read],
    toolOwner: (value) => value === extensionTool ? { kind: "extension", extensionId: "fixture" } : { kind: "builtin" },
    skills: [],
    providers: [],
  });
  assert.deepEqual(catalog.tools.map((entry) => entry.name), ["read"], "blocked extension tools must not cross the catalog boundary");
  assert.deepEqual(catalog.providers.map((entry) => entry.id), ["a-provider", "z-provider"]);
  assert.deepEqual(catalog.extensions[0], {
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
    scope: "project",
    trusted: false,
    enabled: false,
    status: "blocked",
    precedence: 2,
    manifestSha256: HASH,
    contributions: { skillRoots: 0, prompts: 1, commands: 1, themes: 1, runtime: 1 },
  });
  assert.equal(catalog.packages[0]?.trusted, false);
  assert.equal(catalog.packages[0]?.enabled, false);
  assert.deepEqual(catalog.prompts, [], "blocked untrusted extension prompts must not cross the catalog boundary");
  assert.deepEqual(catalog.commands.extensionTemplates, [], "blocked untrusted extension commands must not cross the catalog boundary");
  assert.deepEqual(catalog.themes, [], "blocked untrusted extension themes must not cross the catalog boundary");
  assert.deepEqual(catalog.packages[0]?.provenance, {
    kind: "local",
    installedAt: OBSERVED_AT,
    manifestSha256: HASH,
  });
  assert.deepEqual(catalog.packages[0]?.project, {
    source: { kind: "local", path: "packages/fixture" },
    disabledResources: ["command:fixture-command"],
    resolved: { kind: "local", path: "packages/fixture", manifestSha256: HASH, contentSha256: HASH },
  });
  assert.deepEqual(parseHarnessResourceCatalog(catalog), catalog);
  assert.deepEqual(second, buildHarnessResourceCatalog({
    tools: [extensionTool, read],
    toolOwner: (value) => value === extensionTool ? { kind: "extension", extensionId: "fixture" } : { kind: "builtin" },
    skills: [],
    providers: [],
  }));
  const wire = JSON.stringify(catalog);
  assert.doesNotMatch(wire, /SECRET|privateProviderState|sourcePath|source-root|extension-root|diagnostic-path|package-root|runtime\.mjs|SKILL\.md/u);
});

test("resource catalog applies deterministic entry, schema, and byte bounds", () => {
  const tools = Array.from({ length: HARNESS_RESOURCE_CATALOG_LIMITS.maxTools + 20 }, (_, index) =>
    tool(`tool_${String(index).padStart(3, "0")}`, "x".repeat(8_000), {
      type: "object",
      description: "x".repeat(HARNESS_RESOURCE_CATALOG_LIMITS.maxToolSchemaBytes + 1),
    }));
  const catalog = buildHarnessResourceCatalog({
    tools,
    toolOwner: () => ({ kind: "host" }),
    skills: [],
    providers: [],
  });
  assert.equal(catalog.bounds.truncated, true);
  assert.ok(catalog.bounds.omitted.tools > 0);
  assert.ok(catalog.tools.length <= HARNESS_RESOURCE_CATALOG_LIMITS.maxTools);
  assert.equal(catalog.tools[0]?.inputSchema, undefined);
  assert.equal(catalog.tools[0]?.inputSchemaOmitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) <= HARNESS_RESOURCE_CATALOG_LIMITS.maxBytes);
});

test("resource catalog preserves invocation-only package and extension scope", () => {
  const extensions = new ExtensionCatalog([{
    id: "temporary",
    name: "Temporary",
    scope: "invocation",
    trusted: true,
    status: "active",
    sourceRoot: "/private/invocation-root",
    extensionRoot: "/private/invocation-root/temporary",
    manifestPath: "/private/invocation-root/temporary/package.json",
    manifestSha256: HASH,
    precedence: 3,
    contributions: { skillRoots: 0, prompts: 0, commands: 0, themes: 0, runtime: 0 },
  }], [], { skillRoots: [], prompts: [], commands: [], themes: [], runtime: [] });
  const catalog = buildHarnessResourceCatalog({
    tools: [],
    toolOwner: () => ({ kind: "builtin" }),
    skills: [],
    providers: [],
    extensions,
    packages: [{
      id: "temporary",
      name: "Temporary",
      scope: "invocation",
      packageRoot: "/private/invocation-root/temporary",
      manifestPath: "/private/invocation-root/temporary/package.json",
      manifestModified: false,
      provenance: {
        schemaVersion: 1,
        id: "temporary",
        scope: "user",
        installedAt: OBSERVED_AT,
        manifestSha256: HASH,
        kind: "local",
        sourcePath: "/private/source",
      },
    }],
  });

  assert.equal(catalog.extensions[0]?.scope, "invocation");
  assert.equal(catalog.packages[0]?.scope, "invocation");
  assert.equal(catalog.packages[0]?.trusted, true);
  assert.equal(catalog.packages[0]?.enabled, true);
  assert.deepEqual(parseHarnessResourceCatalog(catalog), catalog);
});

test("resource catalog boundary rejects callbacks, malformed trust, unknown fields, and inconsistent counts", () => {
  const catalog = buildHarnessResourceCatalog({ tools: [], toolOwner: () => ({ kind: "builtin" }), skills: [], providers: [] });
  assert.throws(() => parseHarnessResourceCatalog({ ...catalog, callback() {} }), /callback-free|plain JSON/u);
  assert.throws(() => parseHarnessResourceCatalog({ ...catalog, unknown: true }), /unknown keys/u);
  assert.throws(() => parseHarnessResourceCatalog({
    ...catalog,
    skills: [{ name: "bad", description: "bad", scope: "user", trusted: "yes", disableModelInvocation: false, metadataTruncated: false }],
  }), /trusted must be a boolean/u);
  assert.throws(() => parseHarnessResourceCatalog({
    ...catalog,
    providers: [{ id: "provider", modelCount: 2, modelsOmitted: 0, models: [] }],
  }), /model counts are inconsistent/u);
});
