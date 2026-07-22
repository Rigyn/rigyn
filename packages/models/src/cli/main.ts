import type { Readable, Writable } from "node:stream";

import type { AuthInteraction, OAuthAuth } from "../auth/types.js";
import type { Provider } from "../models.js";
import { builtinProviders } from "../providers/all.js";
import {
  OAuthCredentialFileError,
  OAuthFileCredentialStore,
  prepareOAuthCredentialFile,
} from "./credential-file.js";
import {
  createTerminalAuthInteraction,
  type ClosableAuthInteraction,
} from "./terminal-interaction.js";

const MAX_PROVIDERS = 64;
const MAX_PROVIDER_ID_LENGTH = 128;

export const AI_CLI_EXIT = Object.freeze({
  success: 0,
  failure: 1,
  usage: 2,
  cancelled: 130,
} as const);

const HELP = `Usage: rigyn-models <command>

Commands:
  list                 List providers that support OAuth login
  login [provider]     Authenticate with a provider; prompts when omitted

Options:
  -h, --help           Show this help

Credentials are written to ~/.rigyn-models/oauth.json by default. Set
RIGYN_MODELS_AUTH_FILE to an absolute path to use a different standalone store.
RIGYN_AI_AUTH_FILE remains a lower-precedence compatibility fallback.
This file is separate from the Rigyn coding-agent credential broker.
It cannot be set to the broker's auth.json path, including a custom
RIGYN_CODING_AGENT_DIR.

Exit codes: 0 success, 1 operational failure, 2 usage error, 130 cancelled.
`;

class AiCliUsageError extends Error {}

export interface OAuthProviderCandidate {
  readonly id: string;
  readonly name: string;
  readonly auth: { readonly oauth?: OAuthAuth };
}

export interface AiCliInteractionOwner {
  interaction: AuthInteraction;
  close(): void;
}

export interface RunAiCliOptions {
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  input?: Readable;
  output?: Writable;
  error?: Writable;
  signal?: AbortSignal;
  onCancel?(): void;
  providers?: readonly OAuthProviderCandidate[];
  createInteraction?(signal?: AbortSignal): AiCliInteractionOwner;
}

interface OAuthProvider {
  id: string;
  name: string;
  oauth: OAuthAuth;
}

function clean(value: string, maximum = 512): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, maximum);
}

function write(stream: Writable, value: string): void {
  stream.write(value);
}

export function discoverOAuthProviders(candidates: readonly OAuthProviderCandidate[]): OAuthProvider[] {
  const providers = candidates.flatMap((provider) => provider.auth.oauth === undefined ? [] : [{
    id: provider.id,
    name: provider.name,
    oauth: provider.auth.oauth,
  }]);
  if (providers.length > MAX_PROVIDERS) {
    throw new Error(`OAuth provider catalog exceeds the limit of ${MAX_PROVIDERS}`);
  }
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(provider.id) || ids.has(provider.id)) {
      throw new Error("OAuth provider catalog contains an invalid or duplicate identifier");
    }
    ids.add(provider.id);
  }
  return providers.sort((left, right) => left.id.localeCompare(right.id));
}

function parse(args: readonly string[]): { command: "help" | "list" | "login"; provider?: string } {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help"))) {
    return { command: "help" };
  }
  if (args[0] === "list") {
    if (args.length !== 1) throw new AiCliUsageError("list does not accept arguments");
    return { command: "list" };
  }
  if (args[0] === "login") {
    if (args.length > 2) throw new AiCliUsageError("login accepts at most one provider identifier");
    const provider = args[1];
    if (provider !== undefined && (provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH)) {
      throw new AiCliUsageError("provider identifier is invalid");
    }
    return { command: "login", ...(provider === undefined ? {} : { provider }) };
  }
  throw new AiCliUsageError(`unknown command: ${clean(args[0] ?? "", 128)}`);
}

function defaultInteraction(options: RunAiCliOptions): ClosableAuthInteraction {
  return createTerminalAuthInteraction({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onCancel === undefined ? {} : { onCancel: options.onCancel }),
  });
}

