import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function openaiProvider(): Provider { return createBuiltinProvider("openai"); }
