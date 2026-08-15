import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEventMap,
  ExtensionEventResultMap,
  ExtensionMode,
  ExtensionUIContext,
} from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

interface CapabilityRecord {
  id: string;
  status: "implemented";
  authoring: boolean;
  hosts: ExtensionMode[];
  apiMembers: string[];
  eventContracts?: Array<{
    name: keyof ExtensionEventMap;
    resultType: string;
  }>;
  docs: string[];
  examples: string[];
  tests: string[];
}

interface CapabilityMatrix {
  schemaVersion: number;
  hosts: ExtensionMode[];
  capabilities: CapabilityRecord[];
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALL_HOSTS = ["tui", "print", "json", "rpc", "serve", "sdk"] as const satisfies readonly ExtensionMode[];

const EVENT_RESULT_TYPES = {
  resources_discover: "ResourcesDiscoverResult | void",
  project_trust: "ProjectTrustEventResult | void",
  session_start: "void",
  session_info_changed: "void",
  session_before_switch: "SessionBeforeSwitchResult | void",
  session_before_fork: "SessionBeforeForkResult | void",
  session_before_tree: "SessionBeforeTreeResult | void",
  session_tree: "void",
  session_before_compact: "SessionBeforeCompactResult | void",
  session_compact: "void",
  session_shutdown: "void",
  context: "ContextEventResult | void",
  before_provider_request: "BeforeProviderRequestEventResult | void",
  before_provider_headers: "void",
  after_provider_response: "void",
  before_agent_start: "BeforeAgentStartEventResult | void",
  agent_start: "void",
  agent_end: "void",
  agent_settled: "void",
  turn_start: "void",
  turn_end: "void",
  message_start: "void",
  message_update: "void",
  message_end: "MessageEndEventResult | void",
  tool_execution_start: "void",
  tool_execution_update: "void",
  tool_execution_end: "void",
  model_select: "void",
  thinking_level_select: "void",
  input: "InputEventResult | void",
  user_bash: "UserBashEventResult | void",
  tool_call: "ToolCallEventResult | void",
  tool_result: "ToolResultEventResult | void",
} as const satisfies Record<keyof ExtensionEventResultMap, string>;

const DOCUMENTED_API_MEMBERS = [
  "appendEntry",
  "config",
  "events",
  "exec",
  "getActiveTools",
  "getAllTools",
  "getCommands",
  "getDiscoveryView",
  "getFlag",
  "getSessionName",
  "getThinkingLevel",
  "on",
  "onDispose",
  "processes",
  "registerCommand",
  "registerEntryRenderer",
  "registerFlag",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerProvider",
  "registerShortcut",
  "registerTool",
  "sendMessage",
  "sendUserMessage",
  "setActiveTools",
  "setLabel",
  "setModel",
  "setSessionName",
  "setThinkingLevel",
  "unregisterProvider",
] as const satisfies readonly (keyof ExtensionAPI)[];

type UndocumentedExtensionApiMember = Exclude<keyof ExtensionAPI, (typeof DOCUMENTED_API_MEMBERS)[number]>;
const extensionApiMemberInventoryIsComplete: Record<UndocumentedExtensionApiMember, never> = {};
void extensionApiMemberInventoryIsComplete;

type CapabilityApiMember =
  | keyof ExtensionAPI
  | keyof ExtensionContext
  | keyof ExtensionCommandContext
  | keyof ExtensionUIContext;

const CAPABILITY_API_MEMBERS = [
  "appendEntry",
  "compact",
  "config",
  "events",
  "exec",
  "fork",
  "getActiveTools",
  "getAllTools",
  "getCommands",
  "getContextUsage",
  "getDiscoveryView",
  "getFlag",
  "getSessionName",
  "getSystemPrompt",
  "getThinkingLevel",
  "navigateTree",
  "newSession",
  "on",
  "onDispose",
  "paths",
  "processes",
  "refresh",
  "registerCommand",
  "registerEntryRenderer",
  "registerFlag",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerProvider",
  "registerShortcut",
  "registerTool",
  "sendMessage",
  "sendUserMessage",
  "sessionManager",
  "setActiveTools",
  "setEditorComponent",
  "setLabel",
  "setModel",
  "setSessionName",
  "setThinkingLevel",
  "switchSession",
  "ui",
  "unregisterProvider",
] as const satisfies readonly CapabilityApiMember[];

const TUI_ONLY_CAPABILITIES = new Set([
  "interactive-shortcuts",
  "trusted-ui-surfaces",
  "trusted-editor-ui",
  "terminal-workbench-ui",
]);

test("direct factories receive the complete documented generation API", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-extension-api-surface-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const observed: string[][] = [];
  const host = await loadDirectExtensions([], {
    workspace,
    inlineExtensions: [{
      name: "surface",
      factory(api) {
      observed.push(Reflect.ownKeys(api).filter((key): key is string => typeof key === "string").sort());
      },
    }],
  });
  context.after(async () => await host.close());

  assert.equal(observed.length, 1);
  for (const member of DOCUMENTED_API_MEMBERS) {
    assert.equal(observed[0]!.includes(member), true, member);
  }
  assert.equal(observed[0]!.includes("ui"), false, "UI is callback-scoped");
});

