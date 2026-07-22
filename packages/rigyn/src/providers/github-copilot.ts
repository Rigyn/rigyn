import { githubCopilotBaseUrl, githubCopilotRequestHeaders } from "../auth/github-copilot.js";
import type {
  AdapterEvent,
  ModelCapability,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
} from "../core/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { catalogId } from "./catalog.js";
import { jsonValueOrString } from "./transport.js";
import { baseModelCompatibility, modelEvidence } from "./model-metadata.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  assertResponseOk,
  assertSecureEndpoint,
  readJsonResponse,
  type FetchLike,
} from "./transport.js";

type CopilotProtocol = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

export interface GitHubCopilotCredential {
  accessToken: string;
  enterpriseHost?: string;
}

export interface GitHubCopilotConfig {
  credential: (signal?: AbortSignal) => Promise<GitHubCopilotCredential>;
  fetch?: FetchLike;
}

function capability(value: "supported" | "unsupported" | "unknown", observedAt: string): ModelCapability {
  return { value, source: "provider", observedAt };
}

function nestedStrings(value: unknown, maximum = 512): string[] {
  const result: string[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < maximum) {
    const current = queue.shift()!;
    visited += 1;
    if (typeof current.value === "string") {
      result.push(current.value.toLowerCase());
      continue;
    }
    if (current.depth >= 5 || current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (const entry of current.value.slice(0, 64)) queue.push({ value: entry, depth: current.depth + 1 });
    } else {
      for (const entry of Object.values(current.value as Record<string, unknown>).slice(0, 64)) {
        queue.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
  return result;
}

function protocolFor(id: string, metadata?: Record<string, unknown>): CopilotProtocol {
  const evidence = nestedStrings(metadata).join(" ");
  if (/anthropic(?:-messages)?|\/v1\/messages/u.test(evidence)) return "anthropic-messages";
  if (/responses|\/responses/u.test(evidence)) return "openai-responses";
  if (/chat.completions|chat\/completions|openai.completions/u.test(evidence)) return "openai-chat-completions";
  if (/^claude-(?:haiku|opus|sonnet)-/u.test(id)) return "anthropic-messages";
  if (/^gpt-5(?:[.-]|$)/u.test(id)) return "openai-responses";
  return "openai-chat-completions";
}

function numericMetadata(value: unknown, names: ReadonlySet<string>, depth = 0): number | undefined {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(name.toLowerCase())) {
      const selected = asNumber(entry);
      if (selected !== undefined && Number.isSafeInteger(selected) && selected > 0) return selected;
    }
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const selected = numericMetadata(entry, names, depth + 1);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function selectableModel(model: Record<string, unknown>): boolean {
  if (model.model_picker_enabled === false) return false;
  const policy = asRecord(model.policy);
  if (policy?.state === "disabled") return false;
  const supports = asRecord(asRecord(model.capabilities)?.supports);
  return supports?.tool_calls !== false;
}

function requestHeaders(accessToken: string, request?: ProviderRequest): Headers {
  const headers = githubCopilotRequestHeaders(accessToken);
  headers.set("x-github-api-version", "2026-06-01");
  if (request !== undefined) {
    const last = request.messages.at(-1);
    headers.set("x-initiator", last?.role === "user" ? "user" : "agent");
    headers.set("openai-intent", "conversation-edits");
    if (request.messages.some((message) => message.content.some((block) => block.type === "image"))) {
      headers.set("copilot-vision-request", "true");
    }
  }
  return headers;
}

function mapEvent(event: AdapterEvent): AdapterEvent {
  return event.type === "unknown_provider_event"
    ? { ...event, provider: "github-copilot" }
    : event;
}

export class GitHubCopilotAdapter implements ProviderAdapter {
  readonly id = "github-copilot" as const;
  readonly #credential: (signal?: AbortSignal) => Promise<GitHubCopilotCredential>;
  readonly #fetch: FetchLike;
  readonly #protocols = new Map<string, CopilotProtocol>();

  constructor(config: GitHubCopilotConfig) {
    if (typeof config.credential !== "function") throw new TypeError("GitHub Copilot credential source is required");
    this.#credential = config.credential;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let protocol = this.#protocols.get(request.model);
    if (protocol === undefined) {
      try {
        await this.listModels(signal);
      } catch {}
      protocol = this.#protocols.get(request.model) ?? protocolFor(request.model);
    }
    const credential = await this.#credential(signal);
    const baseUrl = githubCopilotBaseUrl(credential.accessToken, credential.enterpriseHost);
    assertSecureEndpoint(baseUrl, "GitHub Copilot API base URL");
    const headers = requestHeaders(credential.accessToken, request);
    const delegate: ProviderAdapter = protocol === "anthropic-messages"
      ? new AnthropicAdapter({
          accessToken: credential.accessToken,
          baseUrl: `${baseUrl}/v1`,
          headers: {
            ...Object.fromEntries(headers),
            "anthropic-dangerous-direct-browser-access": "true",
          },
          fetch: this.#fetch,
        })
      : protocol === "openai-responses"
        ? new OpenAIResponsesAdapter({
            accessToken: credential.accessToken,
            baseUrl,
            headers,
            fetch: this.#fetch,
          })
        : new OpenAICompatibleAdapter({
            id: this.id,
            baseUrl,
            accessToken: credential.accessToken,
            headers,
            fetch: this.#fetch,
          });
    const delegatedRequest = { ...request, provider: delegate.id };
    for await (const event of delegate.stream(delegatedRequest, signal)) yield mapEvent(event);
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const credential = await this.#credential(signal);
    const baseUrl = githubCopilotBaseUrl(credential.accessToken, credential.enterpriseHost);
    assertSecureEndpoint(baseUrl, "GitHub Copilot API base URL");
    const response = await this.#fetch(`${baseUrl}/models`, {
      headers: requestHeaders(credential.accessToken),
      signal,
      redirect: "error",
    });
    await assertResponseOk(response);
    const body = asRecord(await readJsonResponse(response));
    const observedAt = new Date().toISOString();
    const models: ModelInfo[] = [];
    this.#protocols.clear();
    for (const raw of asArray(body?.data)) {
      const model = asRecord(raw);
      if (model === undefined || !selectableModel(model)) continue;
      const id = catalogId(model.id);
      if (id === undefined) continue;
      const protocol = protocolFor(id, model);
      this.#protocols.set(id, protocol);
      const supports = asRecord(asRecord(model.capabilities)?.supports);
      const tools = capability("supported", observedAt);
      const reasoning = capability(
        supports?.reasoning_effort === true || supports?.thinking === true || /^(?:claude-|gpt-5|gemini-)/u.test(id)
          ? "supported"
          : "unknown",
        observedAt,
      );
      const images = capability(
        supports?.vision === true || supports?.image_input === true
          ? "supported"
          : supports?.vision === false || supports?.image_input === false
            ? "unsupported"
            : "unknown",
        observedAt,
      );
      const compatibility = baseModelCompatibility(protocol, tools, observedAt);
      if (images.value === "supported") compatibility.inputModalities = modelEvidence(["text", "image"], "provider", observedAt);
      const info: ModelInfo = {
        id,
        provider: this.id,
        capabilities: { tools, reasoning, images },
        compatibility,
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model.name) ?? asString(model.display_name);
      const description = asString(model.description);
      const contextTokens = numericMetadata(model, new Set(["max_context_window_tokens", "context_window", "context_window_tokens"]));
      const maxOutputTokens = numericMetadata(model, new Set(["max_output_tokens", "max_tokens"]));
      if (displayName !== undefined) info.displayName = displayName;
      if (description !== undefined) info.description = description;
      if (contextTokens !== undefined) info.contextTokens = contextTokens;
      if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
      models.push(info);
    }
    return models.sort((left, right) => left.id.localeCompare(right.id));
  }
}
