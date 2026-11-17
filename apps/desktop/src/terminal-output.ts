import type { TerminalOutputCursor } from "@gyro-dev/ui";

/** Find only the new PTY text, including when the bounded history rolls over. */
export function terminalOutputUpdate(
  previous: string,
  next: string,
  previousCursor?: TerminalOutputCursor,
  nextCursor?: TerminalOutputCursor,
) {
  if (nextCursor) {
    if (
      !previousCursor ||
      previousCursor.generation !== nextCursor.generation ||
      previousCursor.end < nextCursor.start ||
      previousCursor.end > nextCursor.end
    ) {
      return { reset: true, data: next };
    }
    // Offsets count normalized UTF-8 bytes, not JS UTF-16 code units. Repeated
    // windows still deliver new bytes; emoji cannot split at a surrogate pair.
    const bytes = new TextEncoder().encode(next);
    return {
      reset: false,
      data: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        bytes.subarray(previousCursor.end - nextCursor.start),
      ),
    };
  }
  if (next.startsWith(previous)) {
    return { reset: false, data: next.slice(previous.length) };
  }
  if (!next) return { reset: true, data: "" };

  // KMP finds the longest suffix of the old buffer matching the new prefix.
  // Never normalize control sequences: CR and LF are separate terminal actions.
  const prefix = new Uint32Array(next.length);
  for (let i = 1, matched = 0; i < next.length; i++) {
    while (matched && next[i] !== next[matched])
      matched = prefix[matched - 1] ?? 0;
    if (next[i] === next[matched]) matched++;
    prefix[i] = matched;
  }
  let matched = 0;
  for (let i = 0; i < previous.length; i++) {
    const char = previous[i];
    while (matched && (matched === next.length || char !== next[matched])) {
      matched = prefix[matched - 1] ?? 0;
    }
    if (char === next[matched]) matched++;
  }
  // A tiny coincidental match is insufficient evidence of a rolling buffer.
  if (matched >= 64) return { reset: false, data: next.slice(matched) };
  return { reset: true, data: next };
}

/** Reconstitute a bounded UI snapshot from a delta without guessing overlap. */
export function mergeTerminalOutput(
  previous: string,
  previousCursor: TerminalOutputCursor | undefined,
  next: string | null | undefined,
  nextCursor: TerminalOutputCursor | undefined,
) {
  if (next == null) return { output: previous, outputCursor: previousCursor };
  if (
    !previousCursor ||
    !nextCursor ||
    previousCursor.generation !== nextCursor.generation ||
    nextCursor.start !== previousCursor.end
  ) {
    return { output: next, outputCursor: nextCursor };
  }
  const bytes = new TextEncoder().encode(previous + next);
  let start = Math.max(0, bytes.length - 512 * 1024);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return {
    output: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start)),
    outputCursor: {
      ...nextCursor,
      start: nextCursor.end - (bytes.length - start),
    },
  };
}
