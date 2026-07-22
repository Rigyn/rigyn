import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  expandPromptTemplate,
  loadPromptTemplates,
  parseCommandArgs,
  substituteArgs,
} from "../../src/core/prompt-templates.js";

test("command arguments preserve quoted groups", () => {
  assert.deepEqual(parseCommandArgs(`one "two three" 'four five' six`), [
    "one",
    "two three",
    "four five",
    "six",
  ]);
});

test("prompt substitutions support positions, all arguments, defaults, and slices", () => {
  const args = ["one", "two", "three"];
  assert.equal(
    substituteArgs("$1|$2|$4|$@|$ARGUMENTS|${4:-fallback}|${@:2}|${@:2:1}", args),
    "one|two||one two three|one two three|fallback|two three|two",
  );
});

test("template loading is non-recursive, reads metadata, and records scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-prompts-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".rigyn", "prompts", "nested"), { recursive: true });
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await writeFile(join(agentDir, "prompts", "user.md"), "User prompt");
  await writeFile(
    join(cwd, ".rigyn", "prompts", "review.md"),
    "---\ndescription: Review changes\nargument-hint: <path>\n---\nReview $1",
  );
  await writeFile(join(cwd, ".rigyn", "prompts", "nested", "ignored.md"), "Ignored");

  const loaded = loadPromptTemplates({ cwd, agentDir, promptPaths: [], includeDefaults: true });
  assert.deepEqual(loaded.map((template) => template.name), ["user", "review"]);
  assert.equal(loaded[0]?.sourceInfo.scope, "user");
  assert.equal(loaded[1]?.sourceInfo.scope, "project");
  assert.equal(loaded[1]?.description, "Review changes");
  assert.equal(loaded[1]?.argumentHint, "<path>");
});

test("explicit files and symlinked files load, while unknown commands remain unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-prompt-explicit-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const source = join(root, "source.md");
  const link = join(root, "linked.md");
  await writeFile(source, "Hello $1 from {{promptDir}}");
  await symlink(source, link);
  const loaded = loadPromptTemplates({ cwd, agentDir, promptPaths: [link], includeDefaults: false });
  assert.equal(expandPromptTemplate('/linked "world user"', loaded), `Hello world user from ${root}`);
  assert.equal(expandPromptTemplate("/unknown value", loaded), "/unknown value");
  assert.equal(expandPromptTemplate("plain", loaded), "plain");
});

test("substitution covers positional, default, slice, literal, and non-recursive edges", () => {
  const cases: Array<{ template: string; args: string[]; expected: string }> = [
    { template: "$1 $2 $3 $4", args: ["a", "b"], expected: "a b  " },
    { template: "$10 $12", args: Array.from({ length: 12 }, (_, index) => `v${index + 1}`), expected: "v10 v12" },
    { template: "$0", args: ["a"], expected: "" },
    { template: "$1.5", args: ["a"], expected: "a.5" },
    { template: "$@|$ARGUMENTS", args: ["a", "", "c"], expected: "a  c|a  c" },
    { template: "${1:-fallback}", args: [], expected: "fallback" },
    { template: "${1:-fallback}", args: [""], expected: "fallback" },
    { template: "${@:-fallback}", args: [], expected: "fallback" },
    { template: "${3:-$ARGUMENTS}", args: ["a", "b"], expected: "$ARGUMENTS" },
    { template: "${@:0}", args: ["a", "b"], expected: "a b" },
    { template: "${@:2}", args: ["a", "b", "c"], expected: "b c" },
    { template: "${@:2:0}", args: ["a", "b", "c"], expected: "" },
    { template: "${@:2:99}", args: ["a", "b", "c"], expected: "b c" },
    { template: "$ARGUMENTS", args: ["$1", "$ARGUMENTS"], expected: "$1 $ARGUMENTS" },
    { template: "pre$@post", args: ["a", "b"], expected: "prea bpost" },
    { template: "$A $$ $ $ARGS", args: ["a"], expected: "$A $$ $ $ARGS" },
    { template: "Price: \\$100", args: [], expected: "Price: \\" },
  ];
  for (const { template, args, expected } of cases) {
    assert.equal(substituteArgs(template, args), expected, JSON.stringify({ template, args }));
  }
});

test("argument parsing matches the direct command grammar", () => {
  assert.deepEqual(parseCommandArgs("a\n\n\tb  c"), ["a", "b", "c"]);
  assert.deepEqual(parseCommandArgs('"" " "'), [" "]);
  assert.deepEqual(parseCommandArgs('"line1\nline2" second'), ["line1\nline2", "second"]);
  assert.deepEqual(parseCommandArgs('"quoted \\"text\\""'), ["quoted \\text\\"]);
  assert.deepEqual(parseCommandArgs("   a b c   "), ["a", "b", "c"]);
});

test("template expansion accepts multiline arguments", () => {
  const sourceInfo = {
    path: "/tmp/multiline.md",
    source: "local",
    scope: "temporary",
    origin: "top-level",
  } as const;
  const template = {
    name: "multiline",
    description: "test",
    content: "first=$1\nrest=${@:2}",
    sourceInfo,
    filePath: sourceInfo.path,
  };
  assert.equal(
    expandPromptTemplate("/multiline label\n\nA longer description", [template]),
    "first=label\nrest=A longer description",
  );
});
