import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readStoredCredential } from "../../src/auth/index.js";
import { parseArgs } from "../../src/cli/args.js";
import { hasTrustRequiringProjectResources } from "../../src/config/index.js";
import { shouldCompact } from "../../src/context/public-compaction.js";
import { parseFrontmatter, stripFrontmatter } from "../../src/core/frontmatter.js";
import { createExtensionRuntime } from "../../src/extensions/compat.js";
import { formatDimensionNote } from "../../src/images/helpers.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { parseSkillBlock } from "../../src/service/agent-session.js";
import { truncateHead, truncateLine, truncateTail } from "../../src/tools/truncate.js";
import { renderDiff, truncateToVisualLines } from "../../src/tui/public-components.js";

test("generic parsing and truncation facades preserve native semantics", () => {
  const parsed = parseFrontmatter<{ title: string }>("---\ntitle: Probe\n---\nbody\n");
  assert.deepEqual(parsed, { frontmatter: { title: "Probe" }, body: "body" });
  assert.equal(stripFrontmatter("---\ntitle: Probe\n---\nbody"), "body");
  assert.deepEqual(parseSkillBlock('<skill name="audit" location="/tmp/audit">\nInspect.\n</skill>\n\nRun it.'), {
    name: "audit",
    location: "/tmp/audit",
    content: "Inspect.",
    userMessage: "Run it.",
  });
  assert.equal(parseArgs(["--model", "probe", "hello"]).model, "probe");

  assert.equal(truncateHead("one\ntwo\nthree", { maxLines: 2 }).content, "one\ntwo");
  assert.equal(truncateTail("one\ntwo\nthree", { maxLines: 2 }).content, "two\nthree");
  assert.deepEqual(truncateLine("abcdefghij", 8), { text: "abcdefgh... [truncated]", wasTruncated: true });
  assert.equal(shouldCompact(90, 100, { enabled: true, reserveTokens: 10, keepRecentTokens: 20 }), false);
  assert.equal(shouldCompact(91, 100, { enabled: true, reserveTokens: 10, keepRecentTokens: 20 }), true);
});

test("generic visual, image-note, and extension adapters are operational", async (t) => {
  const visual = truncateToVisualLines("one\ntwo\nthree", 2, 20);
  assert.deepEqual(visual.visualLines, ["two", "three"]);
  assert.equal(visual.skippedCount, 1);
  assert.match(renderDiff("-old\n+new", { filePath: "probe.txt" }), /old/u);
  assert.equal(formatDimensionNote({
    data: "",
    mimeType: "image/png",
    originalWidth: 100,
    originalHeight: 50,
    width: 50,
    height: 25,
    wasResized: true,
  }), "[Image: original 100x50, displayed at 50x25. Multiply coordinates by 2.00 to map to original image.]");

  const directory = await mkdtemp(join(tmpdir(), "rigyn-generic-api-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const extensions = createExtensionRuntime();
  assert.deepEqual(extensions.flagValues, new Map());
  assert.throws(() => extensions.getActiveTools(), /before the session host is bound/u);

  const modelRuntime = await ModelRuntime.create({ models: createModels() });
  assert.deepEqual(modelRuntime.getAll(), []);
});

test("trust presence and credential adapters keep project and auth data bounded", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-generic-storage-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  assert.equal(hasTrustRequiringProjectResources(directory), false);
  await mkdir(join(directory, ".rigyn"));
  await writeFile(join(directory, ".rigyn", "settings.json"), "{}\n");
  assert.equal(hasTrustRequiringProjectResources(directory), true);

  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({
    probe: { kind: "api_key", provider: "probe", apiKey: "secret" },
  }));
  assert.deepEqual(readStoredCredential("probe", authPath), {
    kind: "api_key",
    provider: "probe",
    apiKey: "secret",
  });
  assert.equal(readStoredCredential("missing", authPath), undefined);
});
