import { SecretRedactor, type AuthCredential } from "rigyn/auth";
import { SettingsManager, type Settings } from "rigyn/config";
import { deriveContextBudget, estimateToolDefinitionTokens, type ContextBudget } from "rigyn/context";
import { HarnessError, type RuntimeEvent } from "rigyn/core";
import { defineTool, type ExtensionFactory } from "rigyn/extensions";
import { createImagesModels, type ImagesModels } from "rigyn/images";
import {
  RpcClient,
  RpcWriter,
  parseRpcInput,
  type RpcCommand,
  type RpcResponse,
} from "rigyn/interfaces";
import { createNetworkTransport, type NetworkTransport } from "rigyn/net";
import { DirectProcessRunner, type ProcessRunner } from "rigyn/process";
import { buildSystemPrompt } from "rigyn/prompts";
import { ModelRegistry, ProviderRegistry, type ProviderModel } from "rigyn/providers";
import { AgentSession, buildHarnessResourceCatalog, type HarnessResourceCatalog } from "rigyn/service";
import {
  startServeServer,
  type ServeCreateSessionRequest,
  type ServeOpenSessionRequest,
  type ServeServer,
  type ServeSessionFactory,
  type ServeSessionRuntime,
  type StartServeServerOptions,
} from "rigyn/serve";
import { SessionManager, type SessionBranchQuery, type SessionEntry } from "rigyn/storage";
import { ToolRegistry, type HarnessTool } from "rigyn/tools";
import {
  fuzzyScore,
  uiText,
  type RuntimeUiView,
  type Theme,
  type TuiControllerOptions,
} from "rigyn/tui";

const fixedViewportOptions = { mode: "full" } satisfies TuiControllerOptions;
// @ts-expect-error The product rich viewport has no selectable screen host.
const removedScreenOverride: TuiControllerOptions = { alternateScreen: false };
void [fixedViewportOptions, removedScreenOverride];

export const layerValues = [
  SecretRedactor,
  SettingsManager,
  deriveContextBudget,
  estimateToolDefinitionTokens,
  HarnessError,
  defineTool,
  createImagesModels,
  RpcClient,
  RpcWriter,
  parseRpcInput,
  createNetworkTransport,
  DirectProcessRunner,
  buildSystemPrompt,
  ModelRegistry,
  ProviderRegistry,
  AgentSession,
  buildHarnessResourceCatalog,
  startServeServer,
  SessionManager,
  ToolRegistry,
  fuzzyScore,
  uiText,
] as const;

declare const serveRuntime: ServeSessionRuntime;
void serveRuntime.suspendedRun?.effects.map((effect) => `${effect.effectId}:${effect.status}`);
void serveRuntime.recoverInterruptedRun({
  resolutions: [{ effectId: "verified-effect", outcome: "abandoned" }],
});

export interface LayerConsumerContracts {
  auth: AuthCredential;
  config: Settings;
  context: ContextBudget;
  extension: ExtensionFactory;
  images: ImagesModels;
  command: RpcCommand;
  response: RpcResponse;
  event: RuntimeEvent;
  net: NetworkTransport;
  process: ProcessRunner;
  model: ProviderModel;
  catalog: HarnessResourceCatalog;
  serve: {
    create: ServeCreateSessionRequest;
    open: ServeOpenSessionRequest;
    server: ServeServer;
    factory: ServeSessionFactory;
    runtime: ServeSessionRuntime;
    options: StartServeServerOptions;
  };
  entry: SessionEntry;
  branchQuery: SessionBranchQuery;
  tool: HarnessTool;
  tui: Theme & { view?: RuntimeUiView };
}
