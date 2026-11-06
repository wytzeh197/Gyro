import type { LanguageDefinition } from "@gyro-dev/ui";

export type SyntaxResult = {
  language: string;
  available: boolean;
  reason?: string;
};
export type SyntaxProvider = (
  definition: LanguageDefinition,
) => Promise<string | undefined>;

// Share concurrent loads and successful grammars; failed loads can be retried.
export function createSyntaxLoader(
  providers: Partial<
    Record<LanguageDefinition["syntax"]["type"], SyntaxProvider>
  >,
) {
  const pending = new Map<string, Promise<SyntaxResult>>();
  return (definition: LanguageDefinition): Promise<SyntaxResult> => {
    const syntax = definition.syntax;
    if (syntax.type === "plaintext")
      return Promise.resolve({ language: "plaintext", available: true });
    const key = `${syntax.type}:${"language" in syntax ? syntax.language : syntax.grammar}`;
    let result = pending.get(key);
    if (!result) {
      result = Promise.resolve()
        .then(() => providers[syntax.type]?.(definition))
        .then((language) =>
          language
            ? { language, available: true }
            : {
                language: "plaintext",
                available: false,
                reason: "Highlighting is not installed for this language.",
              },
        )
        .catch(() => ({
          language: "plaintext",
          available: false,
          reason:
            "Highlighting could not be loaded. Plain text remains available.",
        }));
      pending.set(key, result);
      void result.then((loaded) => {
        if (!loaded.available && pending.get(key) === result)
          pending.delete(key);
      });
    }
    return result;
  };
}
