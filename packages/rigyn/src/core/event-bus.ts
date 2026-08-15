export type EventHandler<T = unknown> = (value: T) => void | Promise<void>;

export interface EventBus {
  on<T = unknown>(topic: string, handler: EventHandler<T>): () => void;
  emit<T = unknown>(topic: string, value: T): void;
}

export interface EventBusController extends EventBus {
  clear(): void;
}

export function createEventBus(): EventBusController {
  const topics = new Map<string, Set<EventHandler>>();
  return {
    on(topic, handler) {
      const handlers = topics.get(topic) ?? new Set<EventHandler>();
      handlers.add(handler as EventHandler);
      topics.set(topic, handlers);
      return () => {
        handlers.delete(handler as EventHandler);
        if (handlers.size === 0) topics.delete(topic);
      };
    },
    emit(topic, value) {
      for (const handler of [...(topics.get(topic) ?? [])]) {
        try {
          void Promise.resolve(handler(value)).catch(() => { console.error("Event handler failed"); });
        } catch {
          console.error("Event handler failed");
        }
      }
    },
    clear() { topics.clear(); },
  };
}
