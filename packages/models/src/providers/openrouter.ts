import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function openrouterProvider(): Provider { return createBuiltinProvider("openrouter"); }
