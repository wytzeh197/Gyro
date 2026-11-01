# Bundled TextMate grammars

These files support the Vue, Svelte, Astro and indented Sass entries in `packages/ui/src/editor/languages/definitions.ts`. Runtime loading uses local JSON assets and the bundled Oniguruma runtime. Opening a file requires no external grammar download or extension execution.

`manifest.json` records the root language scopes, every bundled scope and injection, scope aliases, embedded-language metadata, exact upstream commits, original and bundled SHA-256 hashes, and applicable license files. Direct JSON copies are unchanged. The original YAML/CSON data for the three converted grammars remains in `sources/`.

Every Vite production build copies all local license and notice files, this README, and the pinned manifest without changing their bytes into `dist/third-party/textmate/`. The license files are available under `third-party/textmate/licenses/` in the embedded desktop assets. Grammar JSON and Oniguruma WASM remain in the build's hashed `assets/` files; the manifest records their source names and hashes. This packaging runs only during a build and does not add runtime loading or duplicate source assets.

| Source                                                                                                                                               | Bundled material                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Vue Official](https://github.com/vuejs/language-tools/tree/f2d92d3f1cb5513268fff358993f163e78d4821a/extensions/vscode/syntaxes)                     | Vue root, directives, interpolation, script-operator and style-variable injections                              |
| [Svelte Language Tools](https://github.com/sveltejs/language-tools/tree/af7c6a505a8aa631f5ca7794f41163e46cb0bc33/packages/svelte-vscode/syntaxes)    | Svelte root, PostCSS and Pug injections                                                                         |
| [Astro's current monorepo](https://github.com/withastro/astro/tree/9050e3819c51b0383cced278c278bc6f45c63468/packages/language-tools/vscode/syntaxes) | Astro root                                                                                                      |
| [Microsoft VS Code](https://github.com/microsoft/vscode/tree/e3c2316227ee9a4b24449b779409e3ff4d0126a9/extensions)                                    | Embedded HTML, CSS, SCSS, SassDoc, Less, JavaScript, JSX, TypeScript, TSX, JSDoc, JSON, JSONC, Markdown and Pug |
| [Atom's Sass package](https://github.com/atom/language-sass/tree/0f7fb5de95073f46c7b9662c873336ee1bb38f50)                                           | Indented Sass grammar; archived upstream, with both GitHub and original Alex Sancho MIT notices                 |

Svelte and PostCSS JSON were generated with `js-yaml@4.1.0` using `load`, then `JSON.stringify(data, null, 2)` plus a newline. Sass JSON was generated with `cson-parser@4.0.9` using `parse` and the same serialization. Conversion tools were installed in an isolated temporary directory; they are not production dependencies. No patterns were edited during conversion.

`requiredScopes` defines the bundled host/script/style dependency set. `optionalMissingScopes` records unsupported branches retained in the upstream grammars, such as CoffeeScript, Stylus, YAML, GraphQL and Markdown fences for additional languages. The loader returns `null` for those optional scopes. This set is deliberately explicit; adding a new required include must not silently turn it into plain text. General Monaco language support remains independent of this embedded-language set.

`source.html`, `source.less` and `source.postcss` are compatibility aliases for bundled canonical scopes. The runtime must clone the raw grammar's `scopeName` when loading an alias, so the TextMate registry caches it under the requested name. Injection targets and embedded-language metadata are copied from the upstream extension declarations.

Run `node scripts/check-textmate-assets.mjs` to validate asset hashes, pins, licenses, alias/injection targets, every resolved external repository fragment, and the exact optional dependency set. Runtime tokenization tests provide the separate behavioral check for multiline and embedded-language highlighting.
