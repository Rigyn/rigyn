export function githubCopilotHeaders(token: string, editorVersion = "rigyn/0.1.0"): Record<string, string> {
  return { authorization: `Bearer ${token}`, "editor-version": editorVersion, "user-agent": editorVersion };
}
