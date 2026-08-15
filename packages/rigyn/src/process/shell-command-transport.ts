export function isLegacyWindowsBash(path: string): boolean {
  const normalized = path.replaceAll("/", "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/u.test(normalized);
}
