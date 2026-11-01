export type AssistantResponseHeading = {
  kind: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: string;
};

/** Preserve Markdown heading depth without treating hashes in prose as headings. */
export function parseAssistantResponseHeading(
  line: string,
): AssistantResponseHeading | undefined {
  const match = line.trim().match(/^(#{1,6})[\t ]+(.+)$/);
  if (!match) return undefined;
  return {
    kind: "heading",
    level: match[1]!.length as AssistantResponseHeading["level"],
    // Closing ATX hashes need whitespace before them; retain names such as C#.
    content: match[2]!.replace(/[\t ]+#+[\t ]*$/, "").trim(),
  };
}
