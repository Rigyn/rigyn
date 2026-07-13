import {
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ShellTool,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
  WriteTool,
  type HarnessTool,
} from "../tools/index.js";
import { DirectProcessRunner } from "../process/index.js";
import { isJsonValue, type JsonValue } from "../core/json.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

interface WorkerRequest {
  schemaVersion: 1;
  tool: string;
  input: JsonValue;
  workspace: string;
}

async function readRequest(): Promise<WorkerRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error(`Backend request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Backend request is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Backend request must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["schemaVersion", "tool", "input", "workspace"].includes(key)) ||
    record.schemaVersion !== 1 ||
    typeof record.tool !== "string" ||
    typeof record.workspace !== "string" ||
    !isJsonValue(record.input)
  ) {
    throw new Error("Backend request does not match protocol version 1");
  }
  return record as unknown as WorkerRequest;
}

function selectedTool(name: string): HarnessTool {
  if (name === "read") return new ReadTool();
  if (name === "write") return new WriteTool();
  if (name === "edit") return new EditTool();
  if (name === "grep") return new GrepTool();
  if (name === "find") return new FindTool();
  if (name === "ls") return new LsTool();
  if (name === "bash" || name === "shell") return new ShellTool(name);
  throw new Error(`Backend tool is not supported: ${name}`);
}

async function main(): Promise<void> {
  const request = await readRequest();
  const tool = selectedTool(request.tool);
  const workspace = await WorkspaceBoundary.create(request.workspace);
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]), {}, undefined, {}, {
    activeTools: [request.tool],
  });
  const [completed] = await coordinator.execute([{
    callId: "external-backend-call",
    name: request.tool,
    input: request.input,
    index: 0,
  }], {
    workspace,
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "external-backend-run",
    threadId: "external-backend-thread",
  });
  if (completed === undefined) throw new Error("Backend tool did not return a result");
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: completed.result })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replaceAll("\0", "�").slice(0, 4096)}\n`);
  process.exitCode = 1;
});
