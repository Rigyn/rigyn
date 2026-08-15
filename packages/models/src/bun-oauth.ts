export * from "./auth-flows.js";

export async function openOAuthUrl(url: string): Promise<void> {
  const bun = (globalThis as { Bun?: { spawn(command: string[]): { exited: Promise<number> } } }).Bun;
  if (!bun) throw new Error("Bun is required by openOAuthUrl");
  const platform = globalThis.process?.platform;
  const command = platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  const exitCode = await bun.spawn(command).exited;
  if (exitCode !== 0) throw new Error(`Browser command exited with status ${exitCode}`);
}
