import type { TerminalOutputCursor } from "@gyro-dev/ui";

const scrollbackByteLimit = 512 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Native cursors describe normalized UTF-8. Keep the byte path for invalid ranges. */
function outputByteLength(
  text: string,
  cursor: TerminalOutputCursor,
): number | undefined {
  const bytes = cursor.end - cursor.start;
  if (
    Number.isSafeInteger(cursor.start) &&
    Number.isSafeInteger(cursor.end) &&
    cursor.start >= 0 &&
    bytes >= text.length &&
    bytes <= text.length * 3
  ) {
    return bytes;
  }
  return undefined;
}

function nextCharacterBoundary(bytes: Uint8Array, start: number) {
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return start;
}

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
    const offset = previousCursor.end - nextCursor.start;
    const byteLength = outputByteLength(next, nextCursor);
    if (byteLength !== undefined && Number.isSafeInteger(offset)) {
      if (byteLength === next.length) {
        return { reset: false, data: next.slice(offset) };
      }
      const added = byteLength - offset;
      if (added === 0) return { reset: false, data: "" };
      // Each UTF-16 code unit takes at least one UTF-8 byte. Encode only a
      // suffix large enough to contain the new bytes, keeping pairs intact.
      let start = Math.max(0, next.length - added);
      const unit = next.charCodeAt(start);
      if (start > 0 && unit >= 0xdc00 && unit <= 0xdfff) start--;
      const suffix = encoder.encode(next.slice(start));
      if (suffix.length >= added) {
        return {
          reset: false,
          data: decoder.decode(suffix.subarray(suffix.length - added)),
        };
      }
    }
    const bytes = encoder.encode(next);
    return {
      reset: false,
      data: decoder.decode(bytes.subarray(offset)),
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
  const previousLength = outputByteLength(previous, previousCursor);
  const nextLength = outputByteLength(next, nextCursor);
  if (previousLength !== undefined && nextLength !== undefined) {
    const overflow = previousLength + nextLength - scrollbackByteLimit;
    if (overflow <= 0) {
      return {
        output: previous + next,
        outputCursor: { ...nextCursor, start: previousCursor.start },
      };
    }
    if (overflow <= previousLength) {
      let removedBytes = overflow;
      let removedUnits = overflow;
      if (previousLength !== previous.length) {
        // Inspect only the evicted prefix and the next character boundary.
        const prefix = encoder.encode(previous.slice(0, overflow + 2));
        removedBytes = nextCharacterBoundary(prefix, overflow);
        removedUnits = decoder.decode(prefix.subarray(0, removedBytes)).length;
      }
      return {
        output: previous.slice(removedUnits) + next,
        outputCursor: { ...nextCursor, start: previousCursor.start + removedBytes },
      };
    }
  }
  const bytes = encoder.encode(previous + next);
  const start = nextCharacterBoundary(
    bytes,
    Math.max(0, bytes.length - scrollbackByteLimit),
  );
  return {
    output: decoder.decode(bytes.subarray(start)),
    outputCursor: {
      ...nextCursor,
      start: nextCursor.end - (bytes.length - start),
    },
  };
}
