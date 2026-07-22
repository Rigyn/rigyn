import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function githubCopilotProvider(): Provider { return createBuiltinProvider("github-copilot"); }
