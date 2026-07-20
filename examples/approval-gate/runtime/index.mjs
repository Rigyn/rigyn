import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

const MARKER = ".rigyn-approval-example";

function staleApproval() {
  return {
    content: "The marker changed while approval was open and was preserved.",
    isError: true,
    status: "error",
    summary: "The approved file snapshot is stale.",
    nextActions: ["Inspect the file, then request the action again if it is still appropriate."],
  };
}

function sameFile(left, right) {
  return right.isFile() && !right.isSymbolicLink()
    && right.dev === left.dev
    && right.ino === left.ino
    && right.size === left.size
    && right.mtimeNs === left.mtimeNs
    && right.ctimeNs === left.ctimeNs;
}

export default function activate(api) {
  api.registerTool({
    name: "delete_example_marker",
    description: `Delete only the ${MARKER} regular file in the active workspace after native user confirmation.`,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    executionMode: "sequential",
    resources(_input, context) {
      return [{ kind: "file", key: join(context.workspace.root, MARKER), mode: "write" }];
    },
    async execute(_input, context) {
      context.signal.throwIfAborted();
      const path = join(context.workspace.root, MARKER);
      let before;
      try {
        before = await lstat(path, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") {
          return {
            content: `${MARKER} does not exist.`,
            isError: false,
            status: "warning",
            summary: "No example marker was present.",
            nextActions: [],
          };
        }
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        return {
          content: `${MARKER} is not a regular file and was preserved.`,
          isError: true,
          status: "error",
          summary: "Refused to delete a non-regular marker path.",
          nextActions: ["Inspect the marker path manually."],
        };
      }
      if (!context.hasUI) {
        return {
          content: "Interactive confirmation is unavailable; no file was changed.",
          isError: true,
          status: "error",
          summary: "Approval is required in an interactive host.",
          nextActions: ["Run the action from the interactive terminal and approve it there."],
        };
      }
      const approved = await context.ui.confirm(
        "Delete example marker?",
        `Delete ${MARKER} from the active workspace?`,
        context.signal,
      );
      context.signal.throwIfAborted();
      if (!approved) {
        return {
          content: "The user declined; no file was changed.",
          isError: false,
          status: "warning",
          summary: "Deletion was declined.",
          nextActions: [],
        };
      }
      let current;
      try {
        current = await lstat(path, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") return staleApproval();
        throw error;
      }
      if (!sameFile(before, current)) return staleApproval();
      context.signal.throwIfAborted();
      await unlink(path);
      return {
        content: `Deleted ${MARKER}.`,
        isError: false,
        status: "success",
        summary: "Deleted the approved example marker.",
        nextActions: [],
      };
    },
  });
}
