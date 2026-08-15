import { createDefaultCredentialStore } from "../../src/auth/default-store.js";
import type { CredentialStore } from "../../src/auth/types.js";

const liveAuthPathKey = Symbol.for("rigyn.test.live-auth-path");
const capturedPath = (globalThis as unknown as Record<symbol, unknown>)[liveAuthPathKey];
Reflect.deleteProperty(globalThis, liveAuthPathKey);

export async function liveCredentialStore(options: { allowPlatformKeychain?: boolean } = {}): Promise<CredentialStore> {
  if (typeof capturedPath !== "string" || capturedPath === "") {
    throw new Error("Live tests require an isolated setup with a captured authentication path");
  }
  return await createDefaultCredentialStore(capturedPath, {
    createLocalKey: false,
    ...(options.allowPlatformKeychain === undefined
      ? {}
      : { allowPlatformKeychain: options.allowPlatformKeychain }),
  });
}
