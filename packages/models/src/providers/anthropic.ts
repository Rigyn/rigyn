import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function anthropicProvider(): Provider { return createBuiltinProvider("anthropic"); }
