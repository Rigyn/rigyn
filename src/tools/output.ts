export interface LimitedText {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

function utf8Prefix(bytes: Buffer, maximum: number): string {
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Tail(bytes: Buffer, maximum: number): string {
  let start = Math.max(0, bytes.length - maximum);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function limitText(input: string, maxBytes: number): LimitedText {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  const bytes = Buffer.from(input);
  if (bytes.length <= maxBytes) return { text: input, truncated: false, omittedBytes: 0 };
  if (maxBytes < 128) {
    const kept = utf8Prefix(bytes, maxBytes);
    return { text: kept, truncated: true, omittedBytes: bytes.length - Buffer.byteLength(kept) };
  }
  const markerBudget = 80;
  const available = maxBytes - markerBudget;
  const headBudget = Math.ceil(available * 0.6);
  const tailBudget = available - headBudget;
  const head = utf8Prefix(bytes, headBudget);
  const tail = utf8Tail(bytes, tailBudget);
  const retainedBytes = Buffer.byteLength(head) + Buffer.byteLength(tail);
  const omittedBytes = bytes.length - retainedBytes;
  return {
    text: `${head}\n… ${omittedBytes} bytes omitted …\n${tail}`,
    truncated: true,
    omittedBytes,
  };
}

export function escapeTerminal(input: string): string {
  return input.replaceAll(/\x1b/g, "\\x1b").replaceAll(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/gu, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return `\\u{${point.toString(16)}}`;
  });
}
