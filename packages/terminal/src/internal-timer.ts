export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ManagedTimeout {
  clear(): void;
  unref(): void;
}

export function validateTimerDelay(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number`);
  }
  return value;
}

export function scheduleTimeout(callback: () => void, delayMs: number): ManagedTimeout {
  let remaining = validateTimerDelay(delayMs, "Timer delay");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let unreferenced = false;

  const arm = (): void => {
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = undefined;
      if (!active) return;
      remaining -= delay;
      if (remaining > 0) {
        arm();
        return;
      }
      active = false;
      callback();
    }, delay);
    if (unreferenced) timer.unref();
  };

  arm();
  return {
    clear(): void {
      if (!active) return;
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    unref(): void {
      unreferenced = true;
      timer?.unref();
    },
  };
}

export function scheduleInterval(callback: () => void, intervalMs: number): ManagedTimeout {
  const interval = validateTimerDelay(intervalMs, "Timer interval");
  if (interval <= MAX_TIMER_DELAY_MS) {
    const timer = setInterval(callback, interval);
    return {
      clear(): void { clearInterval(timer); },
      unref(): void { timer.unref(); },
    };
  }

  let timer: ManagedTimeout | undefined;
  let active = true;
  let unreferenced = false;
  const arm = (): void => {
    timer = scheduleTimeout(() => {
      timer = undefined;
      if (!active) return;
      callback();
      if (active) arm();
    }, interval);
    if (unreferenced) timer.unref();
  };
  arm();
  return {
    clear(): void {
      active = false;
      timer?.clear();
      timer = undefined;
    },
    unref(): void {
      unreferenced = true;
      timer?.unref();
    },
  };
}
