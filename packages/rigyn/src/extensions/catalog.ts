import type {
  ExtensionBundle,
  ExtensionDiagnostic,
  ExtensionDoctorReport,
  ExtensionMetadata,
  ExtensionPromptTemplate,
  ExtensionSlashCommand,
  ExtensionTheme,
} from "./types.js";

function cloneMetadata(value: ExtensionMetadata): ExtensionMetadata {
  return { ...value, contributions: { ...value.contributions } };
}

function cloneTheme(value: ExtensionTheme): ExtensionTheme {
  return {
    ...value,
    definition: {
      ...value.definition,
      styles: Object.fromEntries(
        Object.entries(value.definition.styles).map(([role, declaration]) => [role, { ...declaration }]),
      ),
      ...(value.definition.tokens === undefined ? {} : { tokens: { ...value.definition.tokens } }),
      ...(value.definition.export === undefined ? {} : { export: { ...value.definition.export } }),
    },
  };
}

function cloneBundle(value: ExtensionBundle): ExtensionBundle {
  return {
    skillRoots: value.skillRoots.map((root) => ({ ...root })),
    prompts: value.prompts.map((prompt) => ({ ...prompt })),
    commands: value.commands.map((command) => ({ ...command })),
    themes: value.themes.map(cloneTheme),
    runtime: value.runtime.map((entry) => ({ ...entry })),
  };
}

/** Read-only catalog projection assembled from active direct factories and resolved resources. */
export class ExtensionCatalog {
  readonly #extensions: ExtensionMetadata[];
  readonly #diagnostics: ExtensionDiagnostic[];
  readonly #bundle: ExtensionBundle;

  constructor(extensions: ExtensionMetadata[], diagnostics: ExtensionDiagnostic[], bundle: ExtensionBundle) {
    this.#extensions = extensions.map(cloneMetadata);
    this.#diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
    this.#bundle = cloneBundle(bundle);
  }

  list(): ExtensionMetadata[] {
    return this.#extensions.map(cloneMetadata);
  }

  bundle(): ExtensionBundle {
    return cloneBundle(this.#bundle);
  }

  doctor(): ExtensionDoctorReport {
    const count = (status: ExtensionMetadata["status"]): number =>
      this.#extensions.filter((entry) => entry.status === status).length;
    return {
      healthy: !this.#diagnostics.some((entry) => entry.severity === "error"),
      active: count("active"),
      blocked: count("blocked"),
      disabled: count("disabled"),
      invalid: count("invalid"),
      shadowed: count("shadowed"),
      diagnostics: this.#diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  prompt(id: string): ExtensionPromptTemplate | undefined {
    const value = this.#bundle.prompts.find((entry) => entry.id === id);
    return value === undefined ? undefined : { ...value };
  }

  command(name: string): ExtensionSlashCommand | undefined {
    const value = this.#bundle.commands.find((entry) => entry.name === name);
    return value === undefined ? undefined : { ...value };
  }

  theme(name: string): ExtensionTheme | undefined {
    const value = this.#bundle.themes.find((entry) => entry.name === name);
    return value === undefined ? undefined : cloneTheme(value);
  }
}
