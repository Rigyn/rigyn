import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeTerminalInputOptions {
  platform?: NodeJS.Platform;
  architecture?: string;
  executablePath?: string;
  moduleUrl?: string;
  loadNativeModule?: (path: string) => unknown;
}

function candidates(options: NativeTerminalInputOptions): string[] {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const filename = platform === "win32" ? "win32-console-mode.node" : "darwin-modifiers.node";
  const moduleDirectory = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const executable = options.executablePath ?? process.execPath;
  return [
    join(moduleDirectory, "..", "native", platform, "prebuilds", `${platform}-${architecture}`, filename),
    join(dirname(executable), "native", platform, "prebuilds", `${platform}-${architecture}`, filename),
    join(moduleDirectory, "..", "..", "native", platform, "prebuilds", `${platform}-${architecture}`, filename),
  ];
}

export function enableNativeInput(options: NativeTerminalInputOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== "win32") return false;
  const load = options.loadNativeModule ?? ((path: string) => createRequire(import.meta.url)(path));
  for (const path of candidates(options)) {
    try {
      const module = load(path) as { enableVirtualTerminalInput?: () => unknown };
      if (typeof module.enableVirtualTerminalInput === "function") { module.enableVirtualTerminalInput(); return true; }
    } catch { /* try next package layout */ }
  }
  return false;
}

export function modifierPressed(name: string, options: NativeTerminalInputOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const load = options.loadNativeModule ?? ((path: string) => createRequire(import.meta.url)(path));
  for (const path of candidates(options)) {
    try {
      const module = load(path) as { modifierPressed?: (value: string) => boolean };
      if (typeof module.modifierPressed === "function") return module.modifierPressed(name);
    } catch { /* no helper */ }
  }
  return false;
}
