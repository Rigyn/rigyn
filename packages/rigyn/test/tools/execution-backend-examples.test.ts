import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { linuxContainerCommand } from "../../examples/execution-backends/linux-container.mjs";
import { remoteSshCommand } from "../../examples/execution-backends/remote-ssh.mjs";
import { executeRelay, MAX_RESPONSE_BYTES, parseRequest } from "../../examples/execution-backends/relay.mjs";

async function fakeExecutor(root: string): Promise<string> {
  const path = join(root, "fake-executor.mjs");
  await writeFile(path, String.raw`
import { readFileSync, writeSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
writeSync(1, JSON.stringify({
  schemaVersion: 1,
  result: {
    content: "relayed",
    isError: false,
    status: "success",
    metadata: { argv: process.argv.slice(2), request, environment: Object.keys(process.env) }
  }
}));
`);
  return path;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {}
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

test("Linux container adapter uses a fixed locked-down container invocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-container-adapter-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const argv = linuxContainerCommand([
    "--engine", process.execPath,
    "--image", "example.invalid/rigyn-worker@sha256:abc123",
    "--host-workspace", root,
  ]);
  assert.ok(argv.includes("--network=none"));
  assert.ok(argv.includes("--read-only"));
  assert.ok(argv.includes("--cap-drop=ALL"));
  assert.ok(argv.includes(`type=bind,src=${root},dst=/workspace,rw`));
});

test("remote adapter fixes SSH identity, host verification, forwarding, and worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-remote-adapter-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const identity = join(root, "identity");
  const knownHosts = join(root, "known-hosts");
  await writeFile(identity, "fixture", "utf8");
  await writeFile(knownHosts, "fixture", "utf8");
  const command = remoteSshCommand([
    "--ssh", process.execPath,
    "--host", "worker@example.invalid",
    "--identity", identity,
    "--known-hosts", knownHosts,
    "--remote-node", "/usr/bin/node",
    "--remote-worker", "/opt/rigyn/bin/tool-backend-worker",
    "--remote-workspace", "/srv/workspace",
  ]);
  assert.equal(command.workspace, "/srv/workspace");
  assert.deepEqual(command.argv.slice(-4), [
    "--",
    "worker@example.invalid",
    "/usr/bin/node",
    "/opt/rigyn/bin/tool-backend-worker",
  ]);
  assert.ok(command.argv.includes("BatchMode=yes"));
  assert.ok(command.argv.includes("ClearAllForwardings=yes"));
  assert.ok(command.argv.includes("ForwardAgent=no"));
  assert.ok(command.argv.includes("StrictHostKeyChecking=yes"));
  assert.ok(command.argv.includes(`UserKnownHostsFile=${knownHosts}`));
  assert.throws(() => remoteSshCommand([
    "--ssh", process.execPath,
    "--host", "worker@example.invalid",
    "--identity", identity,
    "--known-hosts", knownHosts,
    "--remote-node", "/usr/bin/node;touch",
    "--remote-worker", "/opt/rigyn/bin/tool-backend-worker",
    "--remote-workspace", "/srv/workspace",
  ]), /shell-safe absolute POSIX path/u);
});

test("executor adapters reject a mismatched virtual workspace before delegation", () => {
  assert.throws(() => parseRequest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    tool: "read",
    input: { path: "README.md" },
    workspace: "/wrong",
  })), "/workspace"), /configured execution workspace/u);
});

test("relay forwards one bounded request without inheriting the host environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-relay-"));
  const secretName = "RIGYN_RELAY_HOST_SECRET";
  const previousSecret = process.env[secretName];
  process.env[secretName] = "must-not-reach-executor";
  t.after(async () => await rm(root, { recursive: true, force: true }));
  t.after(() => {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
  });
  const executor = await fakeExecutor(root);
  const request = parseRequest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    tool: "read",
    input: { path: "README.md" },
    workspace: "/workspace",
  })), "/workspace");
  const output = await executeRelay([process.execPath, executor, "fixed"], request);
  const response = JSON.parse(output.toString("utf8"));
  assert.equal(response.result.content, "relayed");
  const platformInjected = new Set([
    "NODE_V8_COVERAGE",
    ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []),
    ...(process.platform === "win32" ? [
      "HOMEDRIVE",
      "HOMEPATH",
      "LOGONSERVER",
      "PATH",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "USERDOMAIN",
      "USERNAME",
      "USERPROFILE",
      "WINDIR",
    ] : []),
  ]);
  assert.deepEqual(
    response.result.metadata.environment.filter((name: string) => !platformInjected.has(name)),
    [],
  );
  assert.equal(response.result.metadata.environment.includes(secretName), false);
  assert.deepEqual(response.result.metadata.argv, ["fixed"]);
  assert.deepEqual(response.result.metadata.request, JSON.parse(request.toString("utf8")));
});

test("relay cancellation reaps its executor process tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-relay-cancel-"));
  const executor = join(root, "tree.mjs");
  const parentPath = join(root, "parent.pid");
  const childPath = join(root, "child.pid");
  await writeFile(executor, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(parentPath)}, String(process.pid));
    writeFileSync(${JSON.stringify(childPath)}, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  let parentPid: number | undefined;
  let childPid: number | undefined;
  t.after(async () => {
    for (const pid of [parentPid, childPid]) {
      if (pid === undefined) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const controller = new AbortController();
  const relayed = executeRelay([process.execPath, executor], Buffer.from("{}"), { signal: controller.signal });
  const rejected = assert.rejects(relayed, /terminated/u);
  await Promise.all([waitForFile(parentPath), waitForFile(childPath)]);
  parentPid = Number(await readFile(parentPath, "utf8"));
  childPid = Number(await readFile(childPath, "utf8"));
  controller.abort(new Error("test cancellation"));
  await rejected;
  await Promise.all([waitForPidExit(parentPid), waitForPidExit(childPid)]);
});

test("relay kills and reaps an executor whose response exceeds its bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-relay-overflow-"));
  const executor = join(root, "overflow.mjs");
  const pidPath = join(root, "executor.pid");
  await writeFile(executor, `
    import { writeFileSync, writeSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    writeSync(1, Buffer.alloc(${MAX_RESPONSE_BYTES + 1}, 120));
    setInterval(() => {}, 1000);
  `);
  let executorPid: number | undefined;
  t.after(async () => {
    if (executorPid !== undefined) {
      try { process.kill(executorPid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const relayed = executeRelay([process.execPath, executor], Buffer.from("{}"));
  const rejected = assert.rejects(relayed, /response exceeds/u);
  await waitForFile(pidPath);
  executorPid = Number(await readFile(pidPath, "utf8"));
  await rejected;
  await waitForPidExit(executorPid);
});
