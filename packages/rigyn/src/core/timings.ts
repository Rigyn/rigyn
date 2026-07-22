const enabled = process.env.RIGYN_TIMING === "1";

export type TimingNamespace = "main" | "extensions";

interface TimingState {
  timings: Array<{ label: string; ms: number }>;
  lastTime: number;
}

const states = new Map<TimingNamespace, TimingState>();

export function resetTimings(namespace: TimingNamespace = "main"): void {
  if (enabled) states.set(namespace, { timings: [], lastTime: Date.now() });
}

export function time(label: string, namespace: TimingNamespace = "main"): void {
  if (!enabled) return;
  const now = Date.now();
  if (!states.has(namespace)) resetTimings(namespace);
  const state = states.get(namespace)!;
  state.timings.push({ label, ms: now - state.lastTime });
  state.lastTime = now;
}

export function printTimings(): void {
  if (!enabled) return;
  for (const [namespace, state] of states) {
    if (state.timings.length === 0) continue;
    console.error(`\n--- Startup Timings: ${namespace} ---`);
    for (const timing of state.timings) console.error(`  ${timing.label}: ${timing.ms}ms`);
    console.error(`  TOTAL: ${state.timings.reduce((sum, timing) => sum + timing.ms, 0)}ms`);
    console.error("-----------------------------------\n");
  }
}
