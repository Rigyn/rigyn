import type { Provider } from "@rigyn/models";
import type { TSchema } from "typebox";

import type {
  CommandOptions,
  FlagOptions,
  ShortcutOptions,
} from "../../commands.js";
import type { ProviderConfig } from "../../provider.js";
import type {
  EntryRenderer,
  MarkdownTransformer,
  MessageRenderer,
} from "../../rendering.js";
import type { ToolDefinition } from "../../tools.js";

interface ExtensionToolRegistration {
  registerTool<TParameters extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParameters, TDetails, TState>,
  ): void;
}

interface ExtensionCommandRegistration {
  registerCommand(name: string, options: CommandOptions): void;
  registerFlag(name: string, options: FlagOptions): void;
  registerShortcut(shortcut: string, options: ShortcutOptions): void;
  getFlag(name: string): boolean | string | undefined;
}

interface ExtensionRendererRegistration {
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
  registerMarkdownTransformer(transformer: MarkdownTransformer): void;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
}

interface ExtensionProviderRegistration {
  registerProvider(provider: Provider): void;
  registerProvider(id: string, config: ProviderConfig): void;
  unregisterProvider(id: string): void;
}

export interface ExtensionRegistrationCapabilities
  extends ExtensionCommandRegistration,
    ExtensionProviderRegistration,
    ExtensionRendererRegistration,
    ExtensionToolRegistration {}
