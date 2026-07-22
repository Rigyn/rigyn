import {
  createScriptedProvider,
  type ScriptedProviderStep,
  type ScriptedTurn,
} from "rigyn/testing";

const turn = {
  kind: "turn",
  content: [{ type: "text", text: "typed public test support" }],
} satisfies ScriptedTurn;

const scripts: ScriptedProviderStep[] = [turn];
const provider = createScriptedProvider({
  id: "typed-scripted",
  models: [{ id: "typed-model", capabilities: { images: "supported" } }],
  scripts,
});

void provider.capturedRequests;
