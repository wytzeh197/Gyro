import type { editor } from "monaco-editor";
import {
  createSyntaxTheme,
  workspaceEditorColors,
  tokenRoles,
  tokenRoleAliases,
} from "@gyro-dev/ui";
export function createMonacoTheme(
  mode: "light" | "dark",
): editor.IStandaloneThemeData {
  const syntax = createSyntaxTheme(mode);
  const rules = Object.entries({
    ...Object.fromEntries(tokenRoles.map((role) => [role, role])),
    ...tokenRoleAliases,
  }).map(([token, role]) => ({
    token,
    foreground: syntax[role as keyof typeof syntax],
    fontStyle:
      role === "comment" || role === "docComment" || role === "markdownItalic"
        ? "italic"
        : role === "markdownBold" || role === "markdownHeading"
          ? "bold"
          : role === "deprecated"
            ? "strikethrough"
            : "",
  }));
  const colors: Record<string, string> = { ...workspaceEditorColors[mode] };
  const brackets = [
    syntax.type,
    syntax.function,
    syntax.number,
    syntax.keyword,
    syntax.string,
    syntax.parameter,
  ];
  brackets.forEach((color, index) => {
    colors[`editorBracketHighlight.foreground${index + 1}`] = `#${color}`;
  });
  colors["editorBracketHighlight.unexpectedBracket.foreground"] =
    `#${syntax.invalid}`;
  return {
    base: mode === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules,
    colors,
  };
}
