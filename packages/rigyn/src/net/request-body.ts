export const MAX_BUFFERED_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export interface BufferedRequestBody {
  readonly request: Request;
  readonly body?: Uint8Array<ArrayBuffer>;
}

type StreamingRequestInit = RequestInit & { duplex: "half" };

export async function bufferRequestBody(
  request: Request,
  label: string,
): Promise<BufferedRequestBody> {
  if (request.body === null) return { request };
  request.signal.throwIfAborted();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  let cancellationRequested = false;
  const cancel = (reason?: unknown) => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    void reader.cancel(reason).catch(() => undefined);
  };
  const abort = () => { cancel(request.signal.reason); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      request.signal.throwIfAborted();
      if (next.done) {
        finished = true;
        break;
      }
      if (next.value.byteLength > MAX_BUFFERED_REQUEST_BODY_BYTES - bytes) {
        const error = new TypeError(`${label} exceeds ${MAX_BUFFERED_REQUEST_BODY_BYTES} bytes`);
        cancel(error);
        throw error;
      }
      chunks.push(next.value.slice());
      bytes += next.value.byteLength;
    }
  } catch (error) {
    if (request.signal.aborted) request.signal.throwIfAborted();
    throw error;
  } finally {
    request.signal.removeEventListener("abort", abort);
    if (!finished) cancel();
    reader.releaseLock();
  }

  request.signal.throwIfAborted();
  const body: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const init: StreamingRequestInit = { body, duplex: "half" };
  return {
    request: new Request(request, init),
    body,
  };
}
