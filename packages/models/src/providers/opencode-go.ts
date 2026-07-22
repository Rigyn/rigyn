import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function opencodeGoProvider(): Provider { return createBuiltinProvider("opencode-go"); }
