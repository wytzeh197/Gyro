import retirements from "./model-retirements.json" with { type: "json" };

/** Provider-scoped retirements; API-only availability is kept separate from Codex sign-in. */
export function retiredModelReplacement(
  providerId: string,
  modelId: string,
  usesApiKey = false,
): string | undefined {
  return retirements.retirements.find(
    (entry) =>
      entry.providerId === providerId &&
      entry.modelIds.includes(modelId.trim()) &&
      (entry.scope !== "codex-chatgpt" || !usesApiKey),
  )?.replacement;
}
