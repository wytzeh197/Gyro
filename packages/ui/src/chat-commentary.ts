export function structuredCommentaryBlocks(value: string) {
  return (
    value
      // Some providers send cumulative commentary updates without preserving the
      // separator between updates (for example, `finished.I’ll continue`). Repair
      // only that unmistakable boundary so ordinary prose, versions, and paths
      // remain untouched.
      .replace(/([.!?])(?=(?:[A-Z][a-z]|I['’]))/g, "$1\n\n")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean)
  );
}
