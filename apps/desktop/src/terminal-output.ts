/** Find only the new PTY text, including when the bounded history rolls over. */
export function terminalOutputUpdate(previous: string, next: string) {
  if (next.startsWith(previous)) {
    return { reset: false, data: next.slice(previous.length) };
  }
  if (!next) return { reset: true, data: "" };

  // KMP finds the longest suffix of the old buffer matching the new prefix.
  // Never normalize control sequences: CR and LF are separate terminal actions.
  const prefix = new Uint32Array(next.length);
  for (let i = 1, matched = 0; i < next.length; i++) {
    while (matched && next[i] !== next[matched]) matched = (prefix[matched - 1] ?? 0);
    if (next[i] === next[matched]) matched++;
    prefix[i] = matched;
  }
  let matched = 0;
  for (let i = 0; i < previous.length; i++) {
    const char = previous[i];
    while (matched && (matched === next.length || char !== next[matched])) {
      matched = (prefix[matched - 1] ?? 0);
    }
    if (char === next[matched]) matched++;
  }
  // A tiny coincidental match is insufficient evidence of a rolling buffer.
  if (matched >= 64) return { reset: false, data: next.slice(matched) };
  return { reset: true, data: next };
}
