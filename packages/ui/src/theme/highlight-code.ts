import { createHighlighterCore, type ThemeRegistration } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";

const languages = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  swift: () => import("@shikijs/langs/swift"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  sql: () => import("@shikijs/langs/sql"),
  diff: () => import("@shikijs/langs/diff"),
  markdown: () => import("@shikijs/langs/markdown"),
} as const;
type Language = keyof typeof languages;
const aliases: Record<string, Language> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  golang: "go",
  bash: "shellscript",
  zsh: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  ps1: "powershell",
  yml: "yaml",
  md: "markdown",
  patch: "diff",
};

// Shiki's palette IDs map to inherited CSS variables so a theme change updates
// existing code blocks without re-running the grammar or caching custom themes.
const roles = {
  "#000001": "keyword",
  "#000002": "string",
  "#000003": "number",
  "#000004": "symbol",
  "#000005": "comment",
  "#000006": "added",
  "#000007": "removed",
} as const;

const theme: ThemeRegistration = {
  name: "gyro-code",
  type: "dark",
  colors: { "editor.foreground": "#ffffff", "editor.background": "#000000" },
  tokenColors: [
    {
      scope: ["keyword", "storage", "constant.language"],
      settings: { foreground: "#000001" },
    },
    {
      scope: ["string", "markup.inline.raw"],
      settings: { foreground: "#000002" },
    },
    {
      scope: ["constant.numeric", "constant.character"],
      settings: { foreground: "#000003" },
    },
    {
      scope: ["entity.name", "support.function", "support.type"],
      settings: { foreground: "#000004" },
    },
    { scope: ["comment"], settings: { foreground: "#000005" } },
    { scope: ["markup.inserted"], settings: { foreground: "#000006" } },
    { scope: ["markup.deleted"], settings: { foreground: "#000007" } },
  ],
};

let engine: ReturnType<typeof createHighlighterCore> | undefined;
const loaded = new Map<Language, Promise<void>>();

export type CodeToken = {
  content: string;
  role?: (typeof roles)[keyof typeof roles];
};

export async function highlightCode(
  code: string,
  language: string,
): Promise<CodeToken[][] | undefined> {
  const name = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const lang = Object.hasOwn(aliases, name)
    ? aliases[name]!
    : (name as Language);
  if (!Object.hasOwn(languages, lang)) return;
  engine ??= createHighlighterCore({
    langs: [],
    themes: [theme],
    engine: createOnigurumaEngine(
      import("@shikijs/engine-oniguruma/wasm-inlined"),
    ),
  }).catch((error) => {
    engine = undefined;
    throw error;
  });
  const highlighter = await engine;
  let pending = loaded.get(lang);
  if (!pending) {
    pending = highlighter.loadLanguage(languages[lang]()).catch((error) => {
      loaded.delete(lang);
      throw error;
    });
    loaded.set(lang, pending);
  }
  await pending;
  const { tokens } = highlighter.codeToTokens(code, {
    lang,
    theme: theme.name!,
  });
  return tokens.map((line) =>
    line.map(({ content, color }) => ({
      content,
      role: color
        ? roles[color.toLowerCase() as keyof typeof roles]
        : undefined,
    })),
  );
}
