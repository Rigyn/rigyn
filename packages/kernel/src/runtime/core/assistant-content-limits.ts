import { MAX_TOOL_CALL_STREAM_DELTA_BYTES } from "./events.js";

export const ASSISTANT_CONTENT_LIMITS = Object.freeze({
  blocks: 1_024,
  containers: 8_192,
  argumentValues: 8_192,
  argumentDepth: 59,
  fieldBytes: MAX_TOOL_CALL_STREAM_DELTA_BYTES,
  contentBytes: 8 * 1_024 * 1_024,
});
