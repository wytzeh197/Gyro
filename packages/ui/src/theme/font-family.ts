const genericFamilies = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "rounded",
  "cursive",
  "fantasy",
]);
const fallbacks = {
  ui: 'Geist, -apple-system, "Helvetica Neue", sans-serif',
  code: '"Geist Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace',
};

export function fontFamilies(value: string): string[] | undefined {
  if (value.length > 180) return undefined;
  if (!value.trim()) return [];
  const familyPattern =
    /\s*(?:"([\p{L}\p{N} .,\u0027_-]+)"|'([\p{L}\p{N} .,"_-]+)'|([\p{L}\p{N} ._-]+))\s*(,|$)/guy;
  const families: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    familyPattern.lastIndex = offset;
    const match = familyPattern.exec(value);
    if (!match) return undefined;
    const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!name || (match[4] && !value.slice(familyPattern.lastIndex).trim()))
      return undefined;
    const generic = name.toLowerCase();
    families.push(
      match[3] && genericFamilies.has(generic)
        ? generic
        : `"${name.replaceAll('"', '\\"')}"`,
    );
    offset = familyPattern.lastIndex;
  }
  return families;
}

export function fontStack(value: string | undefined, kind: "ui" | "code") {
  const custom = fontFamilies(value ?? "") ?? [];
  return [...custom, fallbacks[kind]].join(", ");
}
