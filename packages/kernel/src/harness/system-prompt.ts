import type { Skill } from "./types.js";
const escapeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation); if (visible.length === 0) return "";
  const lines = ["Specialized skills are available for matching tasks.", "Read a matching skill's full file before applying it.", "Resolve paths mentioned by a skill relative to its file's directory.", "", "<available_skills>"];
  for (const skill of visible) lines.push("  <skill>", `    <name>${escapeXml(skill.name)}</name>`, `    <description>${escapeXml(skill.description)}</description>`, `    <location>${escapeXml(skill.filePath)}</location>`, "  </skill>");
  lines.push("</available_skills>"); return lines.join("\n");
}
