export type GlobalSearchRange = { start: number; end: number };

export type GlobalSearchField = {
  text: string;
  folded: string;
  boundaries: Uint8Array;
};

export type GlobalSearchTarget = {
  label: GlobalSearchField;
  detail: GlobalSearchField;
  keywords: GlobalSearchField;
};

export type GlobalSearchMatch = {
  score: number;
  labelRanges: GlobalSearchRange[];
  detailRanges: GlobalSearchRange[];
};

export type GlobalSearchRankable = {
  label: string;
  priority: number;
  target: GlobalSearchTarget;
};

export type GlobalSearchResult<T extends GlobalSearchRankable> = {
  item: T;
  match: GlobalSearchMatch;
};

const NO_MATCH = Number.POSITIVE_INFINITY;
const DETAIL_PENALTY = 22;
const KEYWORD_PENALTY = 34;
const MAX_OCCURRENCE_PROBES = 8;
const BOUNDARY_LOOKAHEAD = 24;
const MAX_NARROWING_FRAMES = 24;

const foldedCharCache = new Map<string, string>();
const asciiOnly = /^[ -~]*$/;

/**
 * Folds one character while keeping the UTF-16 length stable so match ranges
 * stay aligned with the text the user actually sees.
 */
function foldChar(char: string) {
  const cached = foldedCharCache.get(char);
  if (cached !== undefined) return cached;
  const lowered = char.toLowerCase();
  const stripped = lowered.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const folded = stripped.length === lowered.length ? stripped : lowered;
  foldedCharCache.set(char, folded);
  return folded;
}

export function foldGlobalSearchText(value: string) {
  if (asciiOnly.test(value)) return value.toLowerCase();
  let folded = "";
  for (let index = 0; index < value.length; index += 1) {
    folded += foldChar(value[index]!);
  }
  return folded;
}

export function normalizedGlobalSearchText(value: string) {
  return foldGlobalSearchText(value).trim();
}

function isAlphanumeric(code: number) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    code > 127
  );
}

function isUpper(code: number) {
  return code >= 65 && code <= 90;
}

/**
 * Marks word starts — separators, camel humps, and digit runs — so matches on
 * "gs" rank `global-search.ts` above a stray pair of letters mid-word.
 */
function wordBoundaries(text: string) {
  const boundaries = new Uint8Array(text.length);
  let previous = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const boundary =
      index === 0 ||
      !isAlphanumeric(previous) ||
      (isUpper(code) && !isUpper(previous)) ||
      (code >= 48 && code <= 57 && !(previous >= 48 && previous <= 57));
    boundaries[index] = boundary && isAlphanumeric(code) ? 1 : 0;
    previous = code;
  }
  return boundaries;
}

function searchField(text: string): GlobalSearchField {
  return {
    text,
    folded: foldGlobalSearchText(text),
    boundaries: wordBoundaries(text),
  };
}

const emptyField = searchField("");

export function createGlobalSearchTarget(
  label: string,
  detail = "",
  keywords = "",
): GlobalSearchTarget {
  return {
    label: searchField(label),
    detail: detail ? searchField(detail) : emptyField,
    keywords: keywords ? searchField(keywords) : emptyField,
  };
}

export function tokenizeGlobalSearchQuery(query: string) {
  return normalizedGlobalSearchText(query).split(/\s+/).filter(Boolean);
}

function pushRange(ranges: GlobalSearchRange[], position: number) {
  const last = ranges.at(-1);
  if (last && last.end === position) {
    last.end = position + 1;
    return;
  }
  ranges.push({ start: position, end: position + 1 });
}

type TokenMatch = {
  score: number;
  ranges: GlobalSearchRange[];
  contiguous: boolean;
};

const noTokenMatch: TokenMatch = {
  score: NO_MATCH,
  ranges: [],
  contiguous: false,
};

/**
 * Scores one token against one field. Lower is better; Infinity means the token
 * is not even a subsequence of the field.
 */
