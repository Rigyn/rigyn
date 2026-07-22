export * from "./direct.js";
export * from "./compat.js";
export * from "./model-boundary.js";

export { ExtensionCatalog } from "./catalog.js";
export { extensionGalleryInstallSource, parseExtensionGalleryIndex } from "./gallery.js";
export {
  PROJECT_PACKAGE_DECLARATION,
  PROJECT_PACKAGE_INSTALL_ROOT,
  PROJECT_PACKAGE_LOCK,
  ProjectPackageManager,
  mergeProjectPackageResourceFilters,
  parseProjectPackageDeclaration,
  parseProjectPackageLock,
  projectPackageDeclarationSha256,
  projectPackageResourceFilters,
} from "./project-packages.js";
export { builtinSlashCommands, isBuiltinSlashCommand } from "./reserved.js";

export type {
  ProviderAmbientAuthMethod,
  ProviderApiKeyAuthMethod,
  ProviderAuthDescriptor,
  ProviderAuthDescriptorMethod,
  ProviderDeviceAuthMethod,
  ProviderPkceAuthMethod,
  ProviderAuthenticatedRequestPolicy,
  ProviderRequestAwsSigV4Auth,
  ProviderRequestHeaderAuth,
} from "../auth/provider-descriptor.js";

export type {
  ExtensionGalleryContributionCounts,
  ExtensionGalleryIndex,
  ExtensionGalleryMedia,
  ExtensionGalleryPackage,
  ExtensionGallerySource,
} from "./gallery.js";
export type {
  InstalledProjectPackage,
  ProjectPackageCatalogEntry,
  ProjectPackageCheckResult,
  ProjectPackageCheckStatus,
  ProjectPackageCommand,
  ProjectPackageCommands,
  ProjectPackageDeclaration,
  ProjectPackageDeclarationEntry,
  ProjectPackageDeclarationSource,
  ProjectPackageLock,
  ProjectPackageLockEntry,
  ProjectPackageManagerOptions,
  ProjectPackageProvenance,
  ProjectPackageReconcileResult,
  ProjectPackageResolvedSource,
  ProjectPackageUpdateOptions,
} from "./project-packages.js";
export {
  renderExtensionCommand,
  renderExtensionPrompt,
  validateTemplatePlaceholders,
} from "./templates.js";
export { loadPromptTemplates, loadThemes } from "./loose-resources.js";
export type {
  ExtensionBundle,
  ExtensionContributionCounts,
  ExtensionDiagnostic,
  ExtensionDiagnosticSeverity,
  ExtensionDoctorReport,
  ExtensionMetadata,
  ExtensionPromptTemplate,
  ExtensionRuntimeEntry,
  ExtensionScope,
  ExtensionSlashCommand,
  ExtensionStatus,
  ExtensionTheme,
} from "./types.js";
