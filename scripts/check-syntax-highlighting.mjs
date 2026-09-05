import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "gyro-syntax-tests-"));
try {
  const entry = join(temporary, "entry.ts");
  const modules = [
    "packages/ui/src/editor/languages/registry.ts",
    "apps/desktop/src/editor/syntax-loader.ts",
    "apps/desktop/src/editor/semantic-tokens.ts",
    "apps/desktop/src/editor/monaco-theme.ts",
    "apps/desktop/src/editor/custom-grammars.ts",
  ];
  await writeFile(
    entry,
    modules
      .map((path) => `export * from ${JSON.stringify(join(root, path))};`)
      .join("\n"),
  );
  const output = join(temporary, "tests.mjs");
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    loader: { ".png": "dataurl" },
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    resolveLanguage,
    searchLanguages,
    editorFilePolicy,
    languages,
    createSyntaxLoader,
    decodeSemanticTokens,
    semanticLegend,
    createMonacoTheme,
    customGrammars,
  } = await import(pathToFileURL(output));
  const cases = {
    "index.ts": "typescript",
    "Component.tsx": "typescriptreact",
    "script.js": "javascript",
    "server.mjs": "javascript",
    "style.css": "css",
    "style.module.scss": "scss",
    Dockerfile: "dockerfile",
    "Dockerfile.prod": "dockerfile",
    ".env": "dotenv",
    ".env.production": "dotenv",
    "package.json": "json",
    "tsconfig.json": "jsonc",
    "tsconfig.build.json": "jsonc",
    "pnpm-lock.yaml": "yaml",
    "Cargo.toml": "toml",
    "Cargo.lock": "toml",
    Makefile: "makefile",
    "CMakeLists.txt": "cmake",
    "README.md": "markdown",
    README: "markdown",
    "app.py": "python",
    "main.rs": "rust",
    "main.go": "go",
    "Program.cs": "csharp",
    "Main.java": "java",
    "Main.kt": "kotlin",
    "query.sql": "sql",
    "schema.graphql": "graphql",
    "schema.prisma": "prisma",
    "contract.sol": "solidity",
    "shader.wgsl": "wgsl",
    "script.ps1": "powershell",
    "script.sh": "shell",
    "unknown.randomthing": "plaintext",
    "foo.blade.php": "blade",
    "types.d.ts": "typescript",
    "types.d.mts": "typescript",
    "button.module.css": "css",
    "button.module.scss": "scss",
    "component.spec.tsx": "typescriptreact",
    "component.test.tsx": "typescriptreact",
    "Dockerfile.dev": "dockerfile",
    "Dockerfile.production": "dockerfile",
    ".env.local": "dotenv",
    ".env.example": "dotenv",
    ".github/workflows/build.yml": "yaml",
    ".circleci/config.yml": "yaml",
    "C:\\work\\FILE.TSX": "typescriptreact",
    "go.mod": "gomod",
    ".gitignore": "gitignore",
    "image.png": "image",
    "archive.tar.gz": "archive",
  };
  for (const [path, expected] of Object.entries(cases))
    assert.equal(resolveLanguage({ path }).id, expected, path);
  assert.equal(
    resolveLanguage({
      path: "script",
      content: "#!/usr/bin/env -S python3 -u\nprint('hello')",
    }).id,
    "python",
  );
  assert.equal(
    resolveLanguage({ path: "script", firstLine: "#!/bin/bash" }).id,
    "shell",
  );
  assert.equal(
    resolveLanguage({ path: "foo.txt", content: "#!/bin/python" }).id,
    "plaintext",
  );
  assert.equal(
    resolveLanguage({ path: "foo.ts", override: "python" }).id,
    "python",
  );
  assert.equal(
    resolveLanguage({ path: "foo.ts", override: "plaintext" }).id,
    "plaintext",
  );
  assert.equal(
    resolveLanguage({ path: "foo.ts", override: "missing" }).id,
    "typescript",
  );
  assert.equal(
    resolveLanguage({
      path: "foo.h",
      content: "namespace Example { class Type {}; }",
    }).id,
    "cpp",
  );
  assert.equal(resolveLanguage({ path: "foo.h" }).id, "c");
  assert.equal(
    resolveLanguage({ path: "unknown", content: '{"a":true}' }).id,
    "json",
  );
  assert.equal(
    resolveLanguage({
      path: "unknown",
      content: "ordinary words with function and class",
    }).id,
    "plaintext",
  );
  assert(
    searchLanguages("tsx").some(
      (language) => language.id === "typescriptreact",
    ),
  );
  assert(searchLanguages(".py").some((language) => language.id === "python"));
  assert.equal(
    new Set(languages.map((language) => language.id)).size,
    languages.length,
  );
  for (const language of languages)
    if (
      language.syntax.type === "monaco" &&
      language.syntax.language !== "json"
    ) {
      const id = language.syntax.language;
      assert(
        existsSync(
          join(
            root,
            "apps/desktop/node_modules/monaco-editor/esm/vs/basic-languages",
            id,
            `${id}.js`,
          ),
        ),
        `${language.id}: bundled grammar missing`,
      );
    }
  for (const language of languages)
    if (language.syntax.type === "custom")
      assert(
        customGrammars[language.syntax.language],
        `${language.id} grammar missing`,
      );
  assert(editorFilePolicy("file.ts", "a\0b").binary);
  assert(editorFilePolicy("file.png", "hello").binary);
  assert(editorFilePolicy("file.ts", "small", 3000000, true).readOnly);
  assert(editorFilePolicy("bundle.js", "x".repeat(25000)).limited);
  assert(editorFilePolicy("Cargo.lock", "small", 600000).limited);
  assert(!editorFilePolicy("file.ts", "const answer = 42").limited);
  let calls = 0;
  const load = createSyntaxLoader({
    monaco: async () => {
      calls++;
      return "typescript";
    },
  });
  const definition = resolveLanguage({ path: "x.ts" });
  const [a, b] = await Promise.all([load(definition), load(definition)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.available, true);
  assert.equal(
    (await createSyntaxLoader({})(definition)).language,
    "plaintext",
  );
  assert.equal(
    (
      await createSyntaxLoader({
        monaco: async () => {
          throw Error("broken grammar");
        },
      })(definition)
    ).available,
    false,
  );
  const legend = {
    tokenTypes: ["function", "variable"],
    tokenModifiers: ["readonly"],
  };
  const decoded = decodeSemanticTokens(
    { data: [0, 0, 3, 0, 0, 0, 4, 2, 1, 1] },
    legend,
    [10],
  );
  assert(decoded);
  assert.equal(decoded[3], semanticLegend.tokenTypes.indexOf("function"));
  assert.equal(decoded[8], semanticLegend.tokenTypes.indexOf("constant"));
  for (const data of [
    [0],
    [0, 0, 99, 0, 0],
    [0, 0, 1, 9, 0],
    [0, 0, 1, 0, 8],
    [-1, 0, 1, 0, 0],
    [0, 0, NaN, 0, 0],
    [0, 0, 2, 0, 0, 0, 1, 2, 0, 0],
  ])
    assert.equal(decodeSemanticTokens({ data }, legend, [10]), undefined);
  const dark = createMonacoTheme("dark"),
    light = createMonacoTheme("light");
  for (const token of [
    "comment",
    "keyword",
    "string",
    "function",
    "jsonKey",
    "invalid",
  ])
    assert.notEqual(
      dark.rules.find((rule) => rule.token === token)?.foreground,
      light.rules.find((rule) => rule.token === token)?.foreground,
    );
  for (const color of [
    "editor.background",
    "editor.selectionBackground",
    "editorBracketHighlight.foreground1",
  ])
    assert.notEqual(dark.colors[color], light.colors[color]);
  for (const theme of [dark, light])
    for (const rule of theme.rules)
      assert.match(rule.foreground, /^[\da-f]{6}$/i);
  console.log(
    `Syntax checks passed: ${Object.keys(cases).length} filename cases; overrides, ambiguity, shebangs, safety, providers, semantic validation, and themes (${languages.length} registered types).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
