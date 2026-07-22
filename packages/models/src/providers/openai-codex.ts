import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function openaiCodexProvider(): Provider { return createBuiltinProvider("openai-codex"); }
