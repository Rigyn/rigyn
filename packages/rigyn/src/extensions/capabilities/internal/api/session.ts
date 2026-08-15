import type { CustomMessage } from "@rigyn/kernel";

import type {
  CustomMessageDeliveryOptions,
  ExecOptions,
  ExecResult,
  UserMessageDeliveryOptions,
} from "../../host.js";

interface ExtensionSessionMessaging {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: CustomMessageDeliveryOptions,
  ): void;
  sendUserMessage(content: CustomMessage["content"], options?: UserMessageDeliveryOptions): void;
}

interface ExtensionSessionMetadata {
  appendEntry<T = unknown>(customType: string, data?: T): void;
  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  setSessionName(name: string): void;
}

interface ExtensionSessionExecution {
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export interface ExtensionSessionActions extends ExtensionSessionMessaging, ExtensionSessionMetadata {}

export interface ExtensionSessionCapabilities extends ExtensionSessionActions, ExtensionSessionExecution {}
