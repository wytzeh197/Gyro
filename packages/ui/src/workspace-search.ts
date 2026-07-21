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
