const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

function target(context) {
  return {
    threadId: context.threadId,
    ...(context.branch === undefined ? {} : { branch: context.branch }),
  };
}

function offlineOverride(provider, model) {
  return {
    id: provider,
    async *stream(request, signal) {
      signal.throwIfAborted();
      const text = `Trusted override handled ${request.messages.length} message${request.messages.length === 1 ? "" : "s"}.`;
      yield { type: "response_start", model };
      yield { type: "text_delta", part: 0, text };
      yield {
        type: "response_end",
        reason: "stop",
        state: {
          kind: "chat_completions",
          assistantMessage: { role: "assistant", content: text },
        },
      };
    },
    async listModels(signal) {
      signal.throwIfAborted();
      return [{
        id: model,
        provider,
        displayName: "Trusted offline override",
        contextTokens: 4096,
        maxOutputTokens: 512,
        capabilities: {
          tools: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          reasoning: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          images: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
        },
        metadata: { offline: true, example: "trusted-native-host" },
      }];
    },
  };
}

export default function activate(api) {
  let lastResponse = "no response observed";
  let wire;
  let providerOverride;

  const refresh = new Set();
  const disposeWidget = api.native.ui.mountWidget(() => (host) => {
    refresh.add(host);
    return {
      render(context) {
        return {
          lines: [{
            spans: [
              { text: "Native host", role: "accent" },
              { text: ` · ${context.theme.name} · ${lastResponse}`, role: "muted" },
            ],
          }],
        };
      },
      dispose() { refresh.delete(host); },
    };
  });
  const disposeInput = api.native.ui.onInput(() => ({ action: "pass" }));

  api.registerCommand({
    name: "native-inspect",
    description: "Inspect the live host, current session, prompt availability, and optional credential metadata without printing secrets.",
    argumentHint: "[provider]",
    async execute(context) {
      const provider = context.args.trim();
      const configuration = await api.native.host.getConfiguration(context.signal);
      const session = await api.native.session.read({
        ...target(context),
        afterSequence: 0,
        limit: 1,
      });
      const prompt = await api.native.session.getSystemPrompt(target(context));
      const credential = provider === ""
        ? undefined
        : await api.native.credentials.resolve(provider, context.signal);
      const report = {
        workspace: configuration.workspace,
        projectTrusted: configuration.projectTrusted,
        theme: api.native.ui.currentTheme().name,
        session: {
          threadId: session.thread.threadId,
          branch: session.branch,
          snapshotSequence: session.snapshotSequence,
          hasMore: session.hasMore,
        },
        prompt: prompt === undefined ? "unavailable" : {
          bytes: Buffer.byteLength(prompt.systemPrompt, "utf8"),
          composition: prompt.composition,
        },
        credential: credential === undefined ? "not requested or unavailable" : {
          provider: credential.provider,
          source: credential.source,
          kind: credential.credential.kind,
          headerNames: Object.keys(credential.headers).sort(),
        },
      };
      return JSON.stringify(report, null, 2);
    },
  });

  api.registerCommand({
    name: "native-wire",
    description: "Observe redacted response telemetry for one provider, or disable the current observer.",
    argumentHint: "<provider|off>",
    async execute(context) {
      const provider = context.args.trim();
      if (wire !== undefined) {
        await wire();
        wire = undefined;
      }
      if (provider === "" || provider === "off") {
        context.ui.notify("Provider response observer disabled.");
        return;
      }
      wire = api.native.providers.intercept(provider, {
        observeResponse(response) {
          lastResponse = `${response.provider} ${response.status ?? "stream"}${response.requestId === undefined ? "" : ` · ${response.requestId}`}`;
          for (const host of refresh) host.requestRender();
        },
      });
      context.ui.notify(`Observing redacted response telemetry for ${provider}.`);
    },
  });

  api.registerCommand({
    name: "native-override",
    description: "Temporarily replace one existing provider with an offline diagnostic adapter, or restore it.",
    argumentHint: "<provider> [model] | off",
    async execute(context) {
      const [provider, model = "trusted-offline-v1"] = context.args.trim().split(/\s+/u);
      if (providerOverride !== undefined) {
        await providerOverride();
        providerOverride = undefined;
      }
      if (provider === "" || provider === "off") {
        context.ui.notify("Provider override restored.");
        return;
      }
      providerOverride = api.native.providers.override(offlineOverride(provider, model));
      context.ui.notify(`${provider} now uses the offline ${model} adapter until reload or /native-override off.`);
    },
  });

  api.registerCommand({
    name: "native-theme-config",
    description: "Explicitly update the user-level theme setting through the privileged host configuration API.",
    argumentHint: "<theme>",
    async execute(context) {
      const theme = context.args.trim();
      if (theme === "") {
        context.ui.notify("A theme name is required.", "error");
        return;
      }
      const configuration = await api.native.host.updateConfiguration({
        scope: "user",
        patch: { theme },
        signal: context.signal,
      });
      context.ui.notify(`User theme setting is now ${String(configuration.effective.theme)}; reload if the active host does not apply it immediately.`);
    },
  });

  api.onDispose(async () => {
    disposeInput();
    disposeWidget();
    await wire?.();
    await providerOverride?.();
  });
}
