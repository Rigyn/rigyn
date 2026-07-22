import { EventEmitter } from "node:events";

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
}

export interface EventBusController extends EventBus {
  clear(): void;
}

export function createEventBus(): EventBusController {
  const emitter = new EventEmitter();
  return {
    emit(channel, data): void { emitter.emit(channel, data); },
    on(channel, handler): () => void {
      const guarded = (data: unknown): void => {
        Promise.resolve(handler(data)).catch((error: unknown) => {
          console.error(`Event handler error (${channel}):`, error);
        });
      };
      emitter.on(channel, guarded);
      return () => emitter.off(channel, guarded);
    },
    clear(): void { emitter.removeAllListeners(); },
  };
}
