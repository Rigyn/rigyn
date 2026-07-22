import type { ProviderEnv, ProviderHeaders } from "../types.js";

export interface ModelAuth { apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; }
export interface ApiKeyCredential { type: "api_key"; key?: string; env?: ProviderEnv; }
export interface OAuthCredentials { refresh: string; access: string; expires: number; [key: string]: unknown; }
export interface OAuthCredential extends OAuthCredentials { type: "oauth"; }
export type Credential = ApiKeyCredential | OAuthCredential;
export interface CredentialInfo { providerId: string; type: Credential["type"]; }
export interface CredentialStore {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(providerId: string, operation: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}
export interface AuthContext { env(name: string): Promise<string | undefined>; fileExists(path: string): Promise<boolean>; }
export interface AuthResult { auth: ModelAuth; env?: ProviderEnv; source?: string; }
export interface AuthCheck { source?: string; type: "api_key" | "oauth"; }
export type AuthType = "api_key" | "oauth";
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
);
export interface AuthInfoLink { url: string; label?: string; }
export type AuthEvent =
  | { type: "info" | "progress"; message: string; links?: readonly AuthInfoLink[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number };
export interface AuthInteraction { signal?: AbortSignal; prompt(prompt: AuthPrompt): Promise<string>; notify(event: AuthEvent): void; }
export interface ApiKeyAuth {
  name: string;
  login?(interaction: AuthInteraction): Promise<ApiKeyCredential>;
  check?(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthCheck | undefined>;
  resolve(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined>;
}
export interface OAuthAuth {
  name: string; loginLabel?: string;
  login(interaction: AuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}
export interface ProviderAuth { apiKey?: ApiKeyAuth; oauth?: OAuthAuth; }
