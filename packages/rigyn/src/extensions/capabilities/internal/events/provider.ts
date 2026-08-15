import type { JsonValue } from "../../../../core/json.js";

export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: JsonValue;
}

export type BeforeProviderRequestEventResult = JsonValue;

export interface BeforeProviderHeadersEvent {
  type: "before_provider_headers";
  headers: Record<string, string | null>;
}

export interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

export interface ProviderEventMap {
  before_provider_request: BeforeProviderRequestEvent;
  before_provider_headers: BeforeProviderHeadersEvent;
  after_provider_response: AfterProviderResponseEvent;
}

export interface ProviderEventResultMap {
  before_provider_request: BeforeProviderRequestEventResult | void;
  before_provider_headers: void;
  after_provider_response: void;
}
