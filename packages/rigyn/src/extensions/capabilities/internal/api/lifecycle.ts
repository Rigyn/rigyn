import type { ExtensionConfigStore } from "../../../config-store.js";
import type { ExtensionProcessService } from "../../../../process/managed-process.js";
import type { ExtensionEventMap, ExtensionHandler } from "../../events.js";

export interface ExtensionLifecycleCapabilities {
  readonly config: ExtensionConfigStore;
  readonly processes: ExtensionProcessService;
  onDispose(callback: () => void | Promise<void>): void;
  on<K extends keyof ExtensionEventMap>(event: K, handler: ExtensionHandler<K>): void;
  readonly events: {
    on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
    emit(channel: string, data: unknown): void;
  };
}
