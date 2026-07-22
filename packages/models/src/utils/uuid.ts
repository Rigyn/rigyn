import { randomBytes } from "node:crypto";

let lastMs = -1;
let sequence = 0;
export function uuidv7(now = Date.now()): string {
  const requestedMilliseconds = Math.trunc(Math.max(0, Math.min(now, 0xffffffffffff)));
  if (requestedMilliseconds > lastMs) {
    lastMs = requestedMilliseconds;
    sequence = randomBytes(2).readUInt16BE() & 0x0fff;
  } else if (sequence < 0x0fff) {
    sequence += 1;
  } else {
    if (lastMs >= 0xffffffffffff) throw new Error("UUIDv7 logical clock exhausted");
    lastMs += 1;
    sequence = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(lastMs, 0, 6);
  bytes[6] = 0x70 | (sequence >>> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
