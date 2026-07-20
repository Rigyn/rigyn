import {
  InteractiveMode,
  RpcMode,
  createRpcMode,
  runOwnedInteractiveMode,
  runInteractiveMode,
  runPrintMode,
  runRpcMode,
  type InteractiveModeOptions,
  type OwnedInteractiveModeOptions,
  type ModeSession,
  type ModeSessionOwner,
  type PrintModeOptions,
  type RpcModeOptions,
} from "rigyn/modes";
import type { HarnessRuntime } from "rigyn";
import type { EmbeddingHarness } from "rigyn/embedding";
import type { RigynSdk } from "rigyn/sdk";

declare const session: ModeSession;
declare const owner: ModeSessionOwner;
declare const runtime: HarnessRuntime;
declare const embedding: EmbeddingHarness;
declare const sdk: RigynSdk;

const printOptions = { prompts: ["inspect", "verify"], format: "json" } satisfies PrintModeOptions;
const interactiveOptions = {
  run: { selection: { provider: "host", model: "model" } },
  terminal: { mode: "accessible", handleSignals: false },
} satisfies InteractiveModeOptions;
const rpcOptions = { peerId: "consumer" } satisfies RpcModeOptions;
const ownedInteractiveOptions = {
  session: { name: "consumer" },
  historyEvents: 512,
  delegatedCommands: {
    context: (_args, context) => context.terminal.notify("Host context view"),
  },
  delegatedActions: {
    paste_image: (_action, context) => context.terminal.notify("Host image paste"),
  },
} satisfies OwnedInteractiveModeOptions;

const interactive: InteractiveMode = new InteractiveMode(session, interactiveOptions);
const rpc: RpcMode = createRpcMode(runtime, rpcOptions);
void [
  interactive,
  rpc,
  runPrintMode(owner, printOptions),
  runPrintMode(embedding, printOptions),
  runPrintMode(sdk, printOptions),
  runInteractiveMode(owner, interactiveOptions),
  runOwnedInteractiveMode(runtime, ownedInteractiveOptions),
  runRpcMode(runtime, async (peer) => await peer.request("health"), rpcOptions),
];
