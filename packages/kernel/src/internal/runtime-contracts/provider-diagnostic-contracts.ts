import type { JsonValue } from "../../runtime/core/json.js";

export interface AdapterError {
  category:
    | "authentication"
    | "permission"
    | "rate_limit"
    | "invalid_request"
    | "not_found"
    | "overloaded"
    | "network"
    | "timeout"
    | "protocol"
    | "cancelled"
    | "provider";
  message: string;
  httpStatus?: number;
  providerCode?: string;
  requestId?: string;
  retryAfterMs?: number;
  retryable: boolean;
  partial: boolean;
  bodyStarted?: boolean;
  /** Safe, allowlisted transport metadata for an observed HTTP response. */
  diagnostics?: ProviderResponseDiagnostics;
  raw?: JsonValue;
}

export interface ProviderResponseDiagnostics {
  /** Final HTTP response status observed by the provider transport. */
  status: number;
  /** Small, explicitly allowlisted response-header projection. */
  headers: Record<string, string>;
}

/** Bounded failed-response metadata exposed to observers; raw provider bodies are excluded. */
export type ProviderResponseFailureMetadata = Omit<AdapterError, "raw" | "diagnostics">;
