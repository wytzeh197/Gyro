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
  /^(?:I['\u2019]ll|I will|I['\u2019]m going to|I need to|Let me|Looking|Checking|Searching|Reading|First[,]?|Next[,]?|Now[,]?|Got it|Sure|Okay|OK)\b/i;

/**
 * Narration that names the work as a gerund and hands off with a colon —
 * "Running the UI smoke checks:", "Updating the assertion to match the new
 * one:". The opener alone is not enough to tell these from an answer, because
 * a gerund also opens an ordinary noun phrase ("Running totals are stored in
 * the ledger…"); the colon is what makes the block an introduction to the work
 * that follows rather than a statement about it.
 */
const INTRODUCES_WORK_WITH_COLON =
  /^(?:Running|Rerunning|Re-running|Updating|Adding|Applying|Fixing|Rebuilding|Patching|Wiring|Verifying|Measuring|Inspecting|Tracing|Looking|Checking|Searching|Reading)\b[^\n]{0,120}:$/i;

/**
 * The assistant announcing its own next move ("Let me find where that's
 * controlled.", "I'll pull up the sidebar component."). Narration closes this
 * way and an answer does not, so it reads as a preamble however the block
 * opened — except for the sign-off "Let me know…", which invites a reply
 * rather than promising work.
 */
const OWN_NEXT_STEP = /^(?:I['’]ll|I will|I['’]m going to|I need to|Let me)\b/i;
const OWN_NEXT_STEP_EXCEPTION = /^Let me know\b/i;

/**
 * The assistant reporting work it is doing right now ("First I'm checking
 * whether the dev server is running…"). An answer reports what was found; a
 * closing sentence in the present progressive about its own checking is still
 * narration, however long the block.
 */
