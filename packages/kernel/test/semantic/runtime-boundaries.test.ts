import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  executeShellWithCapture,
  formatPromptTemplateInvocation,
  formatSkillsForSystemPrompt,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";

async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

test("resource and prompt formatting escape metadata and expand supported argument forms", () => {
  const formatted = formatSkillsForSystemPrompt([{
    name: "read<&\"'",
    description: "use > carefully",
    content: "not embedded",
    filePath: "/tmp/<skill>&.md",
  }]);
  assert.match(formatted, /<name>read&lt;&amp;&quot;&apos;<\/name>/u);
  assert.match(formatted, /<description>use &gt; carefully<\/description>/u);
  assert.match(formatted, /<location>\/tmp\/&lt;skill&gt;&amp;\.md<\/location>/u);
  assert.doesNotMatch(formatted, /not embedded/u);

  assert.equal(formatPromptTemplateInvocation({ content: "$1|$2|$@|${@:2}|${@:2:2}" }, ["one", "two", "three"]), "one|two|one two three|two three|two three");
});

test("Node execution cancellation settles as aborted", async (t) => {
  const root = await temp(t, "rigyn-agent-cancel-");
  const env = new NodeExecutionEnv({ cwd: root });
  const controller = new AbortController();
  const startedAt = performance.now();
  const running = env.exec(nodeCommand("setTimeout(()=>{},10000)"), { abortSignal: controller.signal });
  controller.abort();
  const result = await running;
  assert.equal(!result.ok && result.error.code, "aborted");
  assert.equal(performance.now() - startedAt < 3_000, true, "cancellation did not settle promptly");
});

test("shell capture ignores output callbacks after execution settles", async (t) => {
  const root = await temp(t, "rigyn-agent-late-output-");
  const files = new NodeExecutionEnv({ cwd: root });
  let onStdout: ((chunk: string) => void) | undefined;
  const env = new Proxy(files, {
    get(target, property, receiver) {
      if (property !== "exec") return Reflect.get(target, property, receiver);
      return async (_command: string, options: ShellExecOptions = {}): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, never>> => {
        onStdout = options.onStdout;
        options.onStdout?.("before\n");
        return { ok: true, value: { stdout: "before\n", stderr: "", exitCode: 0 } };
      };
    },
  }) as ExecutionEnv;
  const observed: string[] = [];

  const captured = await executeShellWithCapture(env, "ignored", { onChunk: (chunk) => observed.push(chunk) });
  onStdout?.("after\n");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(captured.ok && captured.value.output, "before\n");
  assert.deepEqual(observed, ["before\n"]);
  if (captured.ok && captured.value.fullOutputPath) {
    assert.doesNotMatch(await readFile(captured.value.fullOutputPath, "utf8"), /after/u);
  }
});

test("shell capture contains hostile execution environment rejections", async (t) => {
  const root = await temp(t, "rigyn-agent-hostile-execution-");
  const files = new NodeExecutionEnv({ cwd: root });
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
  });
  const env = new Proxy(files, {
    get(target, property, receiver) {
      if (property !== "exec") return Reflect.get(target, property, receiver);
      return async () => { throw hostile; };
    },
  }) as ExecutionEnv;

  const captured = await executeShellWithCapture(env, "ignored");

  assert.equal(captured.ok, false);
  assert.equal(captured.ok ? undefined : captured.error.code, "unknown");
  assert.equal(captured.ok ? undefined : captured.error.message, "[Thrown object]");
  assert.equal(traps, 0);
});
