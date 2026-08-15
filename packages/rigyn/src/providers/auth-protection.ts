import { assertRedactableSecret, defaultSecretRedactor } from "../auth/redaction.js";

const SENSITIVE_PROVIDER_HEADER = /(?:authorization|api[-_]?key|token|cookie|secret|credential)/iu;
const SENSITIVE_PROVIDER_ENVIRONMENT = /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|ACCESS_?TOKEN|REFRESH_?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/iu;

function registerProviderSecret(value: string, label: string): void {
  assertRedactableSecret(value, label);
  defaultSecretRedactor.register(value);
}

/** @internal Protects credentials immediately before provider auth becomes observable or transportable. */
export function protectProviderAuth(auth: {
  apiKey?: string;
  headers?: Readonly<Record<string, string | null>>;
}): void {
  if (auth.apiKey !== undefined) registerProviderSecret(auth.apiKey, "Provider API key");
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value === null || !SENSITIVE_PROVIDER_HEADER.test(name)) continue;
    const authorization = /^(?:authorization|proxy-authorization)$/iu.test(name);
    const payload = authorization
      ? /^\s*[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+(.+?)\s*$/u.exec(value)?.[1] ?? value.trim()
      : value;
    registerProviderSecret(payload, `Provider ${name} header credential`);
    defaultSecretRedactor.register(value);
  }
}

/** @internal Protects credential-named environment values immediately before provider transport. */
export function protectProviderEnvironment(environment: Readonly<Record<string, string>> | undefined): void {
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (SENSITIVE_PROVIDER_ENVIRONMENT.test(name)) {
      registerProviderSecret(value, `Provider ${name} environment credential`);
    }
  }
}
