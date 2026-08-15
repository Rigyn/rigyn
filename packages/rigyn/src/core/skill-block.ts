export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

function attribute(
  line: string,
  offset: number,
  name: "name" | "location",
): { value: string; next: number } | null {
  const opening = `${name}="`;
  if (!line.startsWith(opening, offset)) return null;
  const valueStart = offset + opening.length;
  const valueEnd = line.indexOf("\"", valueStart);
  if (valueEnd <= valueStart) return null;
  return { value: line.slice(valueStart, valueEnd), next: valueEnd + 1 };
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const prefix = "<skill ";
  if (!text.startsWith(prefix)) return null;
  const headerEnd = text.indexOf("\n");
  if (headerEnd < 0) return null;
  const header = text.slice(0, headerEnd);

  const name = attribute(header, prefix.length, "name");
  if (name === null || header[name.next] !== " ") return null;
  const location = attribute(header, name.next + 1, "location");
  if (location === null || location.next !== header.length - 1 || header[location.next] !== ">") return null;

  const closeTag = "\n</skill>";
  const bodyStart = headerEnd + 1;
  let closeStart = text.indexOf(closeTag, bodyStart);
  while (closeStart >= 0) {
    const afterTag = closeStart + closeTag.length;
    const validEnd = afterTag === text.length;
    const validMessage = text.startsWith("\n\n", afterTag) && afterTag + 2 < text.length;
    if (validEnd || validMessage) break;
    closeStart = text.indexOf(closeTag, afterTag);
  }
  if (closeStart < 0) return null;

  const trailingStart = closeStart + closeTag.length;
  let userMessage: string | undefined;
  if (trailingStart < text.length) {
    if (!text.startsWith("\n\n", trailingStart)) return null;
    const trailing = text.slice(trailingStart + 2);
    if (trailing === "") return null;
    userMessage = trailing.trim() || undefined;
  }

  return {
    name: name.value,
    location: location.value,
    content: text.slice(bodyStart, closeStart),
    userMessage,
  };
}
