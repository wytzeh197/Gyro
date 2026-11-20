const UPPERCASE_WORDS = new Set(["gpt", "oss", "vl", "xl"]);
const EFFORT_SUFFIXES: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Splits a trailing reasoning-effort part off an id: "gemini-4-neon-xhigh". */
export function modelEffortSuffix(id: string): { base: string; effort?: string } {
  const match = /^(.+)-(minimal|low|medium|high|xhigh|max)$/.exec(id);
  return match ? { base: match[1]!, effort: EFFORT_SUFFIXES[match[2]!] } : { base: id };
}

/**
 * A readable name for a model id the catalog has no display name for:
 * "claude-opus-5-5" → "Claude Opus 5.5", "gpt-6-mini" → "GPT-6 Mini",
 * "claude-opus-5-5-1m" → "Claude Opus 5.5 (1M)",
 * "gemini-4-neon-xhigh" → "Gemini 4 Neon (Extra High)". Ids that already look like
 * names (spaces or capitals) are returned as they are.
 */
export function humanModelName(id: string): string;
export function humanModelName(id: string | undefined): string | undefined;
export function humanModelName(id: string | undefined): string | undefined {
  const raw = id?.trim();
  if (!raw || /[A-Z\s]/.test(raw)) return raw;
  const { base: name, effort } = modelEffortSuffix(raw.slice(raw.lastIndexOf("/") + 1));
  const words: string[] = [];
  let suffix = "";
  const notes: string[] = [];
  let previousWasVersion = false;
  for (const part of name.split(/[-_:]/)) {
    if (!part || part === "latest" || /^\d{8}$/.test(part)) continue;
    if (/^\d+[km]$/.test(part)) {
      suffix = ` (${part.toUpperCase()})`;
      continue;
    }
    if (part === "preview") {
      notes.push("Preview");
      continue;
    }
    if (/^\d+(\.\d+)?b$/.test(part)) {
      words.push(part.toUpperCase());
      previousWasVersion = false;
      continue;
    }
    const isVersion = /^\d+(\.\d+)*$/.test(part);
    const last = words.length - 1;
    if (isVersion && previousWasVersion && last >= 0) {
      words[last] += `.${part}`;
    } else if (isVersion && words[last] === "GPT") {
      words[last] += `-${part}`;
    } else if (isVersion) {
      words.push(part);
    } else if (part === "oss" && words[last] === "GPT") {
      words[last] = "GPT-OSS";
    } else if (UPPERCASE_WORDS.has(part)) {
      words.push(part.toUpperCase());
    } else if (/^o\d/.test(part)) {
      words.push(part);
    } else {
      words.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
    previousWasVersion = isVersion;
  }
  if (effort) notes.push(effort);
  if (!words.length) return raw;
  return `${words.join(" ")}${suffix}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}
