import type { ProviderEnv } from "../types.js";
import type { ApiKeyAuth, ApiKeyCredential, AuthContext, AuthResult, Credential, CredentialStore, OAuthAuth, OAuthCredential, ProviderAuth } from "./types.js";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";
export interface AuthResolutionOverrides { apiKey?: string; env?: ProviderEnv; }
export class ModelsError extends Error {
  constructor(readonly code: ModelsErrorCode, message: string, options?: { cause?: unknown }) { super(message, options); this.name = "ModelsError"; }
}
function overlay(base: AuthContext, env: ProviderEnv): AuthContext { return { env: async (name) => env[name] || await base.env(name), fileExists: (path) => base.fileExists(path) }; }
async function read(store: CredentialStore, id: string): Promise<Credential | undefined> { try { return await store.read(id); } catch (cause) { throw new ModelsError("auth", `Credential store read failed for ${id}`, { cause }); } }
async function apiKey(context: AuthContext, method: ApiKeyAuth, id: string, credential?: ApiKeyCredential): Promise<AuthResult | undefined> { try { return await method.resolve({ ctx: context, ...(credential ? { credential } : {}) }); } catch (cause) { throw new ModelsError("auth", `API key auth failed for provider ${id}`, { cause }); } }
async function oauth(store: CredentialStore, id: string, method: OAuthAuth, stored: OAuthCredential): Promise<AuthResult | undefined> {
  let credential = stored;
  if (Date.now() >= credential.expires) {
    let updated: Credential | undefined;
    try {
      updated = await store.modify(id, async (current) => {
        if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
        try { return await method.refresh(current); } catch (cause) { throw new ModelsError("oauth", `OAuth refresh failed for ${id}`, { cause }); }
      });
    } catch (cause) { if (cause instanceof ModelsError) throw cause; throw new ModelsError("auth", `Credential store modify failed for ${id}`, { cause }); }
    if (updated?.type !== "oauth") return undefined;
    credential = updated;
  }
  try { return { auth: await method.toAuth(credential), source: "OAuth" }; }
  catch (cause) { throw new ModelsError("oauth", `OAuth auth derivation failed for ${id}`, { cause }); }
}
export async function resolveProviderAuth(provider: { id: string; auth: ProviderAuth }, store: CredentialStore, baseContext: AuthContext, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined> {
  const context = overrides?.env ? overlay(baseContext, overrides.env) : baseContext;
  if (overrides?.apiKey !== undefined && provider.auth.apiKey) return apiKey(context, provider.auth.apiKey, provider.id, { type: "api_key", key: overrides.apiKey, ...(overrides.env ? { env: overrides.env } : {}) });
  const stored = await read(store, provider.id);
  if (stored?.type === "oauth") return provider.auth.oauth ? oauth(store, provider.id, provider.auth.oauth, stored) : undefined;
  if (stored?.type === "api_key") return provider.auth.apiKey ? apiKey(context, provider.auth.apiKey, provider.id, overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored) : undefined;
  return provider.auth.apiKey ? apiKey(context, provider.auth.apiKey, provider.id) : undefined;
}
