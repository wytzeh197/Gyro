# Workspace syntax highlighting

Gyro uses one language registry for editor and diff detection, the language picker, file icon categories, and language-server selection. Detection is independent of tokenizer availability.

The registry currently describes 174 file types: 78 use bundled Monaco providers, 19 use local custom grammars, 67 reserve a TextMate provider, and 10 are plain-text or binary categories. This is a detection count, not a promise of 174 installed grammars. Unavailable grammars keep the detected language label and show a plain-text fallback notice. No grammars are downloaded automatically.

## Detection and overrides

`packages/ui/src/editor/languages/definitions.ts` holds metadata. `registry.ts` resolves manual overrides, exact filenames, filename/path patterns, longest compound suffix, ordinary extension, shebang, MIME hint, and bounded content signatures, in that order. Ambiguous extensions use conservative content hints with deterministic defaults. Filename matching is case-insensitive. Content sniffing inspects at most 8 KiB; shebang matching uses at most 512 characters.

The status-bar language button searches names, aliases, extensions, and filenames. Auto Detect clears the override. Overrides belong to the file path for this app session, are shared by its working-file and diff views, and never rename the file.

## Providers and themes

`apps/desktop/src/editor/syntax-loader.ts` deduplicates asynchronous loads and catches provider failures. `monaco-syntax.ts` uses explicit lazy imports from the installed Monaco package and lazy local grammars. TextMate is an adapter boundary for future locally installed grammars; it is not currently a TextMate runtime. An adapter should be registered before opening files.

Common languages use Monaco's actual grammars. Local grammars cover TOML, dotenv, JSONC/JSONL, delimited data, Makefile, CMake, Prisma, requirements, Yarn locks, Go modules, Git files, and patches. Embedded language support follows the installed provider; it is not equivalent to the full VS Code extension ecosystem.

`packages/ui/src/editor/themes` owns normalized syntax roles, aliases, palettes, and editor surface colors. The Monaco adapter generates both dark and light themes, including bracket colors. Theme and language changes keep the same editor model.

The editor's language-server bridge advertises semantic-token support and exposes the server's negotiated legend. Semantic colors enhance syntax when a ready server supports full tokens. Payloads are bounded and validated for integer values, token types, modifiers, document bounds, and overlap. Cancelled and stale-version responses are ignored. Diff documents use syntax coloring only because their historical contents are not live language-server documents.

## File safety

Binary files are not presented as editable text. Native reads reject malformed UTF-8; a truncated preview may omit an incomplete final codepoint. Files above 512 KiB or with a very long line use plain text and disable expensive editor features. Existing native read limits remain in place. Truncated previews are read-only and the save action rejects them, protecting the complete file on disk. Diff computation has a time limit.

## Verification

Run `node scripts/check-syntax-highlighting.mjs` for registry cases, override precedence, ambiguity, provider deduplication/failure, safety policy, semantic payload validation, and generated themes. The test is included in `pnpm test:reliability`.

Native UTF-8 tests: `cargo test -p gyro-desktop workspace_utf8_tests --lib`.

UI verification should cover a normal file and a side-by-side diff, language search, Plain Text, Auto Detect, fallback notices, and both themes in the current checkout app.
