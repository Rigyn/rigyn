import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { RIGYN_VERSION } from "../version.js";

export type ProductInstallAction = "install" | "update" | "uninstall";

export async function runProductInstallAction(
  action: ProductInstallAction,
  options: { yes?: boolean } = {},
): Promise<void> {
  if (action === "uninstall" && options.yes !== true) {
    throw new Error("Uninstall requires confirmation; run `rigyn uninstall --yes`");
  }
  if (process.env.RIGYN_DISTRIBUTION === "standalone") {
    if (action === "uninstall") {
      const script = fileURLToPath(new URL("../../scripts/uninstall-standalone.mjs", import.meta.url));
      await access(script);
      const child = spawn(process.execPath, [script, "--yes"], {
        cwd: process.cwd(),
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      });
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (value) => resolve(value ?? 1));
      });
      if (code !== 0) throw new Error(`rigyn ${action} failed with exit ${code}`);
      return;
    }
    const instruction = process.platform === "win32"
      ? `irm https://raw.githubusercontent.com/rigyn/rigyn/v${RIGYN_VERSION}/install.ps1 | iex`
      : `curl -fsSL https://raw.githubusercontent.com/rigyn/rigyn/v${RIGYN_VERSION}/install.sh | sh`;
    throw new Error(
      action === "update"
        ? `Standalone rigyn updates by rerunning the verified installer: ${instruction}`
        : "The standalone release is already installed; source-only self-install is unavailable in this distribution.",
    );
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
  if (code !== 0) throw new Error(`rigyn ${action} failed with exit ${code}`);
}
