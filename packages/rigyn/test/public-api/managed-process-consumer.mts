import type {
  ExtensionAPI,
  ExtensionProcessId,
  ExtensionProcessResult,
  ExtensionProcessStatus,
} from "rigyn/extensions";

export async function exerciseManagedProcesses(api: ExtensionAPI): Promise<ExtensionProcessResult> {
  const id: ExtensionProcessId = api.processes.spawn({
    argv: [process.execPath, "--version"],
    stdout: "capture",
    stderr: "capture",
  });
  const status: ExtensionProcessStatus = api.processes.status(id);
  void [status.state, status.stdoutBytes, status.stderrBytes];
  return await api.processes.wait(id);
}
