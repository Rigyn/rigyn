export function rigynCompactSignature(version: string, unicode = true): string {
  return unicode ? `rigyn ${version} · ready` : `rigyn ${version} - ready`;
}

export function rigynTerminalLockup(version: string, unicode = true): string {
  return `${rigynCompactSignature(version, unicode)}\nprogrammable agent harness`;
}
