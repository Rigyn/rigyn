export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
}

const MAX_TOKEN_BYTES = 48 * 1024;
const MAX_SCOPE_BYTES = 16 * 1024;
const MAX_SCOPE_COUNT = 256;
const MAX_SCOPE_ITEM_BYTES = 1024;
const MAX_EXPIRES_IN_SECONDS = 366 * 24 * 60 * 60;

function token(value: unknown, label: string, options: { required: boolean; bearer?: boolean }): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    /[\x00-\x1f\x7f]/u.test(value) ||
    (options.bearer === true && /\s/u.test(value))
  ) {
    throw new Error(`${label} has an invalid token value`);
  }
  return value;
}

function expiresIn(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" && /^[1-9][0-9]{0,8}$/u.test(value)
    ? Number(value)
    : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_EXPIRES_IN_SECONDS
  ) {
    throw new Error(`${label} has an invalid expires_in`);
  }
  return parsed;
}

function scope(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_SCOPE_BYTES ||
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new Error(`${label} has an invalid scope`);
  }
  const entries = value.split(/ +/u).filter(Boolean);
  if (
    entries.length > MAX_SCOPE_COUNT ||
    entries.some((entry) => Buffer.byteLength(entry, "utf8") > MAX_SCOPE_ITEM_BYTES || /\s/u.test(entry))
  ) {
    throw new Error(`${label} has an invalid scope`);
  }
  return entries.join(" ");
}

/** Validate the interoperable Bearer-token subset used by every provider adapter. */
export function parseOAuthTokenResponse(
  value: Readonly<Record<string, unknown>>,
  label: string,
): OAuthTokenResponse {
  const accessToken = token(value.access_token, label, { required: true, bearer: true })!;
  const refreshToken = token(value.refresh_token, label, { required: false });
  const tokenType = value.token_type === undefined ? "Bearer" : value.token_type;
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    throw new Error(`${label} returned an unsupported token_type`);
  }
  const lifetime = expiresIn(value.expires_in, label);
  const grantedScope = scope(value.scope, label);
  return {
    accessToken,
    tokenType: "Bearer",
    ...(lifetime === undefined ? {} : { expiresIn: lifetime }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(grantedScope === undefined ? {} : { scope: grantedScope }),
  };
}

export function oauthErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : fallback;
}

export function oauthTokenExpiresAt(response: OAuthTokenResponse, now = Date.now()): number {
  if (!Number.isFinite(now)) throw new TypeError("OAuth expiry clock is invalid");
  const expiresAt = now + (response.expiresIn ?? 3600) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("OAuth token response produced an invalid expiry");
  }
  return expiresAt;
}
