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

/**
 * The assistant announcing its own next move ("Let me find where that's
 * controlled.", "I'll pull up the sidebar component."). Narration closes this
 * way and an answer does not, so it reads as a preamble however the block
 * opened — except for the sign-off "Let me know…", which invites a reply
 * rather than promising work.
 */
const OWN_NEXT_STEP = /^(?:I['’]ll|I will|I['’]m going to|I need to|Let me)\b/i;
const OWN_NEXT_STEP_EXCEPTION = /^Let me know\b/i;

const ONLINE_GREETING = /\bis online and working\b/i;

/** One-line readiness openers models restate every turn — drop entirely. */
const STATUS_GREETING =
  /\b(?:chat\s+mode\s+is\s+up|is\s+online\s+and\s+working|(?:is\s+)?(?:up|ready|online)\s+and\s+(?:ready|working)|ready\s+to\s+(?:help|work|assist))\b/i;

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

/**
 * True for short readiness lines that should not appear in the transcript at
 * all ("Gyro chat mode is up.", "…is online and working.").
 */
export function isTransientStatusGreeting(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 140) {
    return false;
  }
  // Single short sentence of pure status.
  const sentenceCount = (trimmed.match(/[.!?](?:\s|$)/g) ?? []).length;
  if (sentenceCount > 1) {
    return false;
  }
  return STATUS_GREETING.test(trimmed) || ONLINE_GREETING.test(trimmed);
}

/**
 * The block's closing sentence, used to ask what it leaves the reader with.
 */
function lastSentence(value: string): string | undefined {
  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.at(-1);
}

/**
 * True when a block signs off by promising the assistant's next step. This is
 * the one narration shape the opener test misses: an observation first, the
 * plan last ("Yes — I see it. … Let me find where that's controlled."), which
 * is long and multi-sentence and so fails every other preamble rule.
 */
function announcesOwnNextStep(value: string): boolean {
  if (value.length > 400) {
    return false;
  }
  const closing = lastSentence(value);
  return Boolean(
    closing &&
    OWN_NEXT_STEP.test(closing) &&
    !OWN_NEXT_STEP_EXCEPTION.test(closing),
  );
}

/**
 * The closing sentence commits to the assistant's own next move even though the
 * block does not open that way — "This is a sizable change, so let me map the
 * state model", "The strip is back. Now let me look at the recording."
 *
 * Both forms are checked against the closing sentence only, and both require a
 * first-person commitment, so an answer that merely opens a sentence with
 * "Now" ("Now you can run it.") is not swept up.
 */
const OWN_NEXT_STEP_SENTENCE =
  /^(?:(?:so|then|and|but|first|next|now|okay|ok)[,]?\s+)?(?:I['’]ll\b|I will\b|I['’]m going to\b|I need to\b|let me\b(?!\s+know)|looking\b|checking\b|searching\b|reading\b)/i;
const OWN_NEXT_STEP_CLAUSE =
  /\b(?:so|then|and|but|first|next|now)\s+(?:I['’]ll\b|I will\b|I['’]m going to\b|I need to\b|let me\b(?!\s+know))/i;

function closingSentenceIntroducesWork(value: string): boolean {
  const closing = lastSentence(value);
  if (!closing || OWN_NEXT_STEP_EXCEPTION.test(closing)) {
    return false;
  }
  return (
    OWN_NEXT_STEP_SENTENCE.test(closing) || OWN_NEXT_STEP_CLAUSE.test(closing)
  );
}

/** True when a short block reads as mid-run narration rather than the answer. */
export function isAssistantPreambleBlock(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (isOrphanAssistantFragment(trimmed)) {
    return true;
  }
  if (isTransientStatusGreeting(trimmed)) {
    return true;
  }
  // "Let me know…" hands the turn back; it closes an answer rather than
  // introducing work, so it outranks the "Let me" opener below.
  if (OWN_NEXT_STEP_EXCEPTION.test(trimmed)) {
    return false;
  }
  if (announcesOwnNextStep(trimmed)) {
    return true;
  }
  if (trimmed.length > 220) {
    return false;
  }
  // Multi-sentence blocks are usually the answer, even if they open with "I'll".
  if (
    (trimmed.match(/[.!?](?:\s|$)/g) ?? []).length >= 2 &&
    trimmed.length > 100
  ) {
    return false;
  }
  return PREAMBLE_BLOCK.test(trimmed) || closingSentenceIntroducesWork(trimmed);
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
      .filter(
        (block) =>
          block &&
          !isOrphanAssistantFragment(block) &&
          !isTransientStatusGreeting(block),
      )
  );
}

/**
 * When a multi-block message ends a turn that already did work, peel leading
 * plan/status lines so they stay on the run rail instead of the answer body.
 * Always keeps at least one block as the answer.
 *
 * Transient status greetings ("chat mode is up") are dropped entirely rather
 * than moved to the rail — they should not show each turn.
 */
export function peelAssistantPreambleBlocks(blocks: string[]): {
  preambles: string[];
  answer: string[];
} {
  const usable = blocks.filter(
    (block) => block && !isTransientStatusGreeting(block),
  );
  if (usable.length === 0) {
    return { preambles: [], answer: blocks.slice(-1) };
  }
  if (usable.length === 1) {
    return { preambles: [], answer: usable };
  }
  let peel = 0;
  while (
    peel < usable.length - 1 &&
    isAssistantPreambleBlock(usable[peel] ?? "")
  ) {
    peel += 1;
  }
  return {
    preambles: usable.slice(0, peel),
    answer: usable.slice(peel),
  };
}
