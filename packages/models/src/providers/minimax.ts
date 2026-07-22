import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function minimaxProvider(): Provider { return createBuiltinProvider("minimax"); }
