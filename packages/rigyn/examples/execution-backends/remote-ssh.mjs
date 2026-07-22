#!/usr/bin/env node
import { absoluteOption, fail, readRequest, relay, requiredOption } from "./relay.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function remoteSshCommand(args) {
  const ssh = absoluteOption(args, "--ssh");
  const identity = absoluteOption(args, "--identity");
  const knownHosts = absoluteOption(args, "--known-hosts");
  const remoteNode = remotePathOption(args, "--remote-node");
  const remoteWorker = remotePathOption(args, "--remote-worker");
  const remoteWorkspace = remotePathOption(args, "--remote-workspace");
  const host = requiredOption(args, "--host");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,254}$/u.test(host)) throw new Error("--host is invalid");
  return { workspace: remoteWorkspace, argv: [ssh,
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-i",
    identity,
    "--",
    host,
    remoteNode,
    remoteWorker,
  ] };
}

function remotePathOption(args, name) {
  const value = requiredOption(args, name);
  if (!/^\/[a-zA-Z0-9._/-]+$/u.test(value) || value.split("/").includes("..")) {
    throw new Error(`${name} must be a shell-safe absolute POSIX path`);
  }
  return value;
}

async function main() {
  const command = remoteSshCommand(process.argv.slice(2));
  const input = await readRequest(command.workspace);
  await relay(command.argv, input);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(fail);
}
