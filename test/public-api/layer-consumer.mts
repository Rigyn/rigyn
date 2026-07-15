import {
  SecretRedactor,
  type AuthCredential,
} from "rigyn/auth";
import {
  parseJsoncObject,
  type HarnessConfig,
} from "rigyn/config";
import {
  deriveContextBudget,
  type ContextBudget,
} from "rigyn/context";
import {
  ABSOLUTE_CHILD_RUN_LIMITS,
  DEFAULT_CHILD_RUN_POLICY,
  HarnessError,
  type ChildRunPolicy,
  type ProviderAdapter,
} from "rigyn/core";
import {
  ExtensionCatalog,
  type ExtensionBundle,
} from "rigyn/extensions";
import {
  sniffImageMediaType,
  type ClipboardImage,
} from "rigyn/images";
import {
  RpcClient,
  RPC_ERROR_CODES,
  RpcWriter,
  renderRpcErrorReference,
  renderRpcMethodReference,
  renderRpcNotificationReference,
  spawnRigynRpcClient,
  spawnRpcClient,
  type RpcMethodMap,
  type RpcNotificationMap,
  type RpcRequest,
  type SpawnRigynRpcClientOptions,
} from "rigyn/interfaces";
import {
  createNetworkTransport,
  type NetworkTransport,
} from "rigyn/net";
import {
  DirectProcessRunner,
  type ProcessRunner,
} from "rigyn/process";
import { buildSystemPrompt } from "rigyn/prompts";
import {
  ProviderRegistry,
  type ModelCatalogStatus,
} from "rigyn/providers";
import {
  buildHarnessResourceCatalog,
  HarnessService,
  type HarnessOptions,
  type HarnessResourceCatalog,
} from "rigyn/service";
import {
  SessionStore,
  type ThreadRecord,
} from "rigyn/storage";
import {
  ToolRegistry,
  type HarnessTool,
} from "rigyn/tools";
import {
  fuzzyScore,
  uiMarkdown,
  uiPanel,
  uiStack,
  uiText,
  type RuntimeUiMarkdownOptions,
  type RuntimeUiPanelOptions,
  type RuntimeUiStackOptions,
  type RuntimeUiTextOptions,
  type RuntimeUiView,
  type Theme,
} from "rigyn/tui";

const textOptions = { role: "success", maxLines: 2 } satisfies RuntimeUiTextOptions;
const markdownOptions = { role: "muted", maxLines: 2 } satisfies RuntimeUiMarkdownOptions;
const stackOptions = { gap: 1, maxLines: 5 } satisfies RuntimeUiStackOptions;
const panelOptions = { title: "Consumer", padding: 1 } satisfies RuntimeUiPanelOptions;
const rigynRpcOptions = { args: ["--workspace", process.cwd()] } satisfies SpawnRigynRpcClientOptions;
void rigynRpcOptions;
const componentKitView: RuntimeUiView = uiPanel(uiStack([
  uiText("ready", textOptions),
  uiMarkdown("**public** view", markdownOptions),
], stackOptions), panelOptions);
const componentKitBlock = componentKitView.render({
  width: 20,
  height: 8,
  focused: false,
  expanded: false,
  theme: { name: "dark", color: true, unicode: true },
});
void componentKitBlock.lines;

export const layerValues = [
  SecretRedactor,
  parseJsoncObject,
  deriveContextBudget,
  ABSOLUTE_CHILD_RUN_LIMITS,
  DEFAULT_CHILD_RUN_POLICY,
  HarnessError,
  ExtensionCatalog,
  sniffImageMediaType,
  RpcClient,
  RPC_ERROR_CODES,
  RpcWriter,
  renderRpcErrorReference,
  renderRpcMethodReference,
  renderRpcNotificationReference,
  spawnRigynRpcClient,
  spawnRpcClient,
  createNetworkTransport,
  DirectProcessRunner,
  buildSystemPrompt,
  ProviderRegistry,
  HarnessService,
  buildHarnessResourceCatalog,
  SessionStore,
  ToolRegistry,
  fuzzyScore,
  uiMarkdown,
  uiPanel,
  uiStack,
  uiText,
] as const;

export interface LayerConsumerContracts {
  auth: AuthCredential;
  config: HarnessConfig;
  context: ContextBudget;
  core: ProviderAdapter & { childRuns?: ChildRunPolicy };
  extensions: ExtensionBundle;
  images: ClipboardImage;
  interfaces: RpcRequest & { methods?: RpcMethodMap; notifications?: RpcNotificationMap };
  net: NetworkTransport;
  process: ProcessRunner;
  providers: ModelCatalogStatus;
  service: HarnessOptions & { catalog?: HarnessResourceCatalog };
  storage: ThreadRecord;
  tools: HarnessTool;
  tui: Theme & { view?: RuntimeUiView };
}
