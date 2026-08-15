import type { SettingsManager } from "../core/settings-manager.js";

export async function persistDefaultSelection(
  settings: SettingsManager,
  selection: { provider: string; model: string },
): Promise<void> {
  settings.setDefaultModelAndProvider(selection.provider, selection.model);
  await settings.flush();
}
