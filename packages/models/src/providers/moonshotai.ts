import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function moonshotaiProvider(): Provider { return createBuiltinProvider("moonshotai"); }
