import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.js";
import type { ProviderEnv } from "../types.js";

const API_KEY = "CLOUDFLARE_API_KEY";
const ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

async function value(name: string, context: AuthContext, credential?: ApiKeyCredential): Promise<string | undefined> {
  const stored = name === API_KEY ? credential?.key : credential?.env?.[name];
  return stored ?? context.env(name);
}

async function resolve(
  kind: "workers-ai" | "ai-gateway",
  context: AuthContext,
  credential?: ApiKeyCredential,
): Promise<{ apiKey: string; env: ProviderEnv; source: string } | undefined> {
  const [apiKey, accountId, gatewayId] = await Promise.all([
    value(API_KEY, context, credential),
    value(ACCOUNT_ID, context, credential),
    kind === "ai-gateway" ? value(GATEWAY_ID, context, credential) : undefined,
  ]);
  if (!apiKey || !accountId || (kind === "ai-gateway" && !gatewayId)) return undefined;
  return {
    apiKey,
    env: { [ACCOUNT_ID]: accountId, ...(gatewayId ? { [GATEWAY_ID]: gatewayId } : {}) },
    source: credential ? "stored credential" : API_KEY,
  };
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
  return {
    name: "Cloudflare API key",
    async login(interaction) {
      const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
      const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
      return { type: "api_key", key, env: { [ACCOUNT_ID]: accountId } };
    },
    async resolve({ ctx, credential }) {
      const result = await resolve("workers-ai", ctx, credential);
      return result ? { auth: { apiKey: result.apiKey }, env: result.env, source: result.source } : undefined;
    },
  };
}

export function cloudflareAIGatewayAuth(): ApiKeyAuth {
  return {
    name: "Cloudflare API key",
    async login(interaction) {
      const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
      const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
      const gatewayId = await interaction.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
      return { type: "api_key", key, env: { [ACCOUNT_ID]: accountId, [GATEWAY_ID]: gatewayId } };
    },
    async resolve({ ctx, credential }) {
      const result = await resolve("ai-gateway", ctx, credential);
      return result ? {
        auth: { headers: { "cf-aig-authorization": `Bearer ${result.apiKey}`, authorization: null, "x-api-key": null } },
        env: result.env,
        source: result.source,
      } : undefined;
    },
  };
}
