import { languageDefinitions } from "./definitions";
import type { LanguageDefinition, LanguageInput } from "./types";

const ordered = [...languageDefinitions].sort(
  (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
);
const ids = new Map(ordered.map((language) => [language.id, language]));
const names = new Map<string, LanguageDefinition>();
const extensions = new Map<string, LanguageDefinition[]>();
for (const language of ordered) {
  for (const name of language.filenames ?? [])
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), language);
  for (const extension of language.extensions ?? []) {
    const key = extension.toLowerCase();
    extensions.set(key, [...(extensions.get(key) ?? []), language]);
  }
}
export const languages: readonly LanguageDefinition[] = [...ordered].sort(
  (a, b) => a.name.localeCompare(b.name),
);
export const getLanguage = (id: string) => ids.get(id);
const plain = ids.get("plaintext")!;
const matches = (pattern: RegExp, value: string) => {
  pattern.lastIndex = 0;
  return pattern.test(value);
};

export function resolveLanguage(input: LanguageInput): LanguageDefinition {
  if (input.override && ids.has(input.override))
    return ids.get(input.override)!;
  const path = input.path.replaceAll("\\", "/");
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const exact = names.get(name);
  if (exact) return exact;
  for (const language of ordered) {
    if (
      language.patterns?.some((pattern) => matches(pattern, name)) ||
      language.pathPatterns?.some((pattern) => matches(pattern, path))
    )
      return language;
  }
  // Walking dots left to right gives longest compound suffix precedence.
  for (
    let dot = name.indexOf(".");
    dot >= 0;
    dot = name.indexOf(".", dot + 1)
  ) {
    const candidates = extensions.get(name.slice(dot));
    if (candidates?.length) {
      if (candidates.length > 1 && input.content) {
        const sample = input.content.slice(0, 8192);
        const hints: Record<string, RegExp> = {
          cpp: /\b(?:namespace|template|class)\b|std::/,
          "objective-c": /@(?:interface|implementation|import)\b/,
          matlab: /^\s*(?:function\b|%)/m,
          prolog: /:-/,
          lisp: /^\s*\((?:defun|defvar|setq)\b/m,
          scheme: /^\s*\(define\b/m,
          systemverilog: /\b(?:interface|always_ff|logic)\b/,
        };
        const hinted = candidates.find((language) =>
          hints[language.id]?.test(sample),
        );
        if (hinted) return hinted;
      }
      return candidates[0]!;
    }
  }
  const sample = (input.content ?? "").slice(0, 8192);
  const firstLine = (input.firstLine ?? sample.split(/\r?\n/, 1)[0] ?? "")
    .slice(0, 512)
    .replace(/^\uFEFF/, "");
  if (firstLine.startsWith("#!")) {
    const language = ordered.find((language) =>
      language.shebangs?.some((pattern) => matches(pattern, firstLine)),
    );
    if (language) return language;
  }
  const mime = input.mimeType?.split(";", 1)[0]?.toLowerCase();
  if (mime) {
    const language = ordered.find((language) =>
      language.mimeTypes?.includes(mime),
    );
    if (language) return language;
  }
  // Only unmistakable signatures; never guess from an isolated keyword.
  if (/^\s*<\?xml\b/.test(sample)) return ids.get("xml")!;
  if (/^\s*<!doctype html\b/i.test(sample)) return ids.get("html")!;
  if (/^\s*<\?php\b/.test(sample)) return ids.get("php")!;
  if (/^\s*[{[]/.test(sample) && (input.content?.length ?? 0) <= 8192) {
    try {
      JSON.parse(sample);
      return ids.get("json")!;
    } catch {
      /* incomplete or not JSON */
    }
  }
  return plain;
}

export function searchLanguages(query: string) {
  const needle = query.trim().toLowerCase();
  return languages.filter(
    (language) =>
      !language.binary &&
      [
        language.name,
        language.id,
        ...(language.aliases ?? []),
        ...(language.extensions ?? []),
        ...(language.filenames ?? []),
      ].some((value) => value.toLowerCase().includes(needle)),
  );
}

export function editorFilePolicy(
  path: string,
  content: string,
  sizeBytes = content.length,
  truncated = false,
) {
  const language = resolveLanguage({ path, content });
  const binary = !!language.binary || /\u0000/.test(content.slice(0, 8192));
  const hugeLine = content
    .slice(0, 131072)
    .split("\n")
    .some((line) => line.length > 20000);
  const limited = truncated || sizeBytes > 512 * 1024 || hugeLine;
  return {
    binary,
    limited,
    readOnly: binary || truncated,
    reason: binary
      ? "Binary files cannot be displayed as text."
      : truncated
        ? "File preview is truncated and read-only."
        : limited
          ? "Large or minified file: expensive editor features are disabled."
          : undefined,
  };
}
