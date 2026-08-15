import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const STATE_FILE = "workspace-state.json";
const MAX_STATE_BYTES = 256 * 1024;
const MAX_ITEMS = 64;
const MAX_TEXT_LENGTH = 2_048;
const protectedNames = new Set([".env", ".git", ".ssh", "auth.json"]);

function policyEnabled(snapshot) {
  if (snapshot.value === undefined) return true;
  const value = snapshot.value;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== 1
    || typeof value.protectPaths !== "boolean"
  ) throw new Error("Workspace policy configuration has an invalid shape");
  return value.protectPaths;
}

async function readPolicy(rigyn, signal) {
  const snapshot = await rigyn.config.read("workspace", { signal });
  return { enabled: policyEnabled(snapshot), snapshot };
}

async function replacePolicy(rigyn, protectPaths, signal) {
  const { snapshot } = await readPolicy(rigyn, signal);
  return await rigyn.config.replace(
    "workspace",
    { version: 1, protectPaths },
    { expectedRevision: snapshot.revision, signal },
  );
}

function emptyState() {
  return { version: 1, nextId: 1, memories: [], tasks: [] };
}

function validItem(value, completed = false) {
  return value !== null
    && typeof value === "object"
    && Number.isSafeInteger(value.id)
    && value.id > 0
    && typeof value.text === "string"
    && value.text.length > 0
    && value.text.length <= MAX_TEXT_LENGTH
    && (!completed || typeof value.completed === "boolean");
}

function validatedState(value) {
  if (
    value === null
    || typeof value !== "object"
    || value.version !== 1
    || !Number.isSafeInteger(value.nextId)
    || value.nextId < 1
    || !Array.isArray(value.memories)
    || !Array.isArray(value.tasks)
    || value.memories.length > MAX_ITEMS
    || value.tasks.length > MAX_ITEMS
    || !value.memories.every((item) => validItem(item))
    || !value.tasks.every((item) => validItem(item, true))
  ) throw new Error("Workspace state has an invalid shape");
  return structuredClone(value);
}

async function readState(directory) {
  const path = join(directory, STATE_FILE);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) {
      throw new Error("Workspace state exceeds its file limit");
    }
    return validatedState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeState(directory, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(validatedState(value), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Workspace state exceeds its file limit");
  }
  await writeFile(join(directory, STATE_FILE), serialized, { encoding: "utf8", mode: 0o600 });
}

function requiredText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text must contain 1 to ${MAX_TEXT_LENGTH} characters`);
  }
  return text;
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  };
}

async function canonicalTarget(path) {
  let current = path;
  const suffix = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function leavesWorkspace(workspaceRelative) {
  return workspaceRelative === ""
    || workspaceRelative === ".."
    || workspaceRelative.startsWith("../")
    || workspaceRelative.startsWith("..\\")
    || isAbsolute(workspaceRelative);
}

function hasProtectedName(value) {
  return value.split(/[\\/]/u).some((part) => protectedNames.has(part.toLowerCase()))
    || protectedNames.has(basename(value).toLowerCase());
}

async function isProtectedPath(cwd, value) {
  if (typeof value !== "string" || value.includes("\0")) return true;
  try {
    const absolute = resolve(cwd, value);
    const workspaceRelative = relative(resolve(cwd), absolute);
    const canonicalWorkspace = await realpath(cwd);
    const canonical = await canonicalTarget(absolute);
    const canonicalRelative = relative(canonicalWorkspace, canonical);
    return leavesWorkspace(workspaceRelative)
      || leavesWorkspace(canonicalRelative)
      || hasProtectedName(workspaceRelative)
      || hasProtectedName(canonicalRelative);
  } catch {
    return true;
  }
}

export default function activate(rigyn) {
  rigyn.registerTool({
    name: "example_memory",
    label: "Workspace memory",
    description: "Explicitly save or recall bounded notes for this workspace.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["remember", "recall"] },
        text: { type: "string", maxLength: MAX_TEXT_LENGTH },
        query: { type: "string", maxLength: 256 },
      },
    },
    async execute(_callId, input, _signal, _onUpdate, context) {
      const state = await readState(context.paths.workspaceData);
      if (input.action === "remember") {
        const memory = { id: state.nextId, text: requiredText(input.text) };
        state.nextId += 1;
        state.memories.push(memory);
        if (state.memories.length > MAX_ITEMS) state.memories.shift();
        await writeState(context.paths.workspaceData, state);
        return result({ saved: memory });
      }
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const memories = query === ""
        ? state.memories
        : state.memories.filter((memory) => memory.text.toLowerCase().includes(query));
      return result({ memories });
    },
  });

  rigyn.registerTool({
    name: "example_tasks",
    label: "Workspace tasks",
    description: "Add, complete, or list bounded workspace task state.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["add", "complete", "list"] },
        text: { type: "string", maxLength: MAX_TEXT_LENGTH },
        id: { type: "integer", minimum: 1 },
      },
    },
    async execute(_callId, input, _signal, _onUpdate, context) {
      const state = await readState(context.paths.workspaceData);
      if (input.action === "add") {
        if (state.tasks.length >= MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} tasks are retained`);
        const task = { id: state.nextId, text: requiredText(input.text), completed: false };
        state.nextId += 1;
        state.tasks.push(task);
        await writeState(context.paths.workspaceData, state);
        return result({ added: task });
      }
      if (input.action === "complete") {
        if (!Number.isSafeInteger(input.id) || input.id < 1) throw new Error("id must be a positive integer");
        const task = state.tasks.find((candidate) => candidate.id === input.id);
        if (task === undefined) throw new Error(`Task not found: ${input.id}`);
        task.completed = true;
        await writeState(context.paths.workspaceData, state);
        return result({ completed: task });
      }
      return result({ tasks: state.tasks });
    },
  });

  rigyn.registerCommand("example-state", {
    description: "Show workspace memory and task counts",
    async handler(_args, context) {
      const state = await readState(context.paths.workspaceData);
      const open = state.tasks.filter((task) => !task.completed).length;
      context.ui.notify(`${state.memories.length} memories, ${open} open tasks`, "info");
    },
  });

  rigyn.registerCommand("example-policy", {
    description: "Inspect or replace the workspace path policy with a compare-and-swap write",
    async handler(args, context) {
      const requested = args.trim().toLowerCase();
      if (requested === "") {
        const { enabled } = await readPolicy(rigyn, context.signal);
        context.ui.notify(`Protected-path policy: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      if (requested !== "on" && requested !== "off") {
        context.ui.notify("Usage: /example-policy [on|off]", "warning");
        return;
      }
      await replacePolicy(rigyn, requested === "on", context.signal);
      context.ui.notify(`Protected-path policy: ${requested}`, "info");
    },
  });

  rigyn.on("tool_call", async (event, context) => {
    if (
      (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit")
      && (await readPolicy(rigyn, context.signal)).enabled
      && await isProtectedPath(context.cwd, event.input.path)
    ) {
      return { block: true, reason: "The example policy blocks protected or out-of-workspace paths." };
    }
  });
}
