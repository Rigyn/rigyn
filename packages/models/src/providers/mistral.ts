import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function mistralProvider(): Provider { return createBuiltinProvider("mistral"); }
