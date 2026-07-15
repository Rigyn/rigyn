import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type ProductInstallAction = "install" | "update" | "uninstall";

export async function runProductInstallAction(
  action: ProductInstallAction,
  options: { yes?: boolean } = {},
): Promise<void> {
  if (action === "uninstall" && options.yes !== true) {
    throw new Error("Uninstall requires confirmation; run `rigyn uninstall --yes`");
  }
  const scriptName = action === "install"
    ? "install-user.mjs"
    : action === "update"
      ? "update-user.mjs"
      : "uninstall-user.mjs";
  const script = fileURLToPath(new URL(`../../scripts/${scriptName}`, import.meta.url));
  await access(script);
  const args = [script, ...(action === "uninstall" && options.yes === true ? ["--yes"] : [])];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`Rigyn ${action} failed with exit ${code}`);
}
