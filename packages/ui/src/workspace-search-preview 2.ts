type MatchRange = { startColumn: number; endColumn: number };

export function workspaceSearchPreview(
  line: string,
  query: string,
  ranges?: readonly MatchRange[],
) {
  const needle = query.trim();
  const matches = ranges
    ? ranges.map(({ startColumn, endColumn }) => ({
        start: startColumn - 1,
        end: endColumn - 1,
      }))
    : needle
      ? Array.from(
          line.matchAll(
            new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          ),
        ).map((match) => ({
          start: match.index!,
          end: match.index! + needle.length,
        }))
      : [];
  const valid = matches
    .filter(
      ({ start, end }) =>
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end >= start &&
        end <= line.length,
    )
    .sort((a, b) => a.start - b.start);
  const first = valid[0];
  // Keep match coordinates relative to the original line while hiding indentation.
  const indentation = line.length - line.trimStart().length;
  const start = first
    ? Math.max(0, Math.min(indentation, first.start), first.start - 40)
    : indentation;
  const end = Math.min(line.length, Math.max(start + 240, first?.end ?? 0));
  const parts: Array<{ text: string; matched: boolean }> = [];
  let cursor = start;
  for (const match of valid) {
    if (match.start >= end) break;
    const matchStart = Math.max(cursor, match.start);
    const matchEnd = Math.min(end, match.end);
    if (matchEnd <= matchStart) continue;
    if (matchStart > cursor)
      parts.push({ text: line.slice(cursor, matchStart), matched: false });
    parts.push({ text: line.slice(matchStart, matchEnd), matched: true });
    cursor = matchEnd;
  }
  if (cursor < end)
    parts.push({ text: line.slice(cursor, end), matched: false });
  return {
    parts,
    leadingEllipsis: start > indentation,
    trailingEllipsis: end < line.length,
  };
}
