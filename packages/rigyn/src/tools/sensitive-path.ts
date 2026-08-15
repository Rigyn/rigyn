export function sensitiveWorkspacePath(value: string): boolean {
  const parts = value.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => [".rigyn", ".ssh", ".aws"].includes(part.toLowerCase()))) return true;
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return name === ".env" || name.startsWith(".env.") ||
    [".npmrc", ".pypirc", "credentials", "credentials.json", "application_default_credentials.json", "id_rsa", "id_ed25519"]
      .includes(name) ||
    [".pem", ".key", ".p12", ".pfx"].some((extension) => name.endsWith(extension));
}
