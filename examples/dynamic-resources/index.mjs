export default function activate(api) {
  api.on("resources_discover", (_event, context) => {
    context.signal.throwIfAborted();
    return {
      skillPaths: ["SKILL.md"],
      promptPaths: ["dynamic-resource.md"],
      themePaths: ["dynamic-resource.json"],
    };
  });
}
