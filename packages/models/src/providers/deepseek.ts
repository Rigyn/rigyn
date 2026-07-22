import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function deepseekProvider(): Provider { return createBuiltinProvider("deepseek"); }
