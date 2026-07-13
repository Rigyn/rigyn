import { uiMarkdown, uiPanel, uiStack, uiText } from "rigyn/tui";

export default function activate(api) {
  api.registerCommand({
    name: "overlay-demo",
    description: "Open a focused structural overlay example.",
    async execute({ ui }) {
      const passive = ui.showOverlay(() => uiPanel(
        uiText("Overlay example active", { role: "success" }),
        { title: "Status", padding: 0 },
      ), {
        overlayOptions: { anchor: "top-right", width: 28, maxHeight: 3, nonCapturing: true },
      });

      let value = "type, then press Enter";
      const result = await ui.custom((host) => {
        const content = uiStack([
          {
            render(context) {
              return uiText(value, {
                role: context.focused ? "accent" : "muted",
                maxLines: 2,
              }).render(context);
            },
          },
          uiMarkdown("**Enter** accept · `Esc` cancel", { role: "muted", maxLines: 2 }),
        ]);
        const panel = uiPanel(content, { title: "Custom overlay" });
        return {
          render: panel.render,
          handleKey(event) {
            if (event.key === "escape") {
              host.close(undefined);
              return true;
            }
            if (event.key === "enter") {
              host.close(value);
              return true;
            }
            if (event.key !== "text" || event.text === undefined) return false;
            value = value === "type, then press Enter" ? event.text : `${value}${event.text}`;
            host.requestRender();
            return true;
          },
        };
      }, {
        overlay: true,
        overlayOptions: { anchor: "center", width: 44, minWidth: 24, maxHeight: 8, margin: 1 },
      });

      passive.close();
      await passive.result;
      ui.notify(result === undefined ? "Overlay cancelled." : `Overlay result: ${result}`);
    },
  });
}
