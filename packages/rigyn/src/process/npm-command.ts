import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

function regularFile(path: string | undefined): path is string {
  if (path === undefined || path === "") return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve Windows' npm command shim to its JavaScript entry point without using a shell. */
export function defaultNpmCommand(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): [string, ...string[]] {
  if (platform !== "win32") return ["npm"];

  const candidates = [
    environment.npm_execpath,
    join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(environment.PATH ?? "")
      .split(";")
      .map((entry) => entry.replace(/^"|"$/gu, ""))
      .filter(isAbsolute)
      .map((entry) => join(entry, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const npmCli = candidates.find(regularFile);
  if (npmCli === undefined) {
    throw new Error("npm package operations require npm-cli.js on Windows; install npm with Node.js or set npmCommand");
  }
  return [nodeExecutable, npmCli];
}
