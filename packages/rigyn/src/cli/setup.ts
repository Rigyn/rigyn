import type { Settings, SettingsManager } from "../core/settings-manager.js";

export async function persistDefaultSelection(
  settings: SettingsManager,
  selection: { provider: string; model: string },
): Promise<void> {
  settings.setDefaultModelAndProvider(selection.provider, selection.model);
  await settings.flush();
}

export async function persistUiTheme(settings: SettingsManager, theme: string): Promise<void> {
  settings.setTheme(theme);
  await settings.flush();
}

export async function persistUiPreferences(settings: SettingsManager, value: Partial<Settings>): Promise<void> {
  settings.updateGlobalSettings(value);
  await settings.flush();
}
