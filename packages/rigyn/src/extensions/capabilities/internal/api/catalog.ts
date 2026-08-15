import type { Api, Model } from "@rigyn/models";

import type { SlashCommandInfo } from "../../../../core/slash-commands.js";
import type { ThinkingLevel } from "../../../../core/settings-manager.js";
import type { DiscoveryView } from "../../host.js";
import type { ToolInfo } from "../../tools.js";

interface ExtensionToolCatalogActions {
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  getCommands(): SlashCommandInfo[];
  setActiveTools(toolNames: string[]): void;
}

interface ExtensionModelSelectionActions {
  getThinkingLevel(): ThinkingLevel;
  setModel(model: Model<Api>): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface ExtensionCatalogActions extends ExtensionModelSelectionActions, ExtensionToolCatalogActions {}

export interface ExtensionCatalogCapabilities extends ExtensionCatalogActions {
  getDiscoveryView(signal?: AbortSignal): Promise<DiscoveryView>;
}
