import { cellWidth, splitGraphemes } from "rigyn/tui";

export default function activate(api) {
  const graphemes = (value) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((entry) => entry.segment);
  api.ui.registerAutocompleteProvider(({ text, cursor }) => {
    const before = graphemes(text).slice(0, cursor).join("");
    const match = /(?:^|\s):([a-z]*)$/u.exec(before);
    if (match === null) return null;
    const values = [":review", ":test", ":summarize"].filter((value) => value.startsWith(`:${match[1]}`));
    const start = cursor - match[0].trimStart().length;
    return values.map((value) => ({ start, end: cursor, value, label: value, detail: "Input-assist example" }));
  });

  api.ui.registerEditorMiddleware((event, snapshot) => {
    if (event.key !== "text" || event.text !== ";") return { action: "pass" };
    const text = graphemes(snapshot.text);
    if (text[snapshot.cursor - 1] !== ";") return { action: "pass" };
    text.splice(snapshot.cursor - 1, 1, "—");
    return { action: "replace", text: text.join(""), cursor: snapshot.cursor };
  });

  api.registerEditorRenderer({
    render(view, context) {
      const prefix = context.width >= 8 ? (view.mode === "follow_up" ? "next> " : "you> ") : "";
      const available = Math.max(1, context.width - prefix.length);
      const text = splitGraphemes(view.text);
      let start = view.cursor;
      let beforeCells = 0;
      while (start > 0) {
        const width = cellWidth(text[start - 1]);
        if (beforeCells + width > available) break;
        start -= 1;
        beforeCells += width;
      }
      let end = start;
      let visibleCells = 0;
      while (end < text.length) {
        const width = cellWidth(text[end]);
        if (visibleCells + width > available) break;
        visibleCells += width;
        end += 1;
      }
      const visible = text.slice(start, end).join("");
      return {
        lines: [{ spans: [
          ...(prefix === "" ? [] : [{ text: prefix, role: view.blocked ? "muted" : "accent" }]),
          { text: visible },
        ] }],
        cursor: { row: 0, column: cellWidth(prefix) + cellWidth(text.slice(start, view.cursor).join("")) },
      };
    },
  });
}
