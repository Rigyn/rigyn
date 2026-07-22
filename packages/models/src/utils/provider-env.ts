import type { ProviderEnv } from "../types.js";

export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
  const value = env?.[name] ?? (typeof process === "undefined" ? undefined : process.env[name]);
  return value === undefined || value.trim() === "" ? undefined : value;
}
