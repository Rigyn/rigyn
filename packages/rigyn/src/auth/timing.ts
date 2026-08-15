export const AUTH_PROCESS_DEFAULT_TIMEOUT_MS = 10_000;
export const AUTH_PROCESS_KILL_GRACE_MS = 1_000;
export const AUTH_PROCESS_DRAIN_MAX_MS = 1_000;
export const OAUTH_HTTP_TIMEOUT_MS = 30_000;

// A legacy keychain refresh can run two credential reads, then eight index,
// credential, and legacy migration commands while committing the rotation.
export const NORMAL_OAUTH_KEYCHAIN_HELPER_OPERATIONS = 10;
export const CREDENTIAL_STORE_LOCK_WAIT_MARGIN_MS = 1_000;
export const CREDENTIAL_STORE_LOCK_WAIT_TIMEOUT_MS = OAUTH_HTTP_TIMEOUT_MS
  + NORMAL_OAUTH_KEYCHAIN_HELPER_OPERATIONS * (
    AUTH_PROCESS_DEFAULT_TIMEOUT_MS
    + AUTH_PROCESS_KILL_GRACE_MS
    + AUTH_PROCESS_DRAIN_MAX_MS
  )
  + CREDENTIAL_STORE_LOCK_WAIT_MARGIN_MS;
