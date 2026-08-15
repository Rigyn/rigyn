import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EventStream,
  bashExecutionToText,
  formatPromptTemplateInvocation,
  loadPromptTemplates,
  loadSkills,
  type PromptTemplate,
  type Skill,
  truncateHead,
  truncateTail,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";
import {
  addCompleteNormalizedUsage,
  addNormalizedUsage,
  errorMessage,
  estimateMessageTokens,
  isNormalizedUsage,
  normalizedContextTokens,
  normalizedTotalTokens,
  projectMessagesForProvider,
  sumUsageCosts,
  type CanonicalMessage,
} from "../../src/runtime/index.js";

test("context-token accounting requires an exact provider observation", () => {
  assert.equal(normalizedContextTokens({ totalTokens: 120, outputTokens: 20 }), 100);
  assert.equal(normalizedContextTokens({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 }), undefined);
  assert.equal(normalizedContextTokens({ inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 }), 100);
  assert.equal(normalizedContextTokens({ totalTokens: 20, outputTokens: 21 }), undefined);
});

test("provider totals stay exact when component telemetry is incomplete", () => {
  const partial = { inputTokens: 20, outputTokens: 5, totalTokens: 105 };
  assert.equal(isNormalizedUsage(partial), true);
  assert.equal(normalizedTotalTokens(partial), 105);
  assert.equal(normalizedTotalTokens({ inputTokens: 20, outputTokens: 5 }), undefined);
  assert.equal(normalizedTotalTokens({
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
  }), 105);
  assert.equal(isNormalizedUsage({ ...partial, cacheReadTokens: 80, cacheWriteTokens: 0, totalTokens: 106 }), false);
  assert.equal(isNormalizedUsage({ inputTokens: 800, outputTokens: 100, cacheReadTokens: 200, totalTokens: 5 }), false);
  assert.equal(normalizedTotalTokens({ inputTokens: 800, outputTokens: 100, cacheReadTokens: 200, totalTokens: 5 }), undefined);
});

test("incremental usage aggregation drops overflowing counters and costs", () => {
  const tokenOverflow = addNormalizedUsage(
    { inputTokens: Number.MAX_SAFE_INTEGER },
    { inputTokens: 1 },
  );
  assert.deepEqual(tokenOverflow, {});
  assert.equal(isNormalizedUsage(tokenOverflow), true);

  const maximumCost = {
    input: Number.MAX_VALUE,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: Number.MAX_VALUE,
  };
  const costOverflow = addNormalizedUsage({ cost: maximumCost }, { cost: maximumCost });
  assert.deepEqual(costOverflow, {});
  assert.equal(isNormalizedUsage(costOverflow), true);

  const left = {
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
  };
  const right = {
    inputTokens: 0,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1,
  };
  assert.deepEqual(addNormalizedUsage(left, right), {});
  assert.deepEqual(addCompleteNormalizedUsage(left, right), {});
});

test("public usage-cost addition omits a non-finite aggregate", () => {
  const maximum = {
    input: Number.MAX_VALUE,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: Number.MAX_VALUE,
  };
  assert.equal(sumUsageCosts(maximum, maximum), undefined);
});

test("direct message-token estimates saturate at the safe-integer boundary", () => {
  const message: CanonicalMessage = {
    id: "compaction-max-output",
    role: "assistant",
    purpose: "compaction",
    content: [{ type: "text", text: "[Compacted session history]\nsummary" }],
    usage: { outputTokens: Number.MAX_SAFE_INTEGER },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(estimateMessageTokens(message), Number.MAX_SAFE_INTEGER);
});

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

test("error messages never execute arbitrary conversion or property hooks", () => {
  let calls = 0;
  const inherited = Object.assign(Object.create({
    toString() {
      calls += 1;
      return "rewritten";
    },
  }) as Record<string, unknown>, { safe: true });
  assert.equal(errorMessage(inherited), "[Thrown object]");

  let traps = 0;
  const proxied = new Proxy({}, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap executed");
    },
  });
  assert.equal(errorMessage(proxied), "[Thrown object]");

  const accessorError = new Error("original");
  Object.defineProperty(accessorError, "message", {
    get() {
      calls += 1;
      return "rewritten";
    },
  });
  assert.equal(errorMessage(accessorError), "[Thrown Error]");
  assert.equal(calls, 0);
  assert.equal(traps, 0);
});

test("error messages preserve own data messages and safely format primitives", () => {
  assert.equal(errorMessage(new Error("failure")), "failure");
  assert.equal(errorMessage("failure"), "failure");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(undefined), "undefined");
  assert.equal(errorMessage(() => undefined), "[Thrown function]");
});

