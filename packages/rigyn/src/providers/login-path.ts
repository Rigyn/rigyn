export type ProviderLoginPath = "subscription" | "api_key";

export interface ProviderLoginMethod {
  type: "api_key" | "oauth" | "provider_account";
  path: ProviderLoginPath;
  label: string;
}

/** Classify interactive login by user action without changing the stored credential type. */
export function providerLoginMethods(auth: {
  apiKey?: {
    login?: unknown;
  };
  oauth?: { login?: unknown; loginLabel?: string };
  providerAccount?: { login?: unknown; loginLabel?: string };
}): ProviderLoginMethod[] {
  return [
    ...(auth.oauth?.login === undefined ? [] : [{
      type: "oauth" as const,
      path: "subscription" as const,
      label: auth.oauth.loginLabel ?? "Use a subscription or provider account",
    }]),
    ...(auth.providerAccount?.login === undefined ? [] : [{
      type: "provider_account" as const,
      path: "subscription" as const,
      label: auth.providerAccount.loginLabel ?? "Use a subscription or provider account",
    }]),
    ...(auth.apiKey?.login === undefined ? [] : [{
      type: "api_key" as const,
      path: "api_key" as const,
      label: "Use a key, token, or local credentials",
    }]),
  ];
}
