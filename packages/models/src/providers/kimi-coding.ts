import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function kimiCodingProvider(): Provider { return createBuiltinProvider("kimi-coding"); }
