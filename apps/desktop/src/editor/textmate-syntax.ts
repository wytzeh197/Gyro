import * as monaco from "monaco-editor";
import * as oniguruma from "vscode-oniguruma";
import { parseRawGrammar, type IOnigLib } from "vscode-textmate";
import type { LanguageDefinition } from "@gyro-dev/ui";
import wasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import manifest from "./textmate/manifest.json";
import {
  createTextMateRuntime,
  createTextMateTokensProvider,
} from "./textmate-runtime";

// URLs load eagerly; grammar bytes remain lazy. Failed dynamic module imports
// stay in the browser's module map, whereas a failed asset fetch can be retried.
const assets = import.meta.glob<string>("./textmate/grammars/*.json", {
  query: "?url&no-inline",
  import: "default",
  eager: true,
});
const roots = manifest.roots as Record<string, string>;
const scopes = manifest.scopes as Record<string, string>;
const aliases = manifest.scopeAliases as Record<string, string>;
const injections: { scopeName: string; injectTo: string[] }[] =
  manifest.grammars;
const grammarAssets = new Map<string, Promise<string>>();
function loadGrammarAsset(url: string) {
  let result = grammarAssets.get(url);
  if (!result) {
    result = fetch(url)
      .then(async (response) => {
        if (!response.ok)
          throw new Error("A bundled syntax grammar could not be loaded.");
        const text = await response.text();
        // A truncated JSON response must not become a successful cached asset.
        JSON.parse(text);
        return text;
      })
      .catch((error) => {
        if (grammarAssets.get(url) === result) grammarAssets.delete(url);
        throw error;
      });
    grammarAssets.set(url, result);
  }
  return result;
}
let engine: Promise<IOnigLib> | undefined;
function onigLib() {
  if (!engine) {
    engine = fetch(wasmUrl)
      .then(async (response) => {
        if (!response.ok)
          throw new Error("The bundled syntax engine could not be loaded.");
        // Compile before loadWASM: its singleton caches a rejected initialization.
        // This also avoids streaming MIME differences in WebKit's asset protocol.
        const module = await WebAssembly.compile(await response.arrayBuffer());
        await oniguruma.loadWASM({
          instantiator: async (imports) => ({
            module,
            instance: await WebAssembly.instantiate(module, imports),
          }),
        });
        return {
          createOnigScanner: oniguruma.createOnigScanner,
          createOnigString: oniguruma.createOnigString,
        };
      })
      .catch((error) => {
        engine = undefined;
        throw error;
      });
  }
  return engine;
}
const canonicalScope = (scope: string) => aliases[scope] ?? scope;
const runtime = createTextMateRuntime({
  // Defer WebAssembly and grammar loading until a supported file is opened.
  get onigLib() {
    return onigLib();
  },
  loadGrammar: async (scope) => {
    const file = scopes[canonicalScope(scope)];
    const url = file ? assets[`./textmate/${file}`] : undefined;
    if (!url) return null;
    const raw = parseRawGrammar(await loadGrammarAsset(url), file);
    return raw.scopeName === scope ? raw : { ...raw, scopeName: scope };
  },
  getInjections: (scope) =>
    injections
      .filter(
        (grammar) =>
          grammar.injectTo.includes(scope) ||
          grammar.injectTo.includes(canonicalScope(scope)),
      )
      .map((grammar) => grammar.scopeName),
});
const installed = new Map<string, Promise<string>>();

export async function loadTextMateSyntax(
  definition: LanguageDefinition,
): Promise<string | undefined> {
  if (definition.syntax.type !== "textmate") return;
  const name = definition.syntax.grammar;
  const scope = roots[name];
  if (!scope) return;
  let result = installed.get(name);
  if (!result) {
    const id = `gyro-tm-${name}`;
    result = runtime
      .load(scope)
      .then((grammar) => {
        monaco.languages.register({ id });
        monaco.languages.setTokensProvider(
          id,
          createTextMateTokensProvider(scope, grammar),
        );
        monaco.languages.setLanguageConfiguration(id, {
          comments:
            name === "sass"
              ? { lineComment: "//", blockComment: ["/*", "*/"] }
              : { blockComment: ["<!--", "-->"] },
          brackets: [
            ["{", "}"],
            ["[", "]"],
            ["(", ")"],
          ],
        });
        return id;
      })
      .catch((error) => {
        installed.delete(name);
        throw error;
      });
    installed.set(name, result);
  }
  return result;
}
