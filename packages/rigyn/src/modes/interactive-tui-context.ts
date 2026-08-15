import type { AgentSession } from "../service/agent-session.js";
import type { TuiContext } from "../tui/types.js";
import { RIGYN_VERSION } from "../version.js";

export function createInteractiveTuiContext(
  session: AgentSession,
  workspace: string,
  sessionName: string | undefined,
  active: boolean,
  options: { includeContextUsage?: boolean; operationOnly?: boolean } = {},
): TuiContext {
  const model = session.nativeModel;
  const contextUsage = options.includeContextUsage === false
    ? undefined
    : session.getContextUsage();
  const contextTokens = contextUsage?.tokens;
  return {
    threadId: session.sessionId,
    sessionName,
    workspace,
    releaseVersion: RIGYN_VERSION,
    provider: model?.provider,
    model: model?.id,
    contextWindowTokens: model?.info?.contextTokens,
    ...(contextTokens === null || contextTokens === undefined ? {} : { contextTokens }),
    ...(contextUsage?.source === undefined ? {} : { contextSource: contextUsage.source }),
    thinking: session.thinkingLevel,
    thinkingSupported: model === undefined ? undefined : session.supportsThinking(),
    active,
    status: active ? options.operationOnly === true ? "working" : "streaming" : "idle",
    autoCompaction: session.autoCompactionEnabled,
    ...(contextUsage?.autoCompactionThresholdPercent === undefined
      ? {}
      : { autoCompactionThresholdPercent: contextUsage.autoCompactionThresholdPercent }),
  };
}
