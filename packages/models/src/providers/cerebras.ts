import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function cerebrasProvider(): Provider { return createBuiltinProvider("cerebras"); }