test("Node execution environment returns results for filesystem, shell, and aborts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  assert.equal((await env.writeFile("nested/a.txt", "one")).ok, true);
  assert.equal((await env.appendFile("nested/a.txt", " two")).ok, true);
  const read = await env.readTextFile("nested/a.txt");
  assert.equal(read.ok, true);
  assert.equal(read.ok ? read.value : undefined, "one two");
  const stdout = nodeCommand('process.stdout.write(process.env.RIGYN_TEST === "yes" && require("node:fs").readFileSync("nested/a.txt", "utf8") === "one two" ? "hello" : "missing")');
  const stderr = nodeCommand('process.stdout.write("err")');
  const shell = await env.exec(
    `${stdout} && ${stderr} 1>&2`,
    { env: { RIGYN_TEST: "yes" } },
  );
  assert.equal(shell.ok, true);
  if (shell.ok) assert.deepEqual({ stdout: shell.value.stdout, stderr: shell.value.stderr, exitCode: shell.value.exitCode }, { stdout: "hello", stderr: "err", exitCode: 0 });
  const controller = new AbortController(); controller.abort();
  const missing = await env.readTextFile("missing", controller.signal);
  assert.equal(!missing.ok && missing.error.code, "aborted");
});

test("skills and prompt templates load with frontmatter and invocation substitution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const promptsRoot = join(root, "prompts");
  const skillsRoot = join(root, "skills");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.createDir(promptsRoot, { recursive: true });
  await env.createDir(skillsRoot, { recursive: true });
  await writeFile(join(promptsRoot, "template.md"), "---\ndescription: Template\n---\nHello $1 $@");
  await writeFile(join(skillsRoot, "SKILL.md"), "---\nname: resources\ndescription: Resource work\n---\nInstructions");
  const templates = await loadPromptTemplates(env, promptsRoot);
  const promptTemplates: PromptTemplate[] = [...templates.promptTemplates];
  assert.equal(promptTemplates.length, 1);
  assert.equal(formatPromptTemplateInvocation(promptTemplates[0]!, ["A", "B"]), "Hello A A B");
  const skills = await loadSkills(env, skillsRoot);
  const loadedSkills: Skill[] = [...skills.skills];
  assert.equal(loadedSkills[0]?.name, "resources");
});

test("truncation preserves UTF-8 boundaries", () => {
  const head = truncateHead("😀😀\nlast", { maxBytes: 8, maxLines: 10 });
  assert.equal(head.content, "😀😀");
  const tail = truncateTail("first\n😀😀😀", { maxBytes: 8, maxLines: 10 });
  assert.equal(tail.lastLinePartial, true);
});

test("EventStream resolves terminal results and ends iteration", async () => {
  const stream = new EventStream<{ done: boolean; value: number }, number>((event) => event.done, (event) => event.value);
  stream.push({ done: false, value: 1 }); stream.push({ done: true, value: 2 });
  const values: number[] = []; for await (const event of stream) values.push(event.value);
  assert.deepEqual(values, [1, 2]); assert.equal(await stream.result(), 2);
});

test("context conversion explains retained shell output and withheld images", () => {
  const shell = bashExecutionToText({
    timestamp: 1,
    role: "bashExecution",
    command: "fixture",
    output: "partial",
    cancelled: false,
    truncated: true,
    exitCode: 0,
    fullOutputPath: "/tmp/complete.log",
  });
  assert.match(shell, /\[Output shortened\. Complete transcript: \/tmp\/complete\.log\]/u);
  assert.match(
    bashExecutionToText({
      timestamp: 1,
      role: "bashExecution",
      command: "fixture",
      output: "partial",
      cancelled: false,
      truncated: false,
      exitCode: 7,
    }),
    /Command returned status 7/u,
  );
  assert.match(
    bashExecutionToText({
      timestamp: 1,
      role: "bashExecution",
      command: "slow fixture",
      output: "partial",
      isError: true,
      cancelled: false,
      timedOut: true,
      truncated: false,
      exitCode: undefined,
    }),
    /\[Command timed out\]/u,
  );
  assert.match(
    bashExecutionToText({
      timestamp: 1,
      role: "bashExecution",
      command: "signal fixture",
      output: "partial",
      isError: true,
      cancelled: false,
      signal: "SIGTERM",
      truncated: false,
      exitCode: undefined,
    }),
    /\[Command stopped after signal SIGTERM\]/u,
  );

  const messages: CanonicalMessage[] = [
    {
      id: "user-image",
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: "private" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "assistant-call",
      role: "assistant",
      content: [{ type: "tool_call", callId: "read-image", name: "read", arguments: {} }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      id: "tool-image",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "read-image",
        name: "read",
        content: "attached",
        isError: false,
        images: [{ type: "image", mediaType: "image/png", data: "private" }],
      }],
      createdAt: "2026-01-01T00:00:02.000Z",
    },
  ];
  const projected = projectMessagesForProvider(messages, "fixture", { supportsImages: false });
  assert.equal(projected[0]?.content[0]?.type === "text" ? projected[0].content[0].text : "", "(image withheld: selected model accepts text only)");
  assert.equal(
    projected[2]?.content[0]?.type === "tool_result" ? projected[2].content[0].content : "",
    "attached\n(tool image withheld: selected model accepts text only)",
  );
});
