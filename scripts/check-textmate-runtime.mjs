import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { workspaceSyntaxSamples } from "../apps/desktop/src/workspace-syntax-samples.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = join(repo, "apps/desktop/src/editor/textmate");
const manifest = JSON.parse(
  readFileSync(join(assetsRoot, "manifest.json"), "utf8"),
);
const desktopRequire = createRequire(join(repo, "apps/desktop/package.json"));
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const oniguruma = desktopRequire("vscode-oniguruma");
const { parseRawGrammar } = desktopRequire("vscode-textmate");
const temporary = await mkdtemp(join(tmpdir(), "gyro-textmate-runtime-tests-"));
try {
  const output = join(temporary, "runtime.mjs");
  await build({
    entryPoints: [join(repo, "apps/desktop/src/editor/textmate-runtime.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    createTextMateRuntime,
    createTextMateTokensProvider,
    textMateTokenRole,
  } = await import(pathToFileURL(output));
  // The same pinned native regex engine and WASM bytes shipped by the adapter.
  await oniguruma.loadWASM(
    readFileSync(desktopRequire.resolve("vscode-oniguruma/release/onig.wasm")),
  );
  const library = Promise.resolve({
    createOnigScanner: oniguruma.createOnigScanner,
    createOnigString: oniguruma.createOnigString,
  });
  const canonical = (scope) => manifest.scopeAliases[scope] ?? scope;
  async function loadAsset(scope) {
    const file = manifest.scopes[canonical(scope)];
    if (!file) return null;
    const grammar = parseRawGrammar(
      readFileSync(join(assetsRoot, file), "utf8"),
      file,
    );
    return grammar.scopeName === scope
      ? grammar
      : { ...grammar, scopeName: scope };
  }
  const injections = (scope) =>
    manifest.grammars
      .filter(
        (grammar) =>
          grammar.injectTo.includes(scope) ||
          grammar.injectTo.includes(canonical(scope)),
      )
      .map((grammar) => grammar.scopeName);
  const counts = new Map();
  const runtime = createTextMateRuntime({
    onigLib: library,
    loadGrammar: async (scope) => {
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
      return loadAsset(scope);
    },
    getInjections: injections,
  });
  const roots = Object.entries(manifest.roots);
  const pairs = roots.map(([name, scope]) => [
    name,
    runtime.load(scope),
    runtime.load(scope),
  ]);
  for (const [name, first, second] of pairs)
    assert.equal(
      first,
      second,
      `Concurrent ${name} requests must share one installation promise.`,
    );
  const grammars = Object.fromEntries(
    await Promise.all(
      pairs.map(async ([name, first, second]) => {
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a, b);
        const callsBeforeRepeat = counts.get(manifest.roots[name]);
        assert.equal(
          await runtime.load(manifest.roots[name]),
          a,
          `${name} must retain its successful grammar.`,
        );
        assert.equal(
          counts.get(manifest.roots[name]),
          callsBeforeRepeat,
          `${name} repeated root loads must not reinstall assets.`,
        );
        return [name, a];
      }),
    ),
  );
  for (const scope of [
    "vue.directives",
    "vue.interpolations",
    "svelte.pug",
    "documentation.injection.ts",
  ])
    assert(
      (counts.get(scope) ?? 0) > 0,
      `The adapter injection graph must load ${scope}.`,
    );

  const rawAt = (line, tokens, needle) => {
    const position = line.indexOf(needle);
    assert(position >= 0, `Fixture needle is missing: ${needle}`);
    const token = tokens.find(
      (token) => token.startIndex <= position && token.endIndex > position,
    );
    assert(token, `No raw token covers ${needle} in ${line}`);
    return token;
  };
  const roleAt = (line, tokens, needle) => {
    const position = line.indexOf(needle);
    assert(position >= 0);
    return [...tokens].reverse().find((token) => token.startIndex <= position)
      ?.scopes;
  };
  function tokenizeDocument(grammar, scope, content) {
    const provider = createTextMateTokensProvider(scope, grammar);
    let state = provider.getInitialState();
    const lines = content.split(/\r\n|\n|\r/);
    // Run the shipped provider cold first. Warming raw grammars here would hide
    // a stoppedEarly budget bug that corrupts following script/style boundaries.
    const mapped = lines.map((line) => {
      const before = state;
      const result = provider.tokenize(line, state);
      state = result.endState;
      assert.equal(
        before.clone(),
        before,
        "Immutable tokenizer states must clone safely.",
      );
      assert(state.equals(state));
      assert.equal(result.tokens[0].startIndex, 0);
      assert(
        result.tokens.every(
          (token, index) =>
            Number.isSafeInteger(token.startIndex) &&
            token.startIndex >= 0 &&
            token.startIndex <= line.length &&
            (!index || token.startIndex > result.tokens[index - 1].startIndex),
        ),
      );
      return result.tokens;
    });
    let stack;
    const raw = lines.map((line, lineIndex) => {
      const result = grammar.tokenizeLine(line, stack, 0);
      stack = result.ruleStack;
      assert.equal(result.stoppedEarly, false);
      for (const token of result.tokens) {
        if (token.startIndex >= line.length) continue;
        const role = [...mapped[lineIndex]]
          .reverse()
          .find(
            (mappedToken) => mappedToken.startIndex <= token.startIndex,
          )?.scopes;
        assert.equal(
          role,
          textMateTokenRole(token.scopes),
          `Cold provider must match complete tokenization at line ${lineIndex + 1}, offset ${token.startIndex}: ${line}`,
        );
      }
      return result.tokens;
    });
    return { lines, mapped, raw, provider };
  }
  function expectToken(document, lineIndex, needle, role, rawScope) {
    const line = document.lines[lineIndex];
    const raw = rawAt(line, document.raw[lineIndex], needle);
    assert.equal(
      roleAt(line, document.mapped[lineIndex], needle),
      role,
      `Incorrect role for ${needle}: ${line}`,
    );
    if (rawScope)
      assert(
        raw.scopes.some((scope) => rawScope.test(scope)),
        `Missing raw scope ${rawScope} for ${needle}: ${raw.scopes.join(" ")}`,
      );
    return raw;
  }

  // Shared browser/native samples include multiline TS comments/backticks, an
  // emoji followed by more same-line JavaScript, CSS comments and closing tags.
  const samples = {};
  for (const [path, content] of Object.entries(workspaceSyntaxSamples)) {
    const name = path.split(".").at(-1);
    samples[name] = tokenizeDocument(
      grammars[name],
      manifest.roots[name],
      content,
    );
  }
  for (const name of ["vue", "svelte", "astro"]) {
    const document = samples[name];
    expectToken(document, 1, "comment", "comment", /comment\.block\.ts/);
    expectToken(document, 2, "continues", "comment", /comment\.block\.ts/);
    expectToken(document, 3, "const", "storageKeyword", /storage\.type\.ts/);
    expectToken(document, 3, "string", "type", /support\.type\.primitive\.ts/);
    expectToken(document, 3, "Hello", "templateString", /string\.template\.ts/);
    expectToken(
      document,
      4,
      "Workspace",
      "templateString",
      /string\.template\.ts/,
    );
  }
  expectToken(samples.vue, 8, "accent", "variable", /variable\.scss/);
  expectToken(
    samples.vue,
    10,
    "color",
    "cssProperty",
    /support\.type\.property-name\.css/,
  );
  expectToken(samples.vue, 12, "style", "tag", /entity\.name\.tag/);
  expectToken(
    samples.svelte,
    10,
    "rebeccapurple",
    "cssValue",
    /support\.constant\.color/,
  );
  expectToken(samples.svelte, 11, "style", "tag", /entity\.name\.tag\.svelte/);
  const inline = samples.astro.lines[7];
  expectToken(samples.astro, 7, "🚀", "string", /string\.quoted\.double\.js/);
  const ready = expectToken(
    samples.astro,
    7,
    "ready",
    "variable",
    /variable\.other\.constant\.js/,
  );
  assert.equal(
    ready.startIndex,
    inline.indexOf("ready"),
    "TextMate and Monaco must use UTF-16 offsets after a surrogate-pair emoji.",
  );
  assert.equal(inline.slice(0, ready.startIndex).length, ready.startIndex);
  assert.notEqual(
    Buffer.byteLength(inline.slice(0, ready.startIndex)),
    ready.startIndex,
  );
  expectToken(samples.astro, 8, "style", "tag", /entity\.name\.tag\.astro/);
  expectToken(
    samples.astro,
    11,
    "color",
    "cssProperty",
    /support\.type\.property-name\.css/,
  );
  expectToken(samples.astro, 12, "style", "tag", /entity\.name\.tag\.astro/);

  // SCSS is distinct from indented Sass, and each remains embedded in its host.
  const scss = tokenizeDocument(
    grammars.astro,
    manifest.roots.astro,
    '---\nconst gap = 2;\n---\n<style lang="scss">\n$space: 4px;\n.card { padding: $space; color: #222; }\n</style>',
  );
  expectToken(scss, 4, "$space", "variable", /variable\.scss/);
  expectToken(scss, 4, "px", "cssUnit", /unit\.px\.css/);
  expectToken(scss, 5, "card", "cssSelector", /attribute-name\.class\.css/);
  expectToken(scss, 5, "padding", "cssProperty", /property-name\.css/);
  expectToken(scss, 5, "222", "cssValue", /color\.rgb-value\.hex\.css/);
  expectToken(scss, 6, "style", "tag", /entity\.name\.tag/);
  const sass = tokenizeDocument(
    grammars.sass,
    manifest.roots.sass,
    "$gap: 8px\n@mixin inset($size)\n  padding: $size\n.card\n  @include inset($gap)\n  color: #ff8800\n  // note",
  );
  expectToken(sass, 0, "gap", "variable", /variable\.other\.sass/);
  expectToken(sass, 0, "px", "cssUnit", /unit\.px\.css/);
  expectToken(sass, 1, "mixin", "controlKeyword", /at-rule\.mixin\.sass/);
  expectToken(sass, 1, "inset", "function", /variable\.other\.sass/);
  expectToken(sass, 1, "size", "variable", /meta\.variable-usage\.sass/);
  expectToken(sass, 1, "$size", "variable", /meta\.variable-usage\.sass/);
  expectToken(sass, 2, "padding", "cssProperty", /property-name\.css/);
  expectToken(sass, 4, "include", "controlKeyword", /at-rule\.include\.sass/);
  expectToken(sass, 4, "inset", "function", /variable\.other\.sass/);
  expectToken(sass, 4, "gap", "variable", /meta\.variable-usage\.sass/);
  expectToken(sass, 4, "$gap", "variable", /meta\.variable-usage\.sass/);
  expectToken(sass, 5, "ff8800", "cssValue", /color\.rgb-value/);
  expectToken(sass, 6, "note", "comment", /comment\.line\.sass/);

  const htmlAlias = await runtime.load("source.html");
  const html = tokenizeDocument(
    htmlAlias,
    "source.html",
    '<p class="note">hello</p>',
  );
  expectToken(html, 0, "class", "htmlAttribute", /attribute-name/);
  assert(
    html.raw[0].every((token) => token.scopes[0] === "source.html"),
    "Alias grammars must be cached under their requested scope.",
  );
  const lessAlias = await runtime.load("source.less");
  const less = tokenizeDocument(
    lessAlias,
    "source.less",
    ".card { color: red; }",
  );
  expectToken(less, 0, "color", "cssProperty", /property-name/);

  let failVue = true;
  let releaseFailure;
  const failureGate = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  const attempts = new Map();
  const retrying = createTextMateRuntime({
    onigLib: library,
    getInjections: injections,
    loadGrammar: async (scope) => {
      attempts.set(scope, (attempts.get(scope) ?? 0) + 1);
      if (scope === manifest.roots.vue && failVue) {
        await failureGate;
        throw new Error("Injected asset failure");
      }
      return loadAsset(scope);
    },
  });
  const retained = await retrying.load(manifest.roots.sass);
  const failedA = retrying.load(manifest.roots.vue);
  const failedB = retrying.load(manifest.roots.vue);
  assert.equal(failedA, failedB);
  releaseFailure();
  const failures = await Promise.allSettled([failedA, failedB]);
  assert(
    failures.every(
      (result) =>
        result.status === "rejected" &&
        /Injected asset failure/.test(String(result.reason)),
    ),
  );
  assert.equal(attempts.get(manifest.roots.vue), 1);
  assert.equal(
    await retrying.load(manifest.roots.sass),
    retained,
    "Failure in one root must not dispose a successful grammar.",
  );
  failVue = false;
  const recovered = await retrying.load(manifest.roots.vue);
  assert.equal(
    attempts.get(manifest.roots.vue),
    2,
    "Failed root must get a fresh registry on retry.",
  );
  assert.equal(await retrying.load(manifest.roots.vue), recovered);
  const sassLoadsBeforeRepeat = attempts.get(manifest.roots.sass);
  assert.equal(await retrying.load(manifest.roots.sass), retained);
  assert.equal(
    attempts.get(manifest.roots.sass),
    sassLoadsBeforeRepeat,
    "Successful roots must retain their registry even when another root retries.",
  );
  const retainedAfterFailure = tokenizeDocument(
    retained,
    manifest.roots.sass,
    "$gap: 8px",
  );
  expectToken(
    retainedAfterFailure,
    0,
    "gap",
    "variable",
    /variable\.other\.sass/,
  );

  let missing = true;
  const missingRuntime = createTextMateRuntime({
    onigLib: library,
    loadGrammar: async (scope) => {
      if (scope === "source.retry-test") {
        if (missing) return null;
        return { ...(await loadAsset(manifest.roots.sass)), scopeName: scope };
      }
      return loadAsset(scope);
    },
  });
  await assert.rejects(
    missingRuntime.load("source.retry-test"),
    /source\.retry-test/,
  );
  missing = false;
  assert(
    await missingRuntime.load("source.retry-test"),
    "A missing root must not remain permanently cached.",
  );

  let currentLibrary = library;
  const engineRetry = createTextMateRuntime({
    get onigLib() {
      return currentLibrary;
    },
    loadGrammar: loadAsset,
    getInjections: injections,
  });
  const engineRetained = await engineRetry.load(manifest.roots.sass);
  currentLibrary = Promise.reject(
    new Error("Injected engine initialization failure"),
  );
  await assert.rejects(
    engineRetry.load(manifest.roots.vue),
    /engine initialization failure/,
  );
  currentLibrary = library;
  const recoveredEngineGrammar = await engineRetry.load(manifest.roots.vue);
  assert(
    recoveredEngineGrammar,
    "A lazy engine getter must be read again when retrying its failed root.",
  );
  assert.equal(
    await engineRetry.load(manifest.roots.sass),
    engineRetained,
    "An engine failure for a new root must preserve previously successful grammars.",
  );
  const engineDocument = tokenizeDocument(
    recoveredEngineGrammar,
    manifest.roots.vue,
    '<script lang="ts">\nconst ready: boolean = true;\n</script>',
  );
  expectToken(
    engineDocument,
    1,
    "true",
    "boolean",
    /constant\.language\.boolean/,
  );

  // Deterministic budget exhaustion: neither its incomplete tokens nor its
  // partial rule stack may reach the editor or the following line.
  const calls = [];
  const partialStack = { marker: "incomplete string" };
  const completedStack = { marker: "complete line" };
  const budgetProvider = createTextMateTokensProvider("source.budget-test", {
    tokenizeLine(line, stack, budget) {
      calls.push({ line, stack, budget });
      if (calls.length === 1)
        return {
          tokens: [
            {
              startIndex: 0,
              endIndex: line.length,
              scopes: ["source.ts", "string.quoted.double.ts"],
            },
          ],
          ruleStack: partialStack,
          stoppedEarly: true,
        };
      return {
        tokens: [
          {
            startIndex: 0,
            endIndex: line.length,
            scopes: ["source.ts", "storage.type.ts"],
          },
        ],
        ruleStack: completedStack,
        stoppedEarly: false,
      };
    },
  });
  const originalState = budgetProvider.getInitialState();
  const completed = budgetProvider.tokenize("const", originalState);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].budget, 20);
  assert.equal(
    calls[1].budget,
    undefined,
    "The stoppedEarly retry must complete without another insufficient budget.",
  );
  assert.equal(calls[0].stack, originalState.stack);
  assert.equal(
    calls[1].stack,
    originalState.stack,
    "Retry must restart from the original state, not the partial string stack.",
  );
  assert.deepEqual(completed.tokens, [
    { startIndex: 0, scopes: "storageKeyword" },
  ]);
  assert.equal(completed.endState.stack, completedStack);
  budgetProvider.tokenize("let", completed.endState);
  assert.equal(
    calls[2].stack,
    completedStack,
    "The following line must receive only the completed stack.",
  );
  console.log(
    "TextMate runtime passed: pinned WASM/grammars, cold multiline and embedded scopes, roles, UTF-16, aliases/injections, coalesced roots and isolated failure retry.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
