import type * as monaco from "monaco-editor";

type Rule = monaco.languages.IMonarchLanguageRule;

/**
 * Monaco's bundled TypeScript/JavaScript grammar has no JSX and colours every
 * name the same, so TSX reads as a wall of plain identifiers. Layer calls,
 * properties, constants, literals, primitive types, and JSX tags with their
 * attributes on top of it. `<` directly after a name is a generic or a
 * comparison, never a tag; those rules run first so only a free-standing `<`
 * can open a tag.
 */
export function withJsxTokens(
  language: monaco.languages.IMonarchLanguage,
): monaco.languages.IMonarchLanguage {
  const tokenizer = language.tokenizer as Record<string, Rule[]>;
  const common = tokenizer.common ?? [];
  const rules: Rule[] = [
    [/\.\.\./, "delimiter"],
    [/(true|false|null|undefined|NaN|Infinity)(?![\w$])/, "constant.language"],
    [
      /(string|number|boolean|bigint|symbol|unknown|never|any|void)(?![\w$])/,
      "keyword.type",
    ],
    [/[A-Z][A-Z0-9_]+(?![\w$])/, "constant"],
    [/(\.)(#?[a-zA-Z_$][\w$]*)(?=\s*\()/, ["delimiter", "function"]],
    [/(\.)(#?[a-zA-Z_$][\w$]*)/, ["delimiter", "property"]],
    [/([a-zA-Z_$][\w$]*)(<)(?=[^()]*>\s*\()/, ["function", "delimiter.angle"]],
    [/([A-Z][\w$]*)(<)/, ["type.identifier", "delimiter.angle"]],
    [/([a-z_$][\w$]*)(<)/, ["identifier", "delimiter.angle"]],
    [
      /#?[a-zA-Z_$][\w$]*(?=\s*\()/,
      { cases: { "@keywords": "keyword", "@default": "function" } },
    ],
    [/<\/?>/, "delimiter.angle"],
    [
      /(<\/?)([A-Z][\w$.]*)/,
      ["delimiter.angle", { token: "type.identifier", next: "@jsxTag" }],
    ],
    [
      /(<\/?)([a-z][\w.:-]*)/,
      ["delimiter.angle", { token: "tag", next: "@jsxTag" }],
    ],
  ];
  return {
    ...language,
    tokenizer: {
      ...tokenizer,
      common: [...rules, ...common],
      jsxTag: [
        [/\/?>/, "delimiter.angle", "@pop"],
        [/[a-zA-Z_$][\w$:-]*/, "attribute.name.jsx"],
        [/=/, "delimiter"],
        [/"[^"]*"|'[^']*'/, "string"],
        [/\{/, "delimiter.bracket", "@bracketCounting"],
        { include: "@whitespace" },
        [/./, ""],
      ],
    },
  };
}
