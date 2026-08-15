import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: base64UrlSha256(verifier), method: "S256" };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function verifyS256Challenge(verifier: string, expectedChallenge: string): boolean {
  const actual = Buffer.from(base64UrlSha256(verifier), "ascii");
  const expected = Buffer.from(expectedChallenge, "ascii");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
