import { Editor } from "rigyn/tui";

class LabeledEditor extends Editor {
  render(width) {
    return ["example editor", ...super.render(width)];
  }
}

export default function activate(rigyn) {
  rigyn.registerCommand("example-editor-enable", {
    description: "Replace the primary editor for this extension generation",
    async handler(_args, context) {
      context.ui.setEditorComponent((tui, theme) => new LabeledEditor(tui, theme, { paddingX: 1 }));
      context.ui.notify("Example editor enabled.", "info");
    },
  });
  rigyn.registerCommand("example-editor-disable", {
    description: "Restore the host editor",
    async handler(_args, context) {
      context.ui.setEditorComponent(undefined);
      context.ui.notify("Host editor restored.", "info");
    },
  });
}
