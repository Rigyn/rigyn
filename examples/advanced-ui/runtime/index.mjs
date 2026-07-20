export default function activate(api) {
  const componentHosts = new Set();
  let observedKeys = 0;
  let lastKey = "none";

  const component = (render) => (host) => {
    componentHosts.add(host);
    return {
      render,
      dispose() { componentHosts.delete(host); },
    };
  };

  api.ui.advanced.setComponent("header", "workspace", component((context) => ({
    lines: [{ spans: [
      { text: context.theme.unicode ? "◆ " : "> ", role: "accent" },
      { text: "Rigyn workspace", role: "title" },
      { text: ` · ${api.workspace}`, role: "muted" },
    ], fill: true }],
  })));
  api.ui.advanced.setComponent("widget", "activity", component(() => ({
    lines: [{ spans: [
      { text: "Observed keys", role: "muted" },
      { text: ` ${observedKeys}`, role: "info" },
      { text: ` · last ${lastKey}`, role: "muted" },
    ] }],
  })));
  api.ui.advanced.setComponent("footer", "help", component(() => ({
    lines: [{ spans: [
      { text: "Structural UI", role: "success" },
      { text: " · host input and submission remain unchanged", role: "muted" },
    ], fill: true }],
  })));

  api.ui.advanced.setWorkingIndicator({
    frames: ["·", "•", "●", "•"],
    intervalMs: 120,
  });
  api.ui.advanced.setHiddenReasoningLabel("reasoning");
  api.ui.advanced.setToolOutputExpanded(true);

  const disposeKeyObserver = api.ui.advanced.observeKeys((event) => {
    observedKeys += 1;
    lastKey = event.key;
    for (const host of componentHosts) host.requestRender();
  });
  api.onDispose(disposeKeyObserver);
}
