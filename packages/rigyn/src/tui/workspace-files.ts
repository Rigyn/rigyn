export {
  scanWorkspaceFiles,
  type WorkspaceFileScanOptions,
} from "../tools/workspace-walker.js";

export function fileReferenceQuery(text: string): string | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(text);
  return match?.[1];
}
