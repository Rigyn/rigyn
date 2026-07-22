import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_TIMEOUT_MS = 120_000;
const MAX_AGENTS = 16;
const MAX_TASKS = 4;
const MAX_TASK_BYTES = 16 * 1024;
const MAX_CHAIN_CONTEXT_BYTES = 16 * 1024;
const MAX_AGENT_INSTRUCTIONS_BYTES = 16 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_NOTICE_BYTES = 128 * 1024;
const AGENTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/u;
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

function utf8Prefix(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result;
}

function parseAgentDefinition(source, sourceName) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  if (match === null) throw new Error(`Agent definition ${sourceName} must contain frontmatter`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Agent definition ${sourceName} has invalid frontmatter`);
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  const tools = (fields.get("tools") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const instructions = match[2].trim();
  if (typeof name !== "string" || !AGENT_NAME.test(name)) {
    throw new Error(`Agent definition ${sourceName} has an invalid name`);
  }
  if (typeof description !== "string" || description === "" || Buffer.byteLength(description, "utf8") > 512) {
    throw new Error(`Agent definition ${sourceName} has an invalid description`);
  }
  if (tools.length === 0 || tools.some((tool) => !TOOL_NAME.test(tool))) {
    throw new Error(`Agent definition ${sourceName} must declare valid tools`);
  }
  if (instructions === "" || Buffer.byteLength(instructions, "utf8") > MAX_AGENT_INSTRUCTIONS_BYTES) {
    throw new Error(`Agent definition ${sourceName} has invalid instructions`);
  }
  return { name, description, tools, instructions };
}

async function discoverAgents() {
  const entries = (await readdir(AGENTS_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0 || entries.length > MAX_AGENTS) {
    throw new Error(`Expected 1 to ${MAX_AGENTS} agent definitions`);
  }
  const agents = await Promise.all(entries.map(async (entry) =>
    parseAgentDefinition(await readFile(join(AGENTS_DIRECTORY, entry.name), "utf8"), entry.name)));
  if (new Set(agents.map((agent) => agent.name)).size !== agents.length) {
    throw new Error("Agent definition names must be unique");
  }
  return agents;
}

function usageValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageCost(value) {
  if (value === null || typeof value !== "object") return undefined;
  const input = value.input;
  const output = value.output;
  const cacheRead = value.cacheRead;
  const cacheWrite = value.cacheWrite;
  if (![input, output, cacheRead, cacheWrite].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)) {
    return undefined;
  }
  const total = input + output + cacheRead + cacheWrite;
  if (typeof value.total !== "number" || Math.abs(value.total - total) > Math.max(1e-12, Math.abs(total) * 1e-9)) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function assistantUsage(value) {
  if (value === null || typeof value !== "object") return undefined;
  const input = usageValue(value.input);
  const output = usageValue(value.output);
  const cacheRead = usageValue(value.cacheRead);
  const cacheWrite = usageValue(value.cacheWrite);
  const cost = usageCost(value.cost);
  if ([input, output, cacheRead, cacheWrite, cost].some((part) => part === undefined)) return undefined;
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (usageValue(value.totalTokens) !== totalTokens) return undefined;
  const cacheWrite1h = value.cacheWrite1h === undefined ? undefined : usageValue(value.cacheWrite1h);
  const reasoning = value.reasoning === undefined ? undefined : usageValue(value.reasoning);
  if (cacheWrite1h === undefined && value.cacheWrite1h !== undefined) return undefined;
  if (reasoning === undefined && value.reasoning !== undefined) return undefined;
  if (cacheWrite1h !== undefined && cacheWrite1h > cacheWrite) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens,
    cost,
  };
}

function addUsage(left, right) {
  if (left === undefined) return structuredClone(right);
  const input = left.input + right.input;
  const output = left.output + right.output;
  const cacheRead = left.cacheRead + right.cacheRead;
  const cacheWrite = left.cacheWrite + right.cacheWrite;
  const cacheWrite1h = (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0);
  const reasoning = (left.reasoning ?? 0) + (right.reasoning ?? 0);
  const cost = {
    input: left.cost.input + right.cost.input,
    output: left.cost.output + right.cost.output,
    cacheRead: left.cost.cacheRead + right.cost.cacheRead,
    cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
  };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...((left.cacheWrite1h === undefined && right.cacheWrite1h === undefined) ? {} : { cacheWrite1h }),
    ...((left.reasoning === undefined && right.reasoning === undefined) ? {} : { reasoning }),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
  };
}

function assistantReport(stdout) {
  if (Buffer.byteLength(stdout, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
    throw new Error("worker event stream exceeded the output limit");
  }
  let finalMessage;
  let usage;
  let turns = 0;
  let events = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    events += 1;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error("worker emitted invalid JSON event data"); }
    if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
    finalMessage = event.message;
    turns += 1;
    const observed = assistantUsage(event.message.usage);
    if (observed !== undefined) usage = addUsage(usage, observed);
  }
  if (!finalMessage || !Array.isArray(finalMessage.content)) {
    throw new Error("worker did not emit a final assistant message");
  }
  const text = finalMessage.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (text.trim() === "") throw new Error("worker returned an empty response");
  return {
    text: utf8Prefix(text, MAX_RESULT_BYTES),
    turns,
    events,
    ...(usage === undefined ? {} : { usage }),
    ...(typeof finalMessage.stopReason === "string" ? { stopReason: finalMessage.stopReason } : {}),
    ...(typeof finalMessage.errorMessage === "string" ? { errorMessage: finalMessage.errorMessage } : {}),
  };
}

function workerArguments(cliEntry, agent, task) {
  const prompt = [
    `You are the ${agent.name} specialist in a bounded delegated run.`,
    agent.instructions,
    "Return a concise standalone report for the parent agent.",
    "",
    `Task: ${task}`,
  ].join("\n");
  return [
    cliEntry,
    "--no-session",
    "--no-extensions",
    "--print",
    "--mode", "json",
    "--tools", agent.tools.join(","),
    "--max-steps", "24",
    "--thinking", "low",
    prompt,
  ];
}

function failedReport(agent, task, message, report) {
  return {
    name: agent.name,
    task,
    ok: false,
    text: utf8Prefix(message, MAX_RESULT_BYTES),
    turns: report?.turns ?? 0,
    events: report?.events ?? 0,
    ...(report?.usage === undefined ? {} : { usage: report.usage }),
  };
}

async function runWorker(rigyn, cliEntry, agent, task, cwd, signal) {
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES + MAX_CHAIN_CONTEXT_BYTES) {
    return failedReport(agent, task, "worker task exceeded the input limit");
  }
  signal?.throwIfAborted();
  let result;
  try {
    result = await rigyn.exec(process.execPath, workerArguments(cliEntry, agent, task), {
      cwd,
      signal,
      timeout: CHILD_TIMEOUT_MS,
    });
  } catch (error) {
    signal?.throwIfAborted();
    return failedReport(agent, task, error instanceof Error ? error.message : String(error));
  }
  signal?.throwIfAborted();
  let report;
  try { report = assistantReport(result.stdout); }
  catch (error) {
    const detail = utf8Prefix(result.stderr.trim(), 2048);
    return failedReport(agent, task, detail || (error instanceof Error ? error.message : String(error)));
  }
  const stoppedWithError = ["error", "aborted", "cancelled"].includes(report.stopReason);
  if (result.code !== 0 || result.killed || stoppedWithError) {
    const detail = report.errorMessage || utf8Prefix(result.stderr.trim(), 2048) || report.text || `worker exited with code ${result.code}`;
    return failedReport(agent, task, detail, report);
  }
  return { name: agent.name, task, ok: true, ...report };
}

function progressDetails(mode, completed, total, reports) {
  return {
    mode,
    completed,
    total,
    results: reports.map((report) => ({
      name: report.name,
      ok: report.ok,
      turns: report.turns,
      events: report.events,
      outputBytes: Buffer.byteLength(report.text, "utf8"),
      ...(report.usage === undefined ? {} : { usage: report.usage }),
    })),
  };
}

function aggregateUsage(reports) {
  let usage;
  for (const report of reports) {
    if (report.usage !== undefined) usage = addUsage(usage, report.usage);
  }
  return usage;
}

function finalResult(mode, agents, reports) {
  const report = reports.map((result, index) => [
    `## ${mode === "chain" ? `Step ${index + 1}: ` : ""}${result.name} — ${result.ok ? "complete" : "failed"}`,
    result.text,
  ].join("\n")).join("\n\n");
  const usage = aggregateUsage(reports);
  return {
    content: [{ type: "text", text: utf8Prefix(report, MAX_NOTICE_BYTES) }],
    details: {
      mode,
      availableAgents: agents.map((agent) => ({ name: agent.name, description: agent.description })),
      succeeded: reports.filter((result) => result.ok).length,
      total: reports.length,
      results: reports,
      ...(usage === undefined ? {} : { usage }),
    },
    ...(usage === undefined ? {} : { usage }),
  };
}

