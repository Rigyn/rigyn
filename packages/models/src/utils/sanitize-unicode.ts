/** Replaces unpaired UTF-16 surrogates while preserving every valid pair. */
export function sanitizeSurrogates(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text.charAt(index) + text.charAt(index + 1);
        index += 1;
      } else {
        output += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      output += "\ufffd";
    } else {
      output += text.charAt(index);
    }
  }
  return output;
}