function matchToken(
  token: string,
  field: GlobalSearchField,
  fuzzy: boolean,
): TokenMatch {
  const { folded, boundaries } = field;
  if (!folded || token.length > folded.length) return noTokenMatch;

  let bestContiguous = NO_MATCH;
  let bestStart = -1;
  let probes = 0;
  let offset = folded.indexOf(token);
  while (offset >= 0 && probes < MAX_OCCURRENCE_PROBES) {
    const exact = offset === 0 && token.length === folded.length;
    const base = exact ? 0 : offset === 0 ? 6 : boundaries[offset] ? 14 : 26;
    const score = base + Math.min(offset, 60) * 0.25;
    if (score < bestContiguous) {
      bestContiguous = score;
      bestStart = offset;
    }
    if (exact) break;
    probes += 1;
    offset = folded.indexOf(token, offset + 1);
  }
  if (bestStart >= 0) {
    return {
      score: bestContiguous,
      ranges: [{ start: bestStart, end: bestStart + token.length }],
      contiguous: true,
    };
  }

  if (!fuzzy) return noTokenMatch;
  // Fall back to a subsequence walk. The boundary-seeking pass reads better
  // ("gs" lighting up `global-search`), but it can skip past the only viable
  // run, so a plain greedy walk decides whether the token matches at all.
  return (
    walkSubsequence(token, field, true) ??
    walkSubsequence(token, field, false) ??
    noTokenMatch
  );
}

function walkSubsequence(
  token: string,
  field: GlobalSearchField,
  preferBoundaries: boolean,
): TokenMatch | undefined {
  const { folded, boundaries } = field;
  const ranges: GlobalSearchRange[] = [];
  let cursor = 0;
  let gaps = 0;
  let boundaryHits = 0;
  let firstHit = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index]!;
    let position = folded.indexOf(char, cursor);
    if (position < 0) return undefined;
    if (preferBoundaries && !boundaries[position]) {
      const limit = Math.min(folded.length, position + BOUNDARY_LOOKAHEAD);
      for (let probe = position + 1; probe < limit; probe += 1) {
        if (folded[probe] === char && boundaries[probe]) {
          position = probe;
          break;
        }
      }
    }
    if (firstHit < 0) firstHit = position;
    if (position > cursor) gaps += 1;
    if (boundaries[position]) boundaryHits += 1;
    pushRange(ranges, position);
    cursor = position + 1;
  }
  const score =
    54 +
    gaps * 1.4 -
    boundaryHits * 1.5 +
    Math.min(firstHit, 60) * 0.2 +
    (cursor - firstHit - token.length) * 0.5;
  return { score, ranges, contiguous: false };
}

export function globalSearchMatch(
  query: string,
  target: GlobalSearchTarget,
): GlobalSearchMatch {
  const tokens = tokenizeGlobalSearchQuery(query);
  if (tokens.length === 0) {
    return { score: 0, labelRanges: [], detailRanges: [] };
  }
  let total = 0;
  const labelRanges: GlobalSearchRange[] = [];
  const detailRanges: GlobalSearchRange[] = [];
  for (const token of tokens) {
    // Loose subsequences only count against the visible label. Letting them
    // count against descriptions and paths turned every short query into a
    // wall of near-misses, and skipping the walk keeps long paths cheap.
    const label = matchToken(token, target.label, true);
    const detail = matchToken(token, target.detail, false);
    const keywords = matchToken(token, target.keywords, false);
    const detailScore = detail.score + DETAIL_PENALTY;
    const keywordScore = keywords.score + KEYWORD_PENALTY;
    const best = Math.min(label.score, detailScore, keywordScore);
    if (!Number.isFinite(best))
      return { score: NO_MATCH, labelRanges: [], detailRanges: [] };
    total += best;
    if (label.score <= detailScore) {
      labelRanges.push(...label.ranges);
    } else if (detailScore <= keywordScore) {
      detailRanges.push(...detail.ranges);
    }
  }
  const score =
    total / tokens.length + Math.min(target.label.text.length, 80) * 0.01;
  return {
    score,
    labelRanges: mergeRanges(labelRanges),
    detailRanges: mergeRanges(detailRanges),
  };
}

