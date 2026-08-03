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
 * Planning / status lines that often land in the same stream as the answer.
 * When a turn had real work, leading blocks that match stay on the rail and
 * out of the final response body.
 */
const PREAMBLE_BLOCK =
  /^(?:I['’]ll|I will|I['’]m going to|I need to|Let me|Looking|Checking|Searching|Reading|First[,]?|Next[,]?|Now[,]?|Got it|Sure|Okay|OK)\b/i;

const ONLINE_GREETING = /\bis online and working\b/i;

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

/**
 * Block starts from glued stream joins *and* blank-line paragraphs.
 * Providers often emit plan lines and the answer as separate paragraphs in one
 * durable message; without paragraph splits the whole blob becomes the final
 * answer (plan text mixed into the response body).
 */
export function assistantMessageBlockStarts(value: string): number[] {
  if (!value) {
    return [];
  }
  const starts = new Set<number>([0]);
  for (const match of value.matchAll(GLUED_BLOCK_BOUNDARY)) {
    const nextStart = match.index + match[1]!.length;
    if (nextStart > 0 && nextStart < value.length) {
      starts.add(nextStart);
    }
  }
  for (const match of value.matchAll(/\n[ \t]*\n+/g)) {
    let nextStart = match.index + match[0].length;
    while (nextStart < value.length && /[ \t\r]/.test(value[nextStart]!)) {
      nextStart += 1;
    }
    if (nextStart > 0 && nextStart < value.length) {
      starts.add(nextStart);
    }
  }
  const sorted = [...starts].sort((a, b) => a - b);
  return sorted.length > 1 ? sorted : [];
}

/**
 * Stream/segment garbage: a lone letter, "e.", or pure punctuation that
 * sometimes appears as its own paragraph while the real answer settles.
 */
export function isOrphanAssistantFragment(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (/^[^\p{L}\p{N}]+$/u.test(trimmed)) {
    return true;
  }
  const lettersAndDigits = [...trimmed].filter((ch) =>
    /[\p{L}\p{N}]/u.test(ch),
  );
  // One alphanumeric (optionally wrapped in punctuation): "e", "e.", "**e.**"
  return lettersAndDigits.length <= 1 && trimmed.length <= 6;
}

/** True when a short block reads as mid-run narration rather than the answer. */
export function isAssistantPreambleBlock(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 220) {
    return false;
  }
  if (isOrphanAssistantFragment(trimmed)) {
    return true;
  }
  if (ONLINE_GREETING.test(trimmed)) {
    return true;
  }
  // Multi-sentence blocks are usually the answer, even if they open with "I'll".
  if ((trimmed.match(/[.!?](?:\s|$)/g) ?? []).length >= 2 && trimmed.length > 100) {
    return false;
  }
  return PREAMBLE_BLOCK.test(trimmed);
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
      .filter((block) => block && !isOrphanAssistantFragment(block))
  );
}

/**
 * When a multi-block message ends a turn that already did work, peel leading
 * plan/status lines so they stay on the run rail instead of the answer body.
 * Always keeps at least one block as the answer.
 */
export function peelAssistantPreambleBlocks(blocks: string[]): {
  preambles: string[];
  answer: string[];
} {
  if (blocks.length <= 1) {
    return { preambles: [], answer: blocks };
  }
  let peel = 0;
  while (
    peel < blocks.length - 1 &&
    isAssistantPreambleBlock(blocks[peel] ?? "")
  ) {
    peel += 1;
  }
  return {
    preambles: blocks.slice(0, peel),
    answer: blocks.slice(peel),
  };
}
