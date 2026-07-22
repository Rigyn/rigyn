export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
  const verifier = encode(bytes); const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: encode(new Uint8Array(digest)) };
}
