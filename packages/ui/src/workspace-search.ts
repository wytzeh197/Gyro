import type { WorkspaceSearchQuery } from "./types";

function splitWorkspaceGlobText(value: string) {
  const patterns: string[] = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;

  const commit = () => {
    const pattern = current.trim();
    if (pattern) patterns.push(pattern);
    current = "";
  };

  for (const character of value) {
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (
      (character === "," || character === "\n") &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      commit();
      continue;
    }
    current += character;
  }
  commit();
  return patterns;
}

export function workspaceSearchGlobs(includeText: string, excludeText: string) {
  const include = splitWorkspaceGlobText(includeText);
  const exclude = splitWorkspaceGlobText(excludeText).map(
    (pattern) => `!${pattern.replace(/^!+/, "")}`,
  );
  return [...new Set([...include, ...exclude])];
}

export function workspaceSearchGlobText(
  globs: readonly string[] | undefined,
  kind: "include" | "exclude",
) {
  return (globs ?? [])
    .filter((glob) =>
      kind === "exclude" ? glob.startsWith("!") : !glob.startsWith("!"),
    )
    .map((glob) => (kind === "exclude" ? glob.replace(/^!+/, "") : glob))
    .join(", ");
}

/** Match flags carried by a Search view query. */
export type WorkspaceSearchFlags = Pick<
  WorkspaceSearchQuery,
  "matchCase" | "wholeWord" | "useRegex"
>;

export function workspaceSearchFlags(
  query: WorkspaceSearchFlags | undefined,
): Required<WorkspaceSearchFlags> {
  return {
    matchCase: query?.matchCase === true,
    wholeWord: query?.wholeWord === true,
    useRegex: query?.useRegex === true,
  };
}

/**
 * The fields `search_workspace` reads for the Search view toggles. Match Case
 * is off by default, as in VS Code, so the view sends `caseSensitive: false`.
 */
export function workspaceSearchRequestFlags(query: WorkspaceSearchFlags) {
  const flags = workspaceSearchFlags(query);
  return {
    caseSensitive: flags.matchCase,
    wholeWord: flags.wholeWord,
    regex: flags.useRegex,
  };
}

const WORD_CHARACTER = "[\\p{L}\\p{N}_]";

/**
 * A global RegExp with the same matching rules the backend search used, so
 * Replace changes exactly what the results showed. Returns undefined for an
 * empty query or a regex the browser cannot compile.
 */
export function workspaceSearchMatcher(
  query: WorkspaceSearchQuery,
): RegExp | undefined {
  if (!query.query) return undefined;
  const flags = workspaceSearchFlags(query);
  const body = flags.useRegex
    ? query.query
    : query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = flags.wholeWord
    ? `(?<!${WORD_CHARACTER})(?:${body})(?!${WORD_CHARACTER})`
    : body;
  try {
    return new RegExp(source, flags.matchCase ? "gu" : "giu");
  } catch {
    return undefined;
  }
}

/**
 * Replace every match in `content`. Literal searches insert `replacement` as
 * typed; regex searches expand `$1` and `$&` like VS Code.
 */
export function replaceWorkspaceSearchMatches(
  content: string,
  query: WorkspaceSearchQuery,
  replacement: string,
): { content: string; occurrences: number } | undefined {
  const matcher = workspaceSearchMatcher(query);
  if (!matcher) return undefined;
  const occurrences = [...content.matchAll(matcher)].length;
  if (occurrences === 0) return { content, occurrences };
  const next = workspaceSearchFlags(query).useRegex
    ? content.replace(matcher, replacement)
    : content.replace(matcher, () => replacement);
  return { content: next, occurrences };
}
