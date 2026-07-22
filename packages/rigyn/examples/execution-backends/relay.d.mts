export const MAX_RESPONSE_BYTES: number;

export function requiredOption(args: readonly string[], name: string): string;
export function absoluteOption(args: readonly string[], name: string): string;
export function parseRequest(input: Buffer, expectedWorkspace: string): Buffer;
export function readRequest(expectedWorkspace: string): Promise<Buffer>;
export function executeRelay(
  argv: readonly string[],
  input: Uint8Array,
  options?: { signal?: AbortSignal },
): Promise<Buffer>;
export function relay(argv: readonly string[], input: Uint8Array): Promise<void>;
export function fail(error: unknown): void;
