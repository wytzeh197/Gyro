import type { TerminalSnapshot } from "./types";
/** Undefined means a cursor gap: fetch an authoritative snapshot, never guess. */
export function mergeTerminalUpdate(previous: TerminalSnapshot | undefined, next: TerminalSnapshot): TerminalSnapshot | undefined {
  const cursor = next.outputCursor;
  if (!cursor) return undefined;
  if (next.output == null) {
    if (!previous || previous.outputCursor?.generation !== cursor.generation || previous.outputCursor.end !== cursor.end) return undefined;
    return { ...previous, ...next, output: previous.output };
  }
  const before = previous?.outputCursor;
  if (!before || before.generation !== cursor.generation) return { ...next };
  if (cursor.end < before.end) return previous;
  if (cursor.start <= before.start) return { ...next };
  if (cursor.start !== before.end) return cursor.end === before.end ? previous : undefined;
  let output = (previous?.output ?? "") + next.output;
  let start = before.start;
  if (new TextEncoder().encode(output).length > 512 * 1024) {
    const bytes = new TextEncoder().encode(output);
    let cut = bytes.length - 512 * 1024;
    while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
    output = new TextDecoder().decode(bytes.subarray(cut)); start += cut;
  }
  return { ...next, output, outputCursor: { ...cursor, start } };
}
