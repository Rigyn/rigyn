import { SecretRedactor, type AuthCredential } from "rigyn/auth";
import { SettingsManager, type Settings } from "rigyn/config";
import { deriveContextBudget, type ContextBudget } from "rigyn/context";
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
import { SessionManager, type SessionEntry } from "rigyn/storage";
import { ToolRegistry, type HarnessTool } from "rigyn/tools";
import { fuzzyScore, uiText, type RuntimeUiView, type Theme } from "rigyn/tui";

export const layerValues = [
  SecretRedactor,
  SettingsManager,
  deriveContextBudget,
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
  SessionManager,
  ToolRegistry,
  fuzzyScore,
  uiText,
] as const;

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
  entry: SessionEntry;
  tool: HarnessTool;
  tui: Theme & { view?: RuntimeUiView };
}