function mergeRanges(ranges: GlobalSearchRange[]) {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort(
    (first, second) => first.start - second.start,
  );
  const merged: GlobalSearchRange[] = [sorted[0]!];
  for (const range of sorted.slice(1)) {
    const last = merged.at(-1)!;
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** Kept for callers that only need a score for a plain label/haystack pair. */
export function globalSearchMatchScore(
  query: string,
  label: string,
  searchText: string,
) {
  if (!normalizedGlobalSearchText(query)) return 0;
  return globalSearchMatch(query, createGlobalSearchTarget(label, searchText))
    .score;
}

function compareResults<T extends GlobalSearchRankable>(
  first: GlobalSearchResult<T>,
  second: GlobalSearchResult<T>,
) {
  return (
    first.match.score - second.match.score ||
    first.item.priority - second.item.priority ||
    first.item.label.localeCompare(second.item.label)
  );
}

/**
 * Keeps the best `limit` results without sorting the whole survivor list, which
 * matters when a one-character query still matches thousands of files.
 */
function pickTop<T extends GlobalSearchRankable>(
  results: GlobalSearchResult<T>[],
  limit: number,
) {
  if (results.length <= limit) return results.sort(compareResults);
  if (results.length < limit * 6)
    return results.sort(compareResults).slice(0, limit);
  const top: GlobalSearchResult<T>[] = [];
  for (const result of results) {
    if (top.length === limit && compareResults(result, top[limit - 1]!) >= 0) {
      continue;
    }
    let index = top.length < limit ? top.length : limit - 1;
    while (index > 0 && compareResults(result, top[index - 1]!) < 0) {
      top[index] = top[index - 1]!;
      index -= 1;
    }
    top[index] = result;
    if (top.length > limit) top.length = limit;
  }
  return top;
}

type NarrowingFrame<T extends GlobalSearchRankable> = {
  query: string;
  survivors: T[];
};

/**
 * Ranks a candidate set against a live query. Because every token has to be a
 * subsequence of the target, extending a query can only shrink the survivor
 * set — so each keystroke re-scores the previous survivors instead of the whole
 * corpus.
 */
export class GlobalSearchRanker<T extends GlobalSearchRankable> {
  #candidates: T[] = [];
  #frames: NarrowingFrame<T>[] = [];

  setCandidates(candidates: T[]) {
    if (this.#candidates === candidates) return;
    this.#candidates = candidates;
    this.#frames = [];
  }

  rank(query: string, limit: number): GlobalSearchResult<T>[] {
    const normalized = normalizedGlobalSearchText(query);
    if (!normalized) {
      this.#frames = [];
      return this.#candidates.slice(0, limit).map((item) => ({
        item,
        match: { score: 0, labelRanges: [], detailRanges: [] },
      }));
    }
    while (this.#frames.length > 0) {
      const frame = this.#frames.at(-1)!;
      if (frame.query === normalized) {
        return pickTop(
          frame.survivors.map((item) => ({
            item,
            match: globalSearchMatch(normalized, item.target),
          })),
          limit,
        );
      }
      if (normalized.startsWith(frame.query)) break;
      this.#frames.pop();
    }
    const base = this.#frames.at(-1)?.survivors ?? this.#candidates;
    const results: GlobalSearchResult<T>[] = [];
    const survivors: T[] = [];
    for (const item of base) {
      const match = globalSearchMatch(normalized, item.target);
      if (!Number.isFinite(match.score)) continue;
      survivors.push(item);
      results.push({ item, match });
    }
    this.#frames.push({ query: normalized, survivors });
    if (this.#frames.length > MAX_NARROWING_FRAMES) this.#frames.shift();
    return pickTop(results, limit);
  }
}
