import { mergeTerminalOutput } from "../terminal-output.ts";
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
  return { ...next, ...mergeTerminalOutput(previous?.output ?? "", before, next.output, cursor) };
}
