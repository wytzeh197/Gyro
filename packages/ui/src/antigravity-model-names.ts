import { humanModelName, modelEffortSuffix } from "./model-name.ts";

/**
 * The names Google Antigravity gives its models, by the id `agy --model`
 * takes. Source: https://antigravity.google/docs/models (checked 2026-11-20).
 * Orchestrator modes use their name as the id ("Orchestrator (Neon)"), so
 * they need no entry. A trailing effort ("gemini-4-neon-xhigh") is kept as a
 * parenthesised note.
 */
const ANTIGRAVITY_MODEL_NAMES: Record<string, string> = {
  "gemini-4-neon": "Gemini 4 Neon",
  "gemini-4-carbon": "Gemini 4 Carbon",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (Thinking)",
  "claude-opus-5-5": "Claude Opus 5.5 (Thinking)",
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6": "Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b": "GPT-OSS 120B (Medium)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
};

/** Antigravity's own name for a model id, or a readable one built from it. */
export function antigravityModelName(id: string): string {
  const raw = id.trim();
  const known = ANTIGRAVITY_MODEL_NAMES[raw];
  if (known) return known;
  const { base, effort } = modelEffortSuffix(raw);
  const baseName = ANTIGRAVITY_MODEL_NAMES[base];
  if (baseName && effort) {
    return baseName.endsWith(")")
      ? `${baseName.slice(0, -1)}, ${effort})`
      : `${baseName} (${effort})`;
  }
  return humanModelName(raw);
}
