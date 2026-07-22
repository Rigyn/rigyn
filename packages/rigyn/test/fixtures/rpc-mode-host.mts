import { runRpcMode } from "../../src/modes/rpc-mode.js";

const listeners = new Set<(event: object) => void>();
let rebind: ((session: unknown) => Promise<void>) | undefined;

const session = {
  async bindExtensions() {},
  subscribe(listener: (event: object) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  get model() { return undefined; },
  get modelRegistry() {
    return {
      find() { return undefined; },
      getAvailable() { return []; },
    };
  },
  get thinkingLevel() { return "off"; },
  get isStreaming() { return false; },
  get isIdle() { return true; },
  get isCompacting() { return false; },
  get steeringMode() { return "all"; },
  get followUpMode() { return "all"; },
  get sessionFile() { return undefined; },
  get sessionId() { return "rpc-fixture"; },
  get sessionName() { return undefined; },
  get autoCompactionEnabled() { return true; },
  get messages() { return []; },
  get pendingMessageCount() { return 0; },
} as never;

const runtime = {
  session,
  setBeforeSessionInvalidate() {},
  setRebindSession(callback?: (value: unknown) => Promise<void>) { rebind = callback; },
  async newSession() { await rebind?.(session); return { cancelled: false }; },
  async switchSession() { await rebind?.(session); return { cancelled: false }; },
  async fork() { await rebind?.(session); return { cancelled: false }; },
  async dispose() {},
} as never;

await runRpcMode(runtime);
