import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

interface Registration {
  path: string;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

class FileMutationScheduler {
  readonly #waitingByPath = new Map<string, Array<() => void>>();
  readonly #registrations: Registration[] = [];
  #registering = false;

  async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.#register(path);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #register(path: string): Promise<() => void> {
    const admission = new Promise<() => void>((resolveAdmission, rejectAdmission) => {
      this.#registrations.push({
        path,
        resolve: resolveAdmission,
        reject: rejectAdmission,
      });
    });
    void this.#drainRegistrations();
    return admission;
  }

  async #drainRegistrations(): Promise<void> {
    if (this.#registering) return;
    this.#registering = true;
    try {
      for (;;) {
        const registration = this.#registrations.shift();
        if (registration === undefined) break;
        try {
          const slot = this.#reserve(await fileIdentity(registration.path));
          void slot.ready.then(() => registration.resolve(slot.release), registration.reject);
        } catch (error) {
          registration.reject(error);
        }
      }
    } finally {
      this.#registering = false;
      if (this.#registrations.length !== 0) void this.#drainRegistrations();
    }
  }

  #reserve(key: string): { ready: Promise<void>; release: () => void } {
    let waiting = this.#waitingByPath.get(key);
    let ready: Promise<void>;
    if (waiting === undefined) {
      waiting = [];
      this.#waitingByPath.set(key, waiting);
      ready = Promise.resolve();
    } else {
      ready = new Promise<void>((start) => {
        waiting!.push(start);
      });
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const lane = this.#waitingByPath.get(key);
      const next = lane?.shift();
      if (next === undefined) this.#waitingByPath.delete(key);
      else next();
    };
    return { ready, release };
  }
}

async function fileIdentity(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return absolutePath;
    throw error;
  }
}

const scheduler = new FileMutationScheduler();

/** Serialize mutations of one physical file while allowing unrelated files in parallel. */
export function withFileMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  return scheduler.run(path, operation);
}

export const withFileMutationQueue = withFileMutation;