test("the public callback mode union covers every host-facing execution mode", () => {
  assert.deepEqual([...ALL_HOSTS], ["tui", "print", "json", "rpc", "serve", "sdk"]);
});

function unique(values: readonly string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

async function assertPackagePath(relativePath: string): Promise<void> {
  assert.equal(relativePath.startsWith("/") || relativePath.includes("\\"), false, relativePath);
  const path = resolve(packageRoot, relativePath);
  assert.equal(path.startsWith(`${packageRoot}${sep}`), true, `${relativePath} escapes the package root`);
  await access(path);
}

async function exampleAccessedMembers(relativeRoot: string): Promise<Set<string>> {
  const root = join(packageRoot, relativeRoot);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    rigyn?: { extensions?: string[] };
  };
  const entries = manifest.rigyn?.extensions;
  assert.notEqual(entries, undefined, `${relativeRoot} has no extension entries`);
  const members = new Set<string>();
  for (const entry of entries ?? []) {
    const source = await readFile(join(root, entry), "utf8");
    for (const match of source.matchAll(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/gu)) members.add(match[1]!);
  }
  return members;
}

test("extension capability metadata validates every referenced artifact and example package", async () => {
  const matrix = JSON.parse(
    await readFile(join(packageRoot, "docs/extension-capabilities.json"), "utf8"),
  ) as CapabilityMatrix;
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(matrix.hosts, [...ALL_HOSTS]);
  unique(matrix.hosts, "host inventory");
  unique(matrix.capabilities.map((capability) => capability.id), "capability ids");

  const documentedMembers = new Set<string>();
  const documentedEvents = new Set<keyof ExtensionEventMap>();
  const documentedExamples = new Set<string>();
  const exampleMembers = new Map<string, Set<string>>();
  for (const capability of matrix.capabilities) {
    assert.match(capability.id, /^[a-z][a-z0-9-]*$/u);
    assert.equal(capability.status, "implemented", capability.id);
    assert.equal(capability.authoring, true, capability.id);
    assert.equal(capability.hosts.length > 0, true, capability.id);
    unique(capability.hosts, `${capability.id} hosts`);
    for (const host of capability.hosts) {
      assert.equal(ALL_HOSTS.includes(host), true, `${capability.id} has unknown host ${host}`);
    }
    const expectedHosts = TUI_ONLY_CAPABILITIES.has(capability.id)
      ? ["tui"]
      : capability.id === "session-flow-controls"
        ? ALL_HOSTS.filter((host) => host !== "serve")
        : [...ALL_HOSTS];
    assert.deepEqual(capability.hosts, expectedHosts, `${capability.id} host coverage drifted`);
    for (const member of capability.apiMembers) documentedMembers.add(member);
    for (const contract of capability.eventContracts ?? []) {
      assert.equal(documentedEvents.has(contract.name), false, `${contract.name} has multiple capability owners`);
      documentedEvents.add(contract.name);
      assert.equal(contract.resultType, EVENT_RESULT_TYPES[contract.name], `${contract.name} result contract drifted`);
      assert.equal(
        capability.docs.includes("docs/extension-events.md"),
        true,
        `${contract.name} has no event documentation claim`,
      );
    }
    for (const example of capability.examples) documentedExamples.add(example);
    for (const path of [...capability.docs, ...capability.examples, ...capability.tests]) {
      await assertPackagePath(path);
    }
    const accessed = new Set<string>();
    for (const example of capability.examples) {
      let members = exampleMembers.get(example);
      if (members === undefined) {
        members = await exampleAccessedMembers(example);
        exampleMembers.set(example, members);
      }
      for (const member of members) accessed.add(member);
    }
    for (const member of capability.apiMembers) {
      assert.equal(accessed.has(member), true, `${capability.id} examples do not exercise ${member}`);
    }
  }

  for (const member of DOCUMENTED_API_MEMBERS) {
    assert.equal(documentedMembers.has(member), true, `${member} is absent from the capability matrix`);
  }
  assert.deepEqual(
    [...documentedEvents].sort(),
    (Object.keys(EVENT_RESULT_TYPES) as Array<keyof ExtensionEventMap>).sort(),
    "the capability matrix must own every public event and result contract exactly once",
  );
  const shortcut = matrix.capabilities.find((capability) => capability.apiMembers.includes("registerShortcut"));
  assert.deepEqual(shortcut?.hosts, ["tui"]);
  assert.deepEqual([...documentedMembers].sort(), [...CAPABILITY_API_MEMBERS].sort());

  const packageExamples: string[] = [];
  for (const entry of await readdir(join(packageRoot, "examples"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(packageRoot, "examples", entry.name, "package.json"));
      packageExamples.push(`examples/${entry.name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert.deepEqual([...documentedExamples].sort(), packageExamples.sort());
});
