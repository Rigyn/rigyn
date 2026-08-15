import {
  ExtensionConfigConflictError,
  createExtensionConfigStore,
  type ExtensionConfigSnapshot,
  type ExtensionConfigStore,
} from "rigyn/extensions";

declare const userRoot: string;
declare const workspaceRoot: string;

export const extensionConfigStore: ExtensionConfigStore = createExtensionConfigStore({
  roots: { user: userRoot, workspace: workspaceRoot },
  writable: () => true,
});

export async function replaceExtensionConfig(
  prior: ExtensionConfigSnapshot,
): Promise<ExtensionConfigSnapshot> {
  try {
    return await extensionConfigStore.replace("workspace", { version: 1 }, {
      expectedRevision: prior.revision,
    });
  } catch (error) {
    if (error instanceof ExtensionConfigConflictError) {
      void error.currentRevision;
    }
    throw error;
  }
}
