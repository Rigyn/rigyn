/** Prefer a same-name prompt in the interactive picker and slash completion. */
export function interactiveSkillCommands<T extends { name: string }>(
  skills: readonly T[],
  promptNames: Iterable<string>,
): T[] {
  const claimedNames = new Set(promptNames);
  return skills.filter((skill) => !claimedNames.has(skill.name));
}
