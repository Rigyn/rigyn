import type { ProviderEnv } from "../types.js";
import { getProviderEnvValue } from "./provider-env.js";

const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21 };
function environment(name: string, env?: ProviderEnv): string {
  return env?.[name.toLowerCase()] ?? env?.[name.toUpperCase()]
    ?? getProviderEnvValue(name.toLowerCase()) ?? getProviderEnvValue(name.toUpperCase()) ?? "";
}
function bypass(hostname: string, port: number, env?: ProviderEnv): boolean {
  const value = environment("no_proxy", env).toLowerCase();
  if (!value) return false;
  if (value === "*") return true;
  return value.split(/[,\s]+/u).filter(Boolean).some((entry) => {
    const match = /^(.*?):(\d+)$/u.exec(entry);
    const host = (match?.[1] ?? entry).replace(/^\*/u, "");
    if (match?.[2] && Number(match[2]) !== port) return false;
    return entry.startsWith(".") || entry.startsWith("*") ? hostname.endsWith(host) : hostname === host;
  });
}

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE = "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

export function resolveHttpProxyUrlForTarget(target: string | URL, env?: ProviderEnv): URL | undefined {
  let url: URL;
  try { url = target instanceof URL ? target : new URL(target); } catch { return undefined; }
  const protocol = url.protocol.slice(0, -1);
  const port = Number(url.port) || DEFAULT_PORTS[protocol] || 0;
  if (bypass(url.hostname.toLowerCase(), port, env)) return undefined;
  let value = environment(`${protocol}_proxy`, env) || environment("all_proxy", env);
  if (!value) return undefined;
  if (!value.includes("://")) value = `${protocol}://${value}`;
  let proxy: URL;
  try { proxy = new URL(value); } catch (error) { throw new Error(`Invalid proxy URL ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`); }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxy.protocol}`);
  return proxy;
}
