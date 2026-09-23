/**
 * Model classes: the family a model belongs to, read from its name.
 *
 * "Claude Opus 5.5" and "Claude Opus 4.8" are both Opus; "GPT-6 Astra" and
 * "GPT-6 Sol" are both GPT-6. The picker lists a provider's models under
 * their class so every Opus sits together, whatever order the catalog (or a
 * runtime-discovered model) arrived in.
 */

export type ModelClassGroup<T> = {
  id: string;
  label: string;
  models: T[];
};

/**
 * The class of one model name: the words before its version.
 *
 * - "Claude Fable 5.1" → "Claude Fable", "Kimi K3" → "Kimi"
 * - "GPT-5.4 mini" → "GPT-5", "Qwen3.8 Max" → "Qwen3", "llama3.2:latest" → "llama3"
 *   (the name and major version share a token, so the major version is the class)
 * - "Codestral", "Cursor default" → the whole name
 */
export function modelClassName(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const family: string[] = [];
  for (const token of tokens) {
    if (!/\d/.test(token)) {
      family.push(token);
      continue;
    }
    if (family.length > 0) break;
    const joined = /^(\D+?)(\d+)/.exec(token);
    return joined ? `${joined[1]}${joined[2]}` : token;
  }
  return family.join(" ") || name.trim();
}

/**
 * A provider's models grouped by class, in the order each class first
 * appears, so a model discovered late still sits beside its class.
 *
 * `headed` says whether the classes are worth a heading: there must be more
 * than one, and most of them must hold several models. A router's mixed list
 * (one Claude, one Gemini, two Grok...) stays flat, since each name already
 * says its family, but same-class models still sit together.
 *
 * A brand every class shares ("Claude") is dropped from the headings, so
 * Anthropic reads Fable, Opus, Sonnet, Haiku.
 */
export function groupModelsByClass<T>(
  models: readonly T[],
  nameOf: (model: T) => string,
): { groups: ModelClassGroup<T>[]; headed: boolean } {
  const byId = new Map<string, ModelClassGroup<T>>();
  for (const model of models) {
    const label = modelClassName(nameOf(model));
    const id = label.toLowerCase();
    const group = byId.get(id);
    if (group) group.models.push(model);
    else byId.set(id, { id, label, models: [model] });
  }
  const groups = [...byId.values()];
  const shared = groups.filter((group) => group.models.length > 1).length;
  const headed = groups.length > 1 && shared * 2 >= groups.length;
  const brands = new Set(groups.map((group) => group.label.split(" ")[0]));
  if (headed && brands.size === 1) {
    for (const group of groups) {
      const rest = group.label.split(" ").slice(1).join(" ");
      if (rest) group.label = rest;
    }
  }
  return { groups, headed };
}
