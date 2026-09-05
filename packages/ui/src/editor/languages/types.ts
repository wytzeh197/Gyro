export type SyntaxSource =
  | { type: "monaco"; language: string }
  | { type: "custom"; language: string }
  | { type: "textmate"; grammar: string; scopeName?: string }
  | { type: "plaintext" };

export interface LanguageDefinition {
  id: string;
  name: string;
  aliases?: readonly string[];
  extensions?: readonly string[];
  filenames?: readonly string[];
  patterns?: readonly RegExp[];
  pathPatterns?: readonly RegExp[];
  shebangs?: readonly RegExp[];
  mimeTypes?: readonly string[];
  syntax: SyntaxSource;
  icon?: string;
  priority?: number;
  binary?: boolean;
  lsp?: { languageId?: string; command: string };
}
export interface LanguageInput {
  path: string;
  content?: string;
  firstLine?: string;
  override?: string;
  mimeType?: string;
}
