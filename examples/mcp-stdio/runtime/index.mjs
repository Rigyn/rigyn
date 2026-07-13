import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 5_000;
const SERVER_PATH = fileURLToPath(new URL("./server.mjs", import.meta.url));

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function activate(api) {
  let child;
  let starting;
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const pending = new Map();

  function settle(id, operation) {
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    operation(request);
  }

  function rejectPending(cause) {
    for (const id of [...pending.keys()]) settle(id, (request) => request.reject(cause));
  }

  function failProtocol(cause) {
    rejectPending(cause);
    child?.kill();
  }

  function acceptLine(line) {
    if (line.trim() === "") return;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      failProtocol(new Error("MCP server returned a frame larger than 64 KiB"));
      return;
    }
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      failProtocol(new Error("MCP server returned invalid JSON"));
      return;
    }
    if (response === null || typeof response !== "object" || Array.isArray(response)) return;
    if (!Number.isSafeInteger(response.id)) return;
    if (response.error !== undefined) {
      const detail = response.error !== null && typeof response.error === "object"
        && typeof response.error.message === "string"
        ? response.error.message
        : "MCP request failed";
      settle(response.id, (request) => request.reject(new Error(detail)));
      return;
    }
    settle(response.id, (request) => request.resolve(response.result));
  }

  function attach(process) {
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_FRAME_BYTES && !stdout.includes("\n")) {
        stdout = "";
        rejectPending(new Error("MCP server returned an unterminated frame larger than 64 KiB"));
        process.kill();
        return;
      }
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        acceptLine(line);
      }
    });
    process.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) >= MAX_STDERR_BYTES) return;
      stderr = `${stderr}${chunk}`.slice(0, MAX_STDERR_BYTES);
    });
    process.on("error", (cause) => rejectPending(cause));
    process.on("exit", (code, signal) => {
      if (child === process) child = undefined;
      const detail = stderr.trim();
      rejectPending(new Error(
        `MCP server exited (${signal ?? code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`,
      ));
    });
  }

  function write(payload) {
    const process = child;
    if (process?.stdin.writable !== true) throw new Error("MCP server stdin is unavailable");
    const frame = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("MCP request exceeds 64 KiB");
    process.stdin.write(frame);
  }

  function send(method, params, signal) {
    signal?.throwIfAborted();
    if (pending.size >= MAX_PENDING_REQUESTS) throw new Error("MCP request limit reached");
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const abort = () => settle(id, (request) => request.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      ));
      const timer = setTimeout(
        () => settle(id, (request) => request.reject(new Error(`MCP ${method} timed out`))),
        REQUEST_TIMEOUT_MS,
      );
      timer.unref();
      pending.set(id, { resolve, reject, signal, abort, timer });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        write({ jsonrpc: "2.0", id, method, params });
      } catch (cause) {
        settle(id, (request) => request.reject(cause));
      }
    });
  }

  async function start(signal) {
    if (starting !== undefined) return await starting;
    if (child?.exitCode === null && child.signalCode === null) return;
    starting = (async () => {
      signal?.throwIfAborted();
      stdout = "";
      stderr = "";
      const spawned = spawn(process.execPath, [SERVER_PATH], {
        cwd: api.workspace,
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child = spawned;
      attach(spawned);
      const initialized = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: api.extensionId, version: "1.0.0" },
      }, signal);
      if (initialized === null || typeof initialized !== "object"
        || initialized.serverInfo?.name !== "fixed-gallery-mcp") {
        throw new Error("MCP server returned an unexpected initialize result");
      }
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
      const catalog = await send("tools/list", {}, signal);
      if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.tools)
        || !catalog.tools.some((tool) => tool?.name === "reverse_text")) {
        throw new Error("MCP server did not advertise reverse_text");
      }
    })();
    try {
      await starting;
    } catch (cause) {
      await stop();
      throw cause;
    } finally {
      starting = undefined;
    }
  }

  async function stop() {
    const process = child;
    child = undefined;
    if (process === undefined) return;
    rejectPending(new Error("MCP server stopped"));
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = new Promise((resolve) => process.once("exit", resolve));
    process.stdin.end();
    process.kill();
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref();
    });
    await Promise.race([exited, timeout]);
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
      await exited;
    }
  }

  api.onDispose(stop);

  api.registerTool({
    name: "mcp_reverse_text",
    description: "Reverse text through the package's fixed local MCP stdio server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    async execute(input, context) {
      try {
        await start(context.signal);
        const result = await send("tools/call", {
          name: "reverse_text",
          arguments: { text: input.text },
        }, context.signal);
        const text = result !== null && typeof result === "object" && Array.isArray(result.content)
          ? result.content.find((entry) => entry?.type === "text" && typeof entry.text === "string")?.text
          : undefined;
        if (typeof text !== "string") throw new Error("MCP reverse_text returned no text content");
        return {
          content: JSON.stringify({ text }),
          isError: result.isError === true,
          status: result.isError === true ? "error" : "success",
          summary: result.isError === true
            ? "The MCP reverse_text tool reported an error."
            : "Reversed text through the fixed MCP stdio server.",
          nextActions: result.isError === true ? ["Inspect the MCP server result and retry with valid text."] : [],
          metadata: { serverPid: child?.pid ?? null },
        };
      } catch (cause) {
        context.signal.throwIfAborted();
        return {
          content: `MCP request failed: ${message(cause).slice(0, 1024)}`,
          isError: true,
          status: "error",
          summary: "The fixed MCP stdio request failed.",
          nextActions: ["Retry once; stop if the fixed server cannot initialize or advertise reverse_text."],
        };
      }
    },
  });
}
