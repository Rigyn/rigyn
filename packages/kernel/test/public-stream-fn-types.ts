import {
  Agent,
  setDefaultStreamFn,
  type AgentOptions,
  type StreamFn,
} from "../src/index.js";

declare const streamFn: StreamFn;

const canonical = { streamFn } satisfies AgentOptions;
const legacy = { streamFunction: streamFn } satisfies AgentOptions;
const both = { streamFn, streamFunction: streamFn } satisfies AgentOptions;

const canonicalAgent = new Agent(canonical);
const legacyAgent = new Agent(legacy);
const bothAgent = new Agent(both);
const selected: StreamFn = canonicalAgent.streamFunction;
const setter: (value: StreamFn | undefined) => void = setDefaultStreamFn;

setDefaultStreamFn(streamFn);
setDefaultStreamFn(undefined);

// Source callers must select an explicit stream function. The global default is
// a runtime compatibility path for hosts and already-compiled consumers.
// @ts-expect-error AgentOptions requires streamFn or legacy streamFunction.
const missing: AgentOptions = {};

void legacyAgent;
void bothAgent;
void selected;
void setter;
void missing;
