import { parentPort } from "node:worker_threads";

import { preprocessImageInProcess, type ImagePreprocessOptions } from "./preprocess-core.js";

if (parentPort === null) throw new Error("Image preprocessing worker requires a parent port");

parentPort.once("message", async (value: unknown) => {
  try {
    if (value === null || typeof value !== "object") throw new TypeError("Invalid image worker request");
    const { input, options } = value as { input?: unknown; options?: ImagePreprocessOptions };
    if (!(input instanceof Uint8Array)) throw new TypeError("Invalid image worker bytes");
    const image = await preprocessImageInProcess(input, options);
    parentPort!.postMessage({ ok: true, image }, [image.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
    const message = isError?.(error) === true
      ? String(Object.getOwnPropertyDescriptor(error, "message")?.value ?? "Image preprocessing failed")
      : "Image preprocessing failed";
    parentPort!.postMessage({ ok: false, error: message.slice(0, 16 * 1024) });
  }
});
