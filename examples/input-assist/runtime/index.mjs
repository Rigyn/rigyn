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
}
