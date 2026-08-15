import type { Models } from "../providers/models.js";

export const ANTHROPIC_API_BEARER_BILLING_WARNING =
  "An Anthropic bearer token is in use. Rigyn sends these requests through the Anthropic API, so Claude plan allowance does not apply and Console/API billing may apply. Turn this notice off in /settings.";
export const ANTHROPIC_OAUTH_BILLING_WARNING =
  "Anthropic account OAuth is in use. Anthropic determines whether the account is eligible for plan usage; extra-usage or API billing may apply. Turn this notice off in /settings.";

interface AnthropicApiBearerBillingWarningOptions {
  enabled: boolean;
  model: { provider: string } | undefined;
  models: Pick<Models, "checkAuth" | "getAuth">;
  notify(message: string): void;
}

/** Warn at most once per interactive process when Anthropic OAuth or an API bearer credential is active. */
export class AnthropicApiBearerBillingWarning {
  #shown = false;

  async maybeNotify(options: AnthropicApiBearerBillingWarningOptions): Promise<boolean> {
    if (!options.enabled || this.#shown || options.model?.provider !== "anthropic") return false;
    try {
      const check = await options.models.checkAuth("anthropic");
      if (check?.type === "oauth") {
        if (this.#shown) return false;
        this.#shown = true;
        options.notify(ANTHROPIC_OAUTH_BILLING_WARNING);
        return true;
      }
      const auth = (await options.models.getAuth("anthropic"))?.auth;
      const bearer = Object.entries(auth?.headers ?? {})
        .find(([name, value]) => name.toLowerCase() === "authorization" && value !== null)?.[1];
      if (!auth?.apiKey?.startsWith("sk-ant-oat") && !/^Bearer\s+\S+/iu.test(bearer ?? "")) return false;
      if (this.#shown) return false;
      this.#shown = true;
      options.notify(ANTHROPIC_API_BEARER_BILLING_WARNING);
      return true;
    } catch {
      return false;
    }
  }
}
