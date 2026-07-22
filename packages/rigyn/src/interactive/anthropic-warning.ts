import type { Models } from "../providers/models.js";

export const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
  "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

interface AnthropicSubscriptionWarningOptions {
  enabled: boolean;
  model: { provider: string } | undefined;
  models: Pick<Models, "checkAuth" | "getAuth">;
  notify(message: string): void;
}

/** Warn at most once per interactive process when Anthropic subscription credentials are active. */
export class AnthropicSubscriptionWarning {
  #shown = false;

  async maybeNotify(options: AnthropicSubscriptionWarningOptions): Promise<boolean> {
    if (!options.enabled || this.#shown || options.model?.provider !== "anthropic") return false;
    try {
      const check = await options.models.checkAuth("anthropic");
      const subscriptionKey = check?.type === "oauth"
        ? undefined
        : (await options.models.getAuth("anthropic"))?.auth.apiKey;
      if (check?.type !== "oauth" && !subscriptionKey?.startsWith("sk-ant-oat")) return false;
      if (this.#shown) return false;
      this.#shown = true;
      options.notify(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
      return true;
    } catch {
      return false;
    }
  }
}
