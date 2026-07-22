import { parentPort } from "node:worker_threads";

import {
  preprocessImageInProcess,
  type ImagePreprocessOptions,
  type PreprocessedImage,
} from "./preprocess-core.js";

interface WorkerRequest {
  input: Uint8Array;
  options?: ImagePreprocessOptions;
}

type WorkerResponse =
  | { ok: true; image: PreprocessedImage }
  | { ok: false; error: string };

const port = parentPort;
if (port === null) throw new Error("Image preprocessing worker requires a parent port");

port.once("message", (message: unknown) => {
  void (async () => {
    try {
      if (message === null || typeof message !== "object" || !(message as Partial<WorkerRequest>).input?.buffer) {
        throw new Error("Invalid image preprocessing request");
      }
      const request = message as WorkerRequest;
      const processed = await preprocessImageInProcess(request.input, request.options);
      const bytes = new Uint8Array(processed.bytes);
      const image: PreprocessedImage = { ...processed, bytes };
      const response: WorkerResponse = { ok: true, image };
      port.postMessage(response, [bytes.buffer]);
    } catch (error) {
      const response: WorkerResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
      port.postMessage(response);
    }
  })();
});
