import { defaultSecretRedactor } from "../auth/redaction.js";

const SENSITIVE_ENVIRONMENT_NAME = /(?:^(?:PGPASSWORD|MYSQL_PWD)$|(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credentials?|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$))/iu;
const CREDENTIAL_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/u;

export function scrubShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(environment))) {
    if (descriptor.enumerable !== true || !("value" in descriptor) || typeof descriptor.value !== "string") continue;
    const value = descriptor.value;
    if (SENSITIVE_ENVIRONMENT_NAME.test(name) || CREDENTIAL_URL.test(value)) {
      if (value !== "") defaultSecretRedactor.register(value);
      continue;
    }
    result[name] = value;
  }
  return result;
}
