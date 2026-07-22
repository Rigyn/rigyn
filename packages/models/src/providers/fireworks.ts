import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function fireworksProvider(): Provider { return createBuiltinProvider("fireworks"); }