function selectedMode(input) {
  const hasAgent = typeof input.agent === "string";
  const hasTask = typeof input.task === "string";
  if (hasAgent !== hasTask) throw new Error("Single mode requires both agent and task");
  const single = hasAgent && hasTask;
  const parallel = Array.isArray(input.tasks) && input.tasks.length > 0;
  const chain = Array.isArray(input.chain) && input.chain.length > 0;
  if (Number(single) + Number(parallel) + Number(chain) !== 1) {
    throw new Error("Provide exactly one of agent + task, tasks, or chain");
  }
  if (single) return { mode: "single", tasks: [{ agent: input.agent, task: input.task }] };
  if (parallel) return { mode: "parallel", tasks: input.tasks };
  return { mode: "chain", tasks: input.chain };
}

async function executeMode(rigyn, cliEntry, agents, selection, cwd, signal, onProgress) {
  if (selection.tasks.length > MAX_TASKS) throw new Error(`At most ${MAX_TASKS} delegated tasks are allowed`);
  for (const task of selection.tasks) {
    if (Buffer.byteLength(task.task, "utf8") > MAX_TASK_BYTES) throw new Error("A delegated task exceeded the input limit");
  }
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const completed = [];
  const run = async (task) => {
    const agent = byName.get(task.agent);
    const result = agent === undefined
      ? failedReport({ name: task.agent }, task.task, `Unknown agent: ${task.agent}`)
      : await runWorker(rigyn, cliEntry, agent, task.task, cwd, signal);
    completed.push(result);
    onProgress?.(progressDetails(selection.mode, completed.length, selection.tasks.length, completed));
    return result;
  };
  let reports;
  if (selection.mode === "parallel") {
    reports = await Promise.all(selection.tasks.map(run));
  } else if (selection.mode === "chain") {
    reports = [];
    let previous = "";
    for (const task of selection.tasks) {
      const chainedTask = previous === ""
        ? task.task
        : `${task.task}\n\nPrevious worker report:\n${utf8Prefix(previous, MAX_CHAIN_CONTEXT_BYTES)}`;
      const result = await run({ ...task, task: chainedTask });
      reports.push(result);
      if (!result.ok) break;
      previous = result.text;
    }
  } else {
    reports = [await run(selection.tasks[0])];
  }
  return finalResult(selection.mode, agents, reports);
}

const taskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "task"],
  properties: {
    agent: { type: "string", minLength: 1, maxLength: 32 },
    task: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
  },
};

export default async function activate(rigyn) {
  const initialAgents = await discoverAgents();
  rigyn.registerTool({
    name: "example_subagent",
    label: "Delegate to a specialist",
    description: `Run isolated package-defined specialists. Available agents: ${initialAgents.map((agent) => `${agent.name} (${agent.description})`).join(", ")}.`,
    promptGuidelines: ["Use single mode for one focused task, parallel mode for independent tasks, and chain mode when later work needs the prior report."],
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agent: { type: "string", minLength: 1, maxLength: 32 },
        task: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
        tasks: { type: "array", minItems: 1, maxItems: MAX_TASKS, items: taskSchema },
        chain: { type: "array", minItems: 1, maxItems: MAX_TASKS, items: taskSchema },
      },
    },
    async execute(_callId, input, signal, onUpdate, context) {
      const agents = await discoverAgents();
      const cliEntry = process.argv[1];
      if (typeof cliEntry !== "string" || cliEntry === "") throw new Error("The active Rigyn CLI entry point is unavailable");
      return await executeMode(rigyn, cliEntry, agents, selectedMode(input), context.cwd, signal ?? context.signal, (details) => {
        onUpdate?.({
          content: [{ type: "text", text: `Delegated tasks complete: ${details.completed}/${details.total}` }],
          details,
        });
      });
    },
  });

  rigyn.registerCommand("example-workers", {
    description: "Run every discovered specialist in parallel and combine their bounded reports",
    async handler(args, context) {
      const task = args.trim();
      if (task === "") {
        context.ui.notify("Usage: /example-workers TASK", "warning");
        return;
      }
      if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
        context.ui.notify("The worker task is too large.", "error");
        return;
      }
      const cliEntry = process.argv[1];
      if (typeof cliEntry !== "string" || cliEntry === "") {
        context.ui.notify("The active Rigyn CLI entry point is unavailable.", "error");
        return;
      }

      const agents = await discoverAgents();
      context.ui.setWorkingVisible(true);
      context.ui.setWorkingMessage(`Starting ${agents.length} isolated workers…`);
      try {
        const result = await executeMode(rigyn, cliEntry, agents, {
          mode: "parallel",
          tasks: agents.map((agent) => ({ agent: agent.name, task })),
        }, context.cwd, context.signal, (details) => {
          context.ui.setWorkingMessage(`Workers complete: ${details.completed}/${details.total}`);
        });
        const text = result.content[0]?.text ?? "No worker output";
        context.ui.notify(text, result.details.succeeded === result.details.total ? "info" : "warning");
      } finally {
        context.ui.setWorkingMessage(undefined);
        context.ui.setWorkingVisible(false);
      }
    },
  });
}
