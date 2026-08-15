import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WindowsJobLauncherPathOptions {
  architecture?: string;
  moduleUrl?: string;
}

export function windowsJobLauncherPath(options: WindowsJobLauncherPathOptions = {}): string {
  const architecture = options.architecture ?? process.arch;
  return join(
    dirname(fileURLToPath(options.moduleUrl ?? import.meta.url)),
    "..",
    "native",
    "win32",
    "prebuilds",
    `win32-${architecture}`,
    "rigyn-job-launcher.exe",
  );
}
