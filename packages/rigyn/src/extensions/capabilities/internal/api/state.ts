import type { Provider } from "@rigyn/models";

import type { SourceInfo } from "../../../../core/source-info.js";
import type {
  ExtensionFlag,
  ExtensionShortcut,
  RegisteredCommand,
} from "../../commands.js";
import type { ExtensionHandler } from "../../events.js";
import type { ProviderConfig } from "../../provider.js";
import type {
  EntryRenderer,
  MarkdownTransformer,
  MessageRenderer,
} from "../../rendering.js";
import type { RegisteredTool } from "../../tools.js";

interface ExtensionIdentity {
  path: string;
  resolvedPath: string;
  sourceInfo: SourceInfo;
  hidden?: boolean;
}

interface ExtensionLifecycleState {
  handlers: Map<string, ExtensionHandler[]>;
  markdownTransformer?: MarkdownTransformer;
}

interface ExtensionRegistrations {
  tools: Map<string, RegisteredTool>;
  messageRenderers: Map<string, MessageRenderer>;
  entryRenderers?: Map<string, EntryRenderer>;
  commands: Map<string, RegisteredCommand>;
  flags: Map<string, ExtensionFlag>;
  shortcuts: Map<string, ExtensionShortcut>;
}

export interface Extension extends ExtensionIdentity, ExtensionLifecycleState, ExtensionRegistrations {}

interface ExtensionErrorContext {
  extensionPath: string;
  event: string;
}

export interface ExtensionError extends ExtensionErrorContext {
  error: string;
  stack?: string;
}

export interface PendingProviderRegistration {
  name: string;
  config: ProviderConfig;
  extensionPath: string;
}

export interface PendingNativeProviderRegistration {
  provider: Provider;
  extensionPath: string;
}
