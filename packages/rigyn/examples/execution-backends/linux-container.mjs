#!/usr/bin/env node
import { absoluteOption, fail, readRequest, relay, requiredOption } from "./relay.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function linuxContainerCommand(args) {
  const engine = absoluteOption(args, "--engine");
  const hostWorkspace = absoluteOption(args, "--host-workspace");
  if (hostWorkspace.includes(",")) throw new Error("--host-workspace cannot contain a comma");
  const image = requiredOption(args, "--image");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/u.test(image)) throw new Error("--image is invalid");
  return [engine,
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    "--mount",
    `type=bind,src=${hostWorkspace},dst=/workspace,rw`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    image,
    "node",
    "/app/dist/bin/tool-backend-worker.js",
  ];
}

async function main() {
  const input = await readRequest("/workspace");
  await relay(linuxContainerCommand(process.argv.slice(2)), input);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(fail);
}