function interactionOwner(options: RunAiCliOptions): AiCliInteractionOwner {
  if (options.createInteraction) return options.createInteraction(options.signal);
  const interaction = defaultInteraction(options);
  return { interaction, close: () => interaction.close() };
}

async function selectedProvider(
  providers: readonly OAuthProvider[],
  requested: string | undefined,
  interaction: AuthInteraction,
): Promise<OAuthProvider> {
  if (requested !== undefined) {
    const selected = providers.find((provider) => provider.id === requested);
    if (!selected) throw new AiCliUsageError(`unknown OAuth provider: ${clean(requested, 128)}`);
    return selected;
  }
  if (providers.length === 0) throw new Error("No OAuth providers are available");
  const id = await interaction.prompt({
    type: "select",
    message: "Select an OAuth provider",
    options: providers.map((provider) => ({
      id: provider.id,
      label: provider.oauth.loginLabel ?? provider.oauth.name ?? provider.name,
      description: provider.id,
    })),
    ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
  });
  const selected = providers.find((provider) => provider.id === id);
  if (!selected) throw new AiCliUsageError("the selected OAuth provider is unavailable");
  return selected;
}

function cancelled(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function isUsage(error: unknown): error is AiCliUsageError {
  return error instanceof AiCliUsageError;
}

export async function runAiCli(options: RunAiCliOptions = {}): Promise<number> {
  const output = options.output ?? process.stdout;
  const errorOutput = options.error ?? process.stderr;
  let owner: AiCliInteractionOwner | undefined;
  let authenticating: string | undefined;
  try {
    const parsed = parse(options.args ?? process.argv.slice(2));
    if (parsed.command === "help") {
      write(output, HELP);
      return AI_CLI_EXIT.success;
    }
    const providers = discoverOAuthProviders(options.providers ?? builtinProviders() as Provider[]);
    if (parsed.command === "login" && parsed.provider !== undefined && !providers.some((provider) => provider.id === parsed.provider)) {
      throw new AiCliUsageError(`unknown OAuth provider: ${clean(parsed.provider, 128)}`);
    }
    const path = await prepareOAuthCredentialFile(options.environment, options.homeDirectory);
    const store = new OAuthFileCredentialStore(path);
    const configured = new Set((await store.list()).filter((entry) => entry.type === "oauth").map((entry) => entry.providerId));
    options.signal?.throwIfAborted();
    if (parsed.command === "list") {
      write(output, "OAuth providers:\n");
      for (const provider of providers) {
        const status = configured.has(provider.id) ? "authenticated" : "not authenticated";
        write(output, `  ${clean(provider.id, 128)}\t${clean(provider.oauth.loginLabel ?? provider.oauth.name ?? provider.name, 240)}\t${status}\n`);
      }
      return AI_CLI_EXIT.success;
    }
    owner = interactionOwner(options);
    const provider = await selectedProvider(providers, parsed.provider, owner.interaction);
    authenticating = provider.id;
    const credential = await provider.oauth.login(owner.interaction);
    options.signal?.throwIfAborted();
    await store.modify(provider.id, async () => credential);
    write(output, `Authenticated ${clean(provider.name, 240)}. Credentials saved to ${clean(path, 4_096)}.\n`);
    return AI_CLI_EXIT.success;
  } catch (cause) {
    if (cancelled(cause, options.signal)) {
      write(errorOutput, "Authentication cancelled.\n");
      return AI_CLI_EXIT.cancelled;
    }
    if (isUsage(cause)) {
      write(errorOutput, `rigyn-models: ${cause.message}\nRun rigyn-models --help for usage.\n`);
      return AI_CLI_EXIT.usage;
    }
    if (cause instanceof OAuthCredentialFileError) {
      write(errorOutput, `rigyn-models: ${clean(cause.message, 1_024)}\n`);
      return AI_CLI_EXIT.failure;
    }
    write(errorOutput, authenticating
      ? `rigyn-models: authentication failed for ${clean(authenticating, 128)}.\n`
      : "rigyn-models: the OAuth command failed.\n");
    return AI_CLI_EXIT.failure;
  } finally {
    owner?.close();
  }
}
