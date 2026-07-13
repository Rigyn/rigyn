const KEY = "profile";

function profileV2(record, fallback) {
  if (record === undefined) return { name: fallback || "anonymous", tags: [] };
  if (record.schemaVersion === 1) {
    const value = record.value;
    if (value === null || typeof value !== "object" || typeof value.label !== "string") {
      throw new Error("Stored schema 1 profile is invalid");
    }
    return { name: value.label, tags: [] };
  }
  if (record.schemaVersion === 2) {
    const value = record.value;
    if (value === null || typeof value !== "object" || typeof value.name !== "string" || !Array.isArray(value.tags)) {
      throw new Error("Stored schema 2 profile is invalid");
    }
    return { name: value.name, tags: value.tags.filter((tag) => typeof tag === "string").slice(0, 32) };
  }
  throw new Error(`Unsupported stored profile schema: ${record.schemaVersion}`);
}

export default function activate(api) {
  api.session.registerRenderers(1, {
    renderState(entry) {
      const value = entry.value;
      return { lines: [{ spans: [{ text: `Legacy profile · ${value?.label ?? "invalid"}`, role: "muted" }] }] };
    },
  });
  api.session.registerRenderers(2, {
    renderState(entry) {
      const value = entry.value;
      return { lines: [{ spans: [{ text: `Profile · ${value?.name ?? "invalid"}`, role: "info" }] }] };
    },
  });
  api.registerCommand({
    name: "migrate-profile",
    description: "Create or migrate the session profile to schema 2.",
    argumentHint: "[name]",
    async execute(context) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentV2 = await api.session.readState({
          threadId: context.threadId,
          ...(context.branch === undefined ? {} : { branch: context.branch }),
          schemaVersion: 2,
          key: KEY,
        });
        if (currentV2 !== undefined) {
          const value = profileV2(currentV2, context.args.trim());
          context.ui.notify(`Profile is already schema 2 for ${value.name}.`);
          return;
        }
        const legacy = await api.session.readState({
          threadId: context.threadId,
          ...(context.branch === undefined ? {} : { branch: context.branch }),
          schemaVersion: 1,
          key: KEY,
        });
        const value = profileV2(legacy, context.args.trim());
        const result = await api.session.compareAndAppendState({
          threadId: context.threadId,
          ...(context.branch === undefined ? {} : { branch: context.branch }),
          expectedEventId: null,
          schemaVersion: 2,
          key: KEY,
          value,
        });
        if (result.status === "committed") {
          context.ui.notify(`Profile is schema 2 for ${value.name}.`);
          return;
        }
      }
      throw new Error("Profile changed concurrently three times; retry after the other writer finishes");
    },
  });
}
