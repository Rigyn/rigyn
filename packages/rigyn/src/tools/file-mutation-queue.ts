import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();
let registration = Promise.resolve();

async function identity(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return absolute;
    throw error;
  }
}

/** Serialize mutations of one physical file while allowing unrelated files in parallel. */
export async function withFileMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const registered = registration.then(async () => {
    const key = await identity(path);
    const before = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    const tail = before.then(() => current);
    queues.set(key, tail);
    return { key, before, release, tail };
  });
  registration = registered.then(() => undefined, () => undefined);
  const queued = await registered;
  await queued.before;
  try {
    return await operation();
  } finally {
    queued.release();
    if (queues.get(queued.key) === queued.tail) queues.delete(queued.key);
  }
}

export const withFileMutationQueue = withFileMutation;
