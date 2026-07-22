import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function minimaxCnProvider(): Provider { return createBuiltinProvider("minimax-cn"); }
