import {
  INITIAL,
  Registry,
  type IGrammar,
  type IOnigLib,
  type IRawGrammar,
  type StateStack,
} from "vscode-textmate";
import type { TokenRole } from "@gyro-dev/ui";

/** Each root owns its registry, so retrying one failed grammar preserves others. */
export function createTextMateRuntime(options: {
  onigLib: Promise<IOnigLib>;
  loadGrammar(scope: string): Promise<IRawGrammar | null>;
  getInjections?(scope: string): string[];
}) {
  const pending = new Map<string, Promise<IGrammar>>();
  return {
    load(scope: string): Promise<IGrammar> {
      const existing = pending.get(scope);
      if (existing) return existing;
      const library = options.onigLib;
      const registry = new Registry({ ...options, onigLib: library });
      // Observe engine failure immediately while grammar assets are loading.
      const result = Promise.all([library, registry.loadGrammar(scope)])
        .then(([, grammar]) => {
          if (!grammar)
            throw new Error(`Bundled grammar is unavailable: ${scope}`);
          return grammar;
        })
        .catch((error) => {
          registry.dispose();
          if (pending.get(scope) === result) pending.delete(scope);
          throw error;
        });
      pending.set(scope, result);
      return result;
    },
  };
}

/** Scope interpretation returns theme roles, never provider-specific colors. */
export function textMateTokenRole(scopes: readonly string[]): TokenRole | "" {
  const css = scopes.some((scope) =>
    /(?:^|\.)(?:css|scss|sass|less|postcss)(?:\.|$)/.test(scope),
  );
  const sassVariable = scopes.includes("meta.variable-usage.sass");
  const sassFunction =
    !sassVariable &&
    scopes.some((scope) =>
      /meta\.(?:variable-declaration\.sass\.mixin|function\.include\.sass)/.test(
        scope,
      ),
    );
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index]!;
    if (/^invalid\b/.test(scope)) return "invalid";
    if (/\bcomment\b/.test(scope))
      return /documentation|doc\b/.test(scope) ? "docComment" : "comment";
    if (/escape/.test(scope)) return "escapeCharacter";
    if (/regexp|regex/.test(scope)) return "regex";
    if (/punctuation\.definition\.string/.test(scope)) return "string";
    if (/^string\b/.test(scope))
      return /template/.test(scope) ? "templateString" : "string";
    if (
      sassVariable &&
      /^(?:variable|punctuation\.definition\.entity)\b/.test(scope)
    )
      return "variable";
    if (/property-name|css\.property|support\.type\.property/.test(scope))
      return "cssProperty";
    if (
      /property-value|color\.(?:hex|rgb)|support\.constant.*(?:css|sass|scss)/.test(
        scope,
      )
    )
      return "cssValue";
    if (/unit\b/.test(scope) && css) return "cssUnit";
    if (
      /entity\.name\.tag|entity\.other\.(?:attribute-name\.(?:class|id)|pseudo)/.test(
        scope,
      )
    )
      return css ? "cssSelector" : "tag";
    if (/entity\.other\.attribute-name/.test(scope)) return "htmlAttribute";
    if (/constant\.numeric/.test(scope)) return "number";
    if (/constant\.language\.(?:boolean|true|false)/.test(scope))
      return "boolean";
    if (/constant\.language\.null/.test(scope)) return "null";
    if (/constant\.language\.undefined/.test(scope)) return "undefined";
    if (/keyword\.operator/.test(scope)) return "operator";
    if (/^keyword\b/.test(scope))
      return /control/.test(scope) ? "controlKeyword" : "keyword";
    if (/^storage\b/.test(scope)) return "storageKeyword";
    if (/entity\.name\.function|support\.function/.test(scope))
      return "function";
    if (/entity\.name\.(?:type|class)|support\.type/.test(scope)) return "type";
    if (/variable\.parameter/.test(scope)) return "parameter";
    if (/variable.*(?:property|member)/.test(scope)) return "property";
    if (/^variable\b/.test(scope))
      return sassFunction ? "function" : "variable";
    if (/^constant\b/.test(scope)) return "constant";
    // Definition punctuation keeps its surrounding comment/string/selector role.
    if (/^punctuation\b/.test(scope) && !/definition/.test(scope))
      return "punctuation";
  }
  return "";
}

export class TextMateState {
  constructor(
    readonly scope: string,
    readonly stack: StateStack = INITIAL,
  ) {}
  clone() {
    return this;
  }
  equals(other: unknown) {
    return (
      other instanceof TextMateState &&
      this.scope === other.scope &&
      this.stack.equals(other.stack)
    );
  }
}

export function createTextMateTokensProvider(scope: string, grammar: IGrammar) {
  return {
    getInitialState: () => new TextMateState(scope),
    tokenize(line: string, state: TextMateState) {
      let result = grammar.tokenizeLine(line, state.stack, 20);
      // Cold regex compilation can exhaust the budget mid-line. Complete from
      // the original state so a partial stack cannot corrupt subsequent lines.
      if (result.stoppedEarly) result = grammar.tokenizeLine(line, state.stack);
      const tokens: { startIndex: number; scopes: string }[] = [];
      for (const token of result.tokens) {
        if (token.startIndex > line.length) continue;
        const role = textMateTokenRole(token.scopes);
        if (!tokens.length || tokens.at(-1)!.scopes !== role)
          tokens.push({ startIndex: token.startIndex, scopes: role });
      }
      if (!tokens.length || tokens[0]!.startIndex !== 0)
        tokens.unshift({ startIndex: 0, scopes: "" });
      return { tokens, endState: new TextMateState(scope, result.ruleStack) };
    },
  };
}
