import type { ApiKeyAuth, AuthResult, OAuthAuth } from "./types.js";

export function envApiKeyAuth(name: string, environmentNames: string | readonly string[]): ApiKeyAuth {
  const names = typeof environmentNames === "string" ? [environmentNames] : [...environmentNames];
  const resolve = async (input: Parameters<ApiKeyAuth["resolve"]>[0]): Promise<AuthResult | undefined> => {
    const stored = input.credential?.key?.trim();
    if (stored) return { auth: { apiKey: stored }, source: "Stored API key", ...(input.credential?.env ? { env: input.credential.env } : {}) };
    for (const variable of names) { const value = await input.ctx.env(variable); if (value) return { auth: { apiKey: value }, source: variable }; }
    return undefined;
  };
  return {
    name,
    async login(interaction) { const key = await interaction.prompt({ type: "secret", message: name }); return { type: "api_key", key }; },
    resolve,
  };
}

/** Loads an OAuth implementation only when the user starts or refreshes a login flow. */
export function lazyOAuth(input: { name: string; loginLabel?: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
  let pending: Promise<OAuthAuth> | undefined;
  const load = () => pending ??= input.load();
  return {
    name: input.name,
    ...(input.loginLabel === undefined ? {} : { loginLabel: input.loginLabel }),
    login: async (interaction) => (await load()).login(interaction),
    refresh: async (credential, signal) => (await load()).refresh(credential, signal),
    toAuth: async (credential) => (await load()).toAuth(credential),
  };
}
