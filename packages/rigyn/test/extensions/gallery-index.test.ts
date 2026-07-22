import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extensionGalleryInstallSource,
  parseExtensionGalleryIndex,
} from "../../src/extensions/gallery.js";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-tools",
    name: "Review tools",
    version: "1.2.3",
    description: "Focused review commands.",
    source: {
      kind: "npm",
      package: "@example/review-tools",
      version: "1.2.3",
      integrity: `sha512-${Buffer.from("archive").toString("base64")}`,
    },
    compatibility: { hostVersion: ">=0.1.0 <0.4.0" },
    contributions: { runtime: 1, tools: 2, commands: 1, skills: 0, prompts: 0, themes: 0, providers: 0 },
    readme: "https://example.com/review-tools/readme",
    homepage: "https://example.com/review-tools",
    media: [
      { kind: "video", url: "https://example.com/review-tools/demo.mp4" },
      { kind: "image", url: "https://example.com/review-tools/cover.png", alt: "Review result" },
    ],
    publishedAt: "2026-07-13T00:00:00.000Z",
    integrity: {
      status: "verified",
      digest: `sha256-${Buffer.from("manifest").toString("base64")}`,
    },
    provenance: { status: "publisher-asserted", detail: "Registry publisher metadata recorded." },
    securityWarnings: ["Uses network access.", "Runs trusted Node.js code."],
    dependencyCount: 2,
    ...overrides,
  };
}

test("gallery index parsing is strict, immutable-source-only, and deterministic", () => {
  const parsed = parseExtensionGalleryIndex({
    schemaVersion: 1,
    packages: [
      entry({
        id: "zeta-tools",
        source: {
          kind: "git",
          repository: "https://example.com/zeta-tools.git",
          revision: "a".repeat(40),
        },
      }),
      entry(),
    ],
  });
  assert.deepEqual(parsed.packages.map((item) => item.id), ["review-tools", "zeta-tools"]);
  assert.deepEqual(parsed.packages[0]?.media.map((item) => item.kind), ["image", "video"]);
  assert.deepEqual(parsed.packages[0]?.securityWarnings, ["Runs trusted Node.js code.", "Uses network access."]);
  assert.equal(extensionGalleryInstallSource(parsed.packages[0]!), "npm:@example/review-tools@1.2.3");
  assert.equal(extensionGalleryInstallSource(parsed.packages[1]!), `git:https://example.com/zeta-tools.git#${"a".repeat(40)}`);
});

test("gallery index rejects moving, credential-bearing, duplicate, and incomplete records", () => {
  assert.throws(() => parseExtensionGalleryIndex({ schemaVersion: 1, packages: [entry({ version: "latest" })] }), /exact semantic version/u);
  assert.throws(() => parseExtensionGalleryIndex({
    schemaVersion: 1,
    packages: [entry({ source: { kind: "git", repository: "https://token@example.com/repo.git", revision: "a".repeat(40) } })],
  }), /credential-free/u);
  assert.throws(() => parseExtensionGalleryIndex({
    schemaVersion: 1,
    packages: [entry({ source: { kind: "git", repository: "https://example.com/repo.git", revision: "main" } })],
  }), /full lowercase Git commit/u);
  assert.throws(() => parseExtensionGalleryIndex({ schemaVersion: 1, packages: [entry(), entry()] }), /duplicate package ID/u);
  assert.throws(() => parseExtensionGalleryIndex({ schemaVersion: 1, packages: [entry({ securityWarnings: undefined })] }), /must be an array/u);
  assert.throws(() => parseExtensionGalleryIndex({ schemaVersion: 1, packages: [entry({ unexpected: true })] }), /unknown keys/u);
});

test("the bundled discovery index is valid and intentionally contains no endorsed packages", async () => {
  const value = JSON.parse(await readFile("resources/package-gallery.json", "utf8")) as unknown;
  assert.deepEqual(parseExtensionGalleryIndex(value), { schemaVersion: 1, packages: [] });
  const schema = JSON.parse(await readFile("resources/schemas/package-gallery-v1.json", "utf8")) as Record<string, unknown>;
  assert.equal(schema.$id, "urn:rigyn:schema:package-gallery:v1");
});
