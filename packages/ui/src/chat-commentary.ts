/**
 * Sentence-end hard against a new sentence/title case — the unmistakable
 * glued-stream boundary (`finished.I'll continue`, `is.Gyro is…`).
 *
 * Optional markdown emphasis between the punctuation and the capital covers
 * providers that bold the next block (`is.**Gyro is…**`) so the boundary is
 * not missed.
 */
const GLUED_BLOCK_BOUNDARY =
  /([.!?])(?=(?:\*{1,2}|_{1,2})?(?:[A-Z][a-z]|I['’]))/g;

/**
 * Offsets where successive streamed blocks were concatenated without a break.
 * Always includes 0 when any later boundary exists so callers can slice the
 * message into one segment per block.
 */
export function gluedAssistantBlockStarts(value: string): number[] {
  if (!value) {
    return [];
  }
  const starts = [0];
  for (const match of value.matchAll(GLUED_BLOCK_BOUNDARY)) {
    const nextStart = match.index + match[1]!.length;
    if (nextStart > starts[starts.length - 1]! && nextStart < value.length) {
      starts.push(nextStart);
    }
  }
  return starts.length > 1 ? starts : [];
}

export function structuredCommentaryBlocks(value: string) {
  return (
    value
      // Some providers send cumulative commentary updates without preserving the
      // separator between updates (for example, `finished.I’ll continue`). Repair
      // only that unmistakable boundary so ordinary prose, versions, and paths
      // remain untouched.
      .replace(GLUED_BLOCK_BOUNDARY, "$1\n\n")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean)
  );
}
