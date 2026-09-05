import type { languages } from "monaco-editor";
type Grammar = languages.IMonarchLanguage;
const strings: languages.IMonarchLanguageRule[] = [
  [/"""/, { token: "string", next: "@triple" }],
  [/"(?:[^"\\]|\\.)*"/, "string"],
  [/'[^']*'/, "string"],
];
const values: languages.IMonarchLanguageRule[] = [
  ...strings,
  [/\b(?:true|false|null|nil)\b/, "keyword"],
  [/[+-]?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, "number"],
  [/[=,:]/, "operator"],
  [/[{}[\]()]/, "delimiter.bracket"],
];
const grammar = (
  root: languages.IMonarchLanguageRule[],
  extra: Record<string, languages.IMonarchLanguageRule[]> = {},
): Grammar => ({
  tokenizer: {
    root,
    triple: [
      [/"""/, { token: "string", next: "@pop" }],
      [/./, "string"],
    ],
    ...extra,
  },
});
const hashComment: languages.IMonarchLanguageRule = [/#.*$/, "comment"];
const lineComment: languages.IMonarchLanguageRule = [/\/\/.*$/, "comment"];
const config = grammar([
  hashComment,
  [/^\s*[\w.-]+(?=\s*=)/, "attribute.name"],
  ...values,
]);
export const customGrammars: Record<string, Grammar> = {
  toml: grammar(
    [
      hashComment,
      [/^\s*\[\[?[^\]\n]+\]\]?\s*(?=#|$)/, "namespace"],
      [/\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-]+Z?)?/, "number.date"],
      [/\b[\w.-]+(?=\s*=)/, "attribute.name"],
      [/'''/, { token: "string", next: "@literal" }],
      ...values,
    ],
    {
      literal: [
        [/'''/, { token: "string", next: "@pop" }],
        [/./, "string"],
      ],
    },
  ),
  dotenv: grammar([
    hashComment,
    [/\bexport\b/, "keyword"],
    [/\$\{[^}]+\}|\$\w+/, "variable"],
    [/^[\w.-]+(?=\s*[:=])/, "attribute.name"],
    ...values,
  ]),
  jsonc: grammar(
    [
      lineComment,
      [/\/\*/, { token: "comment", next: "@comment" }],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "attribute.name"],
      ...values,
    ],
    {
      comment: [
        [/\*\//, { token: "comment", next: "@pop" }],
        [/./, "comment"],
      ],
    },
  ),
  delimited: grammar([
    [/"(?:[^"]|"")*"/, "string"],
    [/[\t,;]/, "delimiter"],
    [/[+-]?\d+(?:\.\d+)?/, "number"],
  ]),
  makefile: grammar([
    hashComment,
    [
      /^\s*(?:include|-include|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|override|private|unexport|vpath)\b/,
      "keyword",
    ],
    [/\$\([^)]+\)|\$\{[^}]+\}|\$[@<^?*%+|]/, "variable"],
    [/^[^\s#:=][^:=]*(?=:)/, "type.identifier"],
    [/[:?+!]?=/, "operator"],
    ...strings,
  ]),
  cmake: grammar([
    hashComment,
    [/\$\{[^}]+\}|\$ENV\{[^}]+\}/, "variable"],
    [/\b[a-zA-Z_][\w]*(?=\s*\()/, "function"],
    ...values,
  ]),
  prisma: grammar([
    lineComment,
    [/\b(?:model|enum|datasource|generator|type|view)\b/, "keyword"],
    [/@@?\w+/, "annotation"],
    [
      /\b(?:String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes|Unsupported)\b/,
      "type.identifier",
    ],
    ...values,
  ]),
  requirements: grammar([
    hashComment,
    [/^-\S+/, "keyword"],
    [/[<>=!~]+/, "operator"],
    [/\b\d[\w.*+-]*/, "number"],
    [/^[\w.-]+/, "type.identifier"],
  ]),
  yarnlock: grammar([
    hashComment,
    [/^\S.*:$/, "type.identifier"],
    [
      /\b(?:version|resolution|resolved|integrity|dependencies|checksum)\b/,
      "attribute.name",
    ],
    ...values,
  ]),
  gomod: grammar([
    lineComment,
    [
      /\b(?:module|go|toolchain|require|replace|exclude|retract|use)\b/,
      "keyword",
    ],
    [/\bv\d[^\s)]+/, "number"],
    ...values,
  ]),
  gitignore: grammar([
    hashComment,
    [/^!/, "operator"],
    [/[?*\[\]]/, "regexp"],
    [
      /\b(?:text|binary|diff|merge|filter|eol|working-tree-encoding)\b/,
      "attribute.name",
    ],
  ]),
  gitcommit: grammar([hashComment, [/^.{1,72}$/, "string"]]),
  gitrebase: grammar([
    hashComment,
    [
      /^\s*(?:pick|reword|edit|squash|fixup|exec|break|drop|label|reset|merge|update-ref|p|r|e|s|f|x|b|d|l|t|m|u)\b/,
      "keyword",
    ],
    [/\b[\da-f]{7,40}\b/, "number"],
  ]),
  diff: grammar([
    [/^@@.*$/, "namespace"],
    [/^(?:diff |index |--- |\+\+\+ ).*$/, "meta"],
    [/^\+.*$/, "inserted"],
    [/^-.*$/, "deleted"],
  ]),
  ini: config,
};
export const customConfiguration: languages.LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: "(", close: ")" },
  ],
};