const OWN_PROGRESS_SENTENCE =
  /^(?:(?:so|then|and|but|first|next|now|meanwhile)[,]?\s+)?I['\u2019]m\s+(?:now\s+|first\s+|also\s+|still\s+)?(?:checking|looking|reading|searching|inspecting|verifying|running|testing|tracing|reviewing|pulling|gathering|confirming|investigating|finding|locating|opening|measuring|comparing|examining|mapping)\b/i;

const ONLINE_GREETING = /\bis online and working\b/i;

/** One-line readiness openers models restate every turn — drop entirely. */
const STATUS_GREETING =
  /\b(?:chat\s+mode\s+is\s+up|is\s+online\s+and\s+working|(?:is\s+)?(?:up|ready|online)\s+and\s+(?:ready|working)|ready\s+to\s+(?:help|work|assist))\b/i;

/** Code and link destinations must never be repaired as prose or split at blank lines. */
function opaqueMarkdownRanges(value: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { start: number; marker: string } | undefined;
  for (const match of value.matchAll(
    /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/gm,
  )) {
    const marker = match[1]!;
    if (!fence) fence = { start: match.index!, marker };
    else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      !match[2]!.trim()
    ) {
      ranges.push([fence.start, match.index! + match[0].length]);
      fence = undefined;
    }
  }
  if (fence) ranges.push([fence.start, value.length]);
  for (const match of value.matchAll(/(`+)([\s\S]*?)\1/g))
    ranges.push([match.index!, match.index! + match[0].length]);
  for (const match of value.matchAll(/\]\((?:<[^>]*>|[^)\n]+)\)/g))
    ranges.push([match.index!, match.index! + match[0].length]);
  // Merge once so long messages do not scan every code span for every boundary.
  const merged: Array<[number, number]> = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1])
      previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function textBlockStarts(value: string, paragraphs: boolean): number[] {
  if (!value) return [];
  const protectedRanges = opaqueMarkdownRanges(value);
  const isProtected = (offset: number) => {
    let low = 0;
    let high = protectedRanges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (protectedRanges[middle]![0] <= offset) low = middle + 1;
      else high = middle;
    }
    return low > 0 && offset < protectedRanges[low - 1]![1];
  };
  const starts = new Set<number>([0]);
  for (const match of value.matchAll(GLUED_BLOCK_BOUNDARY)) {
    const start = match.index! + match[1]!.length;
    if (!isProtected(match.index!)) starts.add(start);
  }
  if (paragraphs)
    for (const match of value.matchAll(/\n[ \t]*\n+/g)) {
      if (isProtected(match.index!)) continue;
      const start = match.index! + match[0].length;
      if (start < value.length) starts.add(start);
    }
  return starts.size > 1 ? [...starts].sort((a, b) => a - b) : [];
}

export function gluedAssistantBlockStarts(value: string): number[] {
  return textBlockStarts(value, false);
}

export function assistantMessageBlockStarts(value: string): number[] {
  return textBlockStarts(value, true);
}

/** Paragraphs retain all whitespace inside a Markdown code block. */
export function assistantTextBlocks(value: string): string[] {
  const starts = assistantMessageBlockStarts(value);
  if (!starts.length) return value.trim() ? [value.trim()] : [];
  return starts
    .map((start, index) => value.slice(start, starts[index + 1]).trim())
    .filter(Boolean);
}

/**
 * Gyro-only control markers (title, artifacts, plan, goal). They are
 * instructions to the app; the desktop strips them from the settled reply, but
 * live streamed text still carries them until the turn completes.
 */
const HIDDEN_CONTROL_MARKER =
  /^[ \t]*GYRO_(?:SESSION_TITLE|ARTIFACTS|PLAN_UPDATE|GOAL_UPDATE|AGENT_UPDATE|QUESTIONS|TASKS|MEMORY):[^\n]*/gm;

/** Remove control markers so they never draw as a narration row. */
export function stripHiddenControlMarkers(value: string): string {
  if (!value.includes("GYRO_")) {
    return value;
  }
  return value.replace(HIDDEN_CONTROL_MARKER, "").replace(/\n{3,}/g, "\n\n");
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
    (OWN_NEXT_STEP.test(closing) || OWN_PROGRESS_SENTENCE.test(closing)) &&
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
  /^(?:(?:so|then|and|but|first|next|now|okay|ok)[,]?\s+)?(?:I['\u2019]ll\b|I will\b|I['\u2019]m going to\b|I need to\b|let me\b(?!\s+know)|looking\b|checking\b|searching\b|reading\b)/i;
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
  // The closing sentence can commit to more work after an observation
  // ("The prefix split is in place. Next I'll …"). That check has to run
  // before the multi-sentence bail, which would otherwise treat the block as
  // the answer, paint the live run as finalizing, and draw the line under the
  // working process. The 400-character ceiling matches announcesOwnNextStep
  // so a long answer is not pulled onto the rail.
  if (
    announcesOwnNextStep(trimmed) ||
    (trimmed.length <= 400 && closingSentenceIntroducesWork(trimmed))
  ) {
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
  return (
    PREAMBLE_BLOCK.test(trimmed) || INTRODUCES_WORK_WITH_COLON.test(trimmed)
  );
}

export function structuredCommentaryBlocks(value: string) {
  return assistantTextBlocks(value).filter(
    (block) =>
      !isOrphanAssistantFragment(block) && !isTransientStatusGreeting(block),
  );
}

/** Final answers are content, including single-character and symbol paragraphs. */
export function finalAssistantResponseText(value: string): string {
  return assistantTextBlocks(value).join("\n\n");
}

/**
 * When a multi-block message ends a turn that already did work, peel leading
 * plan/status lines so they stay on the run rail instead of the answer body.
 * Always keeps at least one block as the answer.
 *
 * Transient status greetings ("chat mode is up") are dropped entirely rather
 * than moved to the rail — they should not show each turn.
 */
export function peelAssistantPreambleBlocks(
  blocks: string[],
  preserveContent = false,
): {
  preambles: string[];
  answer: string[];
} {
  const usable = blocks.filter(
    (block) => block && (preserveContent || !isTransientStatusGreeting(block)),
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
    !(
      preserveContent &&
      (isOrphanAssistantFragment(usable[peel] ?? "") ||
        isTransientStatusGreeting(usable[peel] ?? ""))
    ) &&
    isAssistantPreambleBlock(usable[peel] ?? "")
  ) {
    peel += 1;
  }
  return {
    preambles: usable.slice(0, peel),
    answer: usable.slice(peel),
  };
}
