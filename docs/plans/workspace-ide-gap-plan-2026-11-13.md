# Workspace IDE gap plan

Date: 2026-11-13
Status: plan only. Nothing here is implemented yet.
Compared against: microsoft/vscode `main` at `d49d77b` (2026-11-13), core only: `src/vs/workbench/contrib/*` and `src/vs/editor/contrib/*`.
Not compared: the extension ecosystem, the marketplace, extension hosts and extension APIs. The new Plugins page below covers what Gyro needs from that area.

## Summary

Workspace already has a solid editor shell. It has Monaco with TextMate grammars, tabs, split groups, an explorer with undo, search and replace, a strong SCM view with GitHub, a real PTY terminal, diff review, task discovery and a command palette. The gaps are in three places:

1. **Language intelligence stops halfway.** The Rust side can already ask the language server for formatting and document symbols, but no UI uses either. Code actions, signature help, inlay hints and workspace symbols are not wired at all. Only 5 language servers are hardcoded. There is none for Python or Go, although tasks for both are discovered.
2. **The build → Problems → fix loop is missing.** Problems only shows LSP diagnostics. Task output never becomes problems, so an agent or a user can't jump from a failed `cargo build` or `tsc` to the line.
3. **Debugging is a stub.** An adapter process can start, but there are no breakpoints, launch configs, call stack, variables or debug console.

For an AI-chat-first app, the order is: wire what already exists (Phase 0), close the loop between code, diagnostics and agents (Phase 1), add the Plugins page so more languages work (Phase 2), then do the heavy pieces such as a real debugger and test explorer (Phase 3).

## 1. Capability matrix

Key: ✅ present · ◐ partial · ✗ missing · — deliberately out of scope

### Editor

| Capability | Gyro | Gyro evidence | VS Code core |
|---|---|---|---|
| Tabs (preview, pinned, reorder, move between groups) | ✅ | `packages/ui/src/workbench-state.ts` (~2709-2716), `EditorGroupPane` in `packages/ui/src/surfaces.tsx:11398` | `workbench/browser/parts/editor` |
| Split editor groups | ✅ right/down only | `IdeLayoutState.splitDirection` in `packages/ui/src/types.ts` | grid layout, any direction |
| Syntax highlighting | ✅ | TextMate in `apps/desktop/src/editor/textmate-*.ts` with grammars for astro, css, html, js/ts(x), json(c), less, md, postcss, pug, sass, scss, svelte, vue; Monarch `gyro-rust` in `apps/desktop/src/monaco-editor.ts` | `editor/contrib/tokenization`, `workbench/contrib/themes` |
| Semantic tokens | ✅ | `semanticTokens/full` provider in `apps/desktop/src/editor/workspace-code-editor.tsx` | `editor/contrib/semanticTokens` |
| Find/replace in file | ✅ Monaco built-in | none custom | `editor/contrib/find` |
| Multi-cursor, column select | ✅ built-in | — | `editor/contrib/multicursor`, `codeEditor/toggleColumnSelection.ts` |
| Folding | ✅ built-in (indent-based) | no LSP `foldingRange` | `editor/contrib/folding`, `workbench/contrib/folding` |
| Go to line | ✅ built-in Ctrl+G | not in Gyro command palette | `editor/contrib/quickAccess` |
| Minimap, sticky scroll, bracket colors, guides | ✅ | `apps/desktop/src/editor-presentation.ts` `workspaceEditorOptions` | `editor/contrib/stickyScroll`, `bracketMatching` |
| Diff editor | ✅ | `apps/desktop/src/source-control-diff-editor.tsx`, `managed-diff-editor.tsx`, `DiffReviewSurface` | `editor/browser/widget/diffEditor`, `multiDiffEditor` |
| Merge editor / conflict resolution | ✗ conflicts are only detected | `apps/desktop/src-tauri/src/git/status_cache.rs` | `workbench/contrib/mergeEditor` |
| Hot exit (unsaved draft recovery) | ✅ | `apps/desktop/src/editor/edit-recovery.ts` | `workbench/services/workingCopy` |
| Auto-save, format on save | ✗ | no setting | `codeEditor/saveParticipants.ts`, `format/formatModified.ts` |
| Snippets | ✗ (Monaco only, no user snippets) | — | `workbench/contrib/snippets` |
| Emmet | ✗ | — | `workbench/contrib/emmet` |
| Markdown preview | ✗ | — | `workbench/contrib/markdown`, `webviewPanel` |
| Local history (per-file snapshots) | ✗ (path-op undo only) | `packages/ui/src/workspace-path-undo.ts` | `workbench/contrib/localHistory`, `timeline` |
| Linked editing, smart select, word ops | ✅ built-in where Monaco has it | linked editing needs LSP, not wired | `editor/contrib/linkedEditing`, `smartSelect` |

### Language intelligence (LSP)

| Capability | Gyro | Gyro evidence | VS Code core |
|---|---|---|---|
| Server lifecycle | ◐ 5 hardcoded servers, allowlisted, no install or config | `LANGUAGE_SERVER_BY_SUFFIX` and `language_server_command_is_allowed` in `apps/desktop/src-tauri/src/ide/language_server.rs`; `lsp_start/lsp_request/lsp_stop` in `apps/desktop/src/editor/language-sessions.ts` | language features come from extensions; core shows status via `workbench/contrib/languageStatus` |
| Completion | ✅ | `workspace-code-editor.tsx` | `editor/contrib/suggest` |
| Hover | ✅ | same | `editor/contrib/hover` |
| Go to definition, find references | ✅ | same; check `scripts/check-workspace-navigation-browser.mjs` | `editor/contrib/gotoSymbol`, `peekView` |
| Rename | ✅ | `apps/desktop/src/editor/use-workspace-rename.ts` | `editor/contrib/rename` |
| Diagnostics | ✅ | `publishDiagnostics` → `ide.diagnostics` (`App.tsx:13973`, `app-state.tsx:1362`) | `workbench/contrib/markers` |
| Code actions, quick fixes, lightbulb | ✗ | TS worker's codeActions turned off in `monaco-editor.ts`; no LSP replacement | `editor/contrib/codeAction`, `workbench/contrib/codeActions` |
| Signature help | ✗ | same | `editor/contrib/parameterHints` |
| Inlay hints | ✗ | same | `editor/contrib/inlayHints` |
| Format document / selection | ◐ backend only | `Formatting` request kind exists in `language_server.rs`; no UI | `editor/contrib/format`, `workbench/contrib/format` |
| Document symbols | ◐ backend only | `DocumentSymbol` request kind exists; no UI | `editor/contrib/documentSymbols` |
| Workspace symbols | ✗ | — | `search/browser/searchActionsSymbol.ts` |
| Code lens | ✗ | — | `editor/contrib/codelens` |
| Call/type hierarchy | ✗ | — | `workbench/contrib/callHierarchy`, `typeHierarchy` |
| Document highlights, links, color picker | ✗ from LSP (Monaco word highlight only) | — | `wordHighlighter`, `links`, `colorPicker` |
| Inline completions (ghost text) | ✗ | — | `editor/contrib/inlineCompletions` |
| Language status item | ◐ status bar shows counts only; server state is listed in Settings | `IdeStatusBar` `surfaces.tsx:11130` | `workbench/contrib/languageStatus` |

### Navigation and structure

| Capability | Gyro | Gyro evidence | VS Code core |
|---|---|---|---|
| Quick open files | ✅ | `CommandPaletteOverlay` `App.tsx:20047`, ranker `global-search.ts` | `search/browser/anythingQuickAccess.ts` |
| Go to symbol in file (⇧⌘O) | ✗ | — | `editor/contrib/quickAccess`, `gotoSymbol` |
| Outline view | ✗ | — | `workbench/contrib/outline` |
| Breadcrumbs | ◐ relative path only | `breadcrumbPath` in `EditorGroupPane` | `workbench/browser/parts/editor/breadcrumbs*` with symbols |
| Back/forward navigation | ✅ | editor history in App state | `workbench/services/history` |

### Workbench

| Capability | Gyro | Gyro evidence | VS Code core |
|---|---|---|---|
| Explorer | ✅ new, rename, delete, duplicate, DnD, undo/redo, watcher, multi-root | `packages/ui/src/workspace-sidebar.tsx`, `FileTree` `surfaces.tsx:11813`, `src-tauri/src/workspace/paths.rs` | `workbench/contrib/files` |
| Search across files | ◐ regex, include/exclude globs, replace with preview; no case-sensitive or whole-word toggle, no search editor | `src-tauri/src/workspace_search.rs` (rg passes only `--fixed-strings`/`--glob`) | `workbench/contrib/search` (`searchWidget.ts`), `searchEditor` |
| SCM basics | ✅ stage, unstage, discard, commit, push, pull, branches, worktrees, history list, GitHub PRs and runs | `workspace-sidebar.tsx`, `src-tauri/src/git/commands.rs` | `workbench/contrib/scm`, `git` |
| SCM gutter quick diff | ✗ | — | `scm/browser/quickDiffDecorator.ts` |
| SCM graph, blame, stash | ✗ (graph is a fixture: `scm-graph-preview.tsx`) | `history_capability.rs` uses git log for agents | `scm/browser/scmHistoryViewPane.ts` |
| Terminal | ✅ xterm and PTY, profiles, split, rename, restart, send error to chat | `live-terminal-pane.tsx`, `src-tauri/src/terminal/`, `terminal_process.rs` | `workbench/contrib/terminal`, `terminalContrib` |
| Terminal links, shell integration, command decorations | ◐ failure detection only (`terminal-failure.ts`) | — | `terminalContrib/links`, `terminalContrib/commandDetection` |
| Problems panel | ◐ LSP only; filter by severity only; drag to chat | Problems pane `surfaces.tsx:~13318`, `scripts/check-problem-drag.mjs` | `workbench/contrib/markers` (`markersView.ts`, filters, file decorations) |
| Problems in explorer and tabs (badges) | ✗ | — | `markers/browser/markersFileDecorations.ts` |
| Run tasks | ◐ discovery for node, cargo, make, just, python, go and deno; custom tasks in `.gyro/tasks.json`; groups; cancel | `src-tauri/src/ide/task_discovery.rs`, `tasks.rs` | `workbench/contrib/tasks` |
| Problem matchers (task output → Problems) | ✗ | — | `tasks/common/problemMatcher.ts`, `problemCollectors.ts` |
| Compound and dependent tasks, `.vscode/tasks.json` import | ✗ | — | `tasks/common/taskConfiguration.ts` (`dependsOn`) |
| Testing | ◐ test tasks are run as a whole; tree built from task output | `TestResultsPane` `surfaces.tsx:13428`, `flattenTestTree` | `workbench/contrib/testing` (explorer, gutter run, peek, coverage) |
| Debugging | ◐ stub: start an adapter from a typed command; continue, pause and next on thread 1; raw JSON in Output | `src-tauri/src/ide/debug.rs`, `App.tsx:5480-5620`, run view in `workspace-sidebar.tsx` | `workbench/contrib/debug` (breakpoints, call stack, variables, watch, REPL, launch.json, hover, inline values) |
| Output channels | ✅ | `OutputPane` `surfaces.tsx:13512` | `workbench/contrib/output` |
| Command palette | ◐ about 17 workspace commands plus quick open; no editor commands | `workspaceCommandRegistry` in `packages/ui/src/workspace-shell.ts` | `workbench/contrib/quickaccess`, `commands` |
| Keybindings | ◐ workspace commands only, user overrides, conflict check; no chords or when-clauses | `workspaceCommandForKeybinding`, `settings-shortcut-conflicts.tsx` | `workbench/contrib/keybindings`, `preferences/browser/keybindingsEditor.ts` |
| Settings | ◐ scopes (Across Gyro, This project, This folder); only minimap and files/search settings; no JSON view | `WorkspaceSettings` `surfaces.tsx:~10150-10560`, `packages/ui/src/workspace-settings.ts` | `preferences/browser/settingsEditor2.ts` |
| Workspace trust | ✅ restricted mode toggle | `workspaceCommandRegistry` | `workbench/contrib/workspace` |
| Browser preview | ✅ (better than VS Code core) | `browser` panel | `browserView`, `webview` |
| Agent and AI integration | ✅ core to Gyro | AI view, problem drag, `lsp_capability.rs` | `chat`, `inlineChat` |

### Deliberately out of scope

Extensions, marketplace and extension host (`extensions`); notebooks and REPL (`notebook`, `interactive`, `replNotebook`); remote and tunnels (`remote`, `remoteTunnel`); settings sync and profiles (`userDataSync`, `userDataProfile`, `editSessions`); comments API (`comments`); custom editors and webview APIs; speech; welcome and walkthroughs; issue reporter; telemetry; localization packs. Gyro's agent sessions replace `chat`, `inlineChat` and `remoteCodingAgents`.

## 2. Ranked gaps

Impact is judged for Gyro's main loop: an agent edits code, the user reviews it, something breaks, the user or the agent fixes it. Effort: S is under 2 days, M is about 1 week, L is 2 weeks or more.

| # | Gap | Impact | Effort | Why it matters here |
|---|---|---|---|---|
| 1 | Task problem matchers → Problems | High | M | Build and test errors become clickable and can be dragged to chat. Agents can read structured errors instead of scraping terminal text. |
| 2 | Code actions and quick fixes, with a "Fix with agent" action | High | M | The most-used IDE feature after completion. Gives the agent a natural place to show up in the editor. |
| 3 | Plugins page and configurable language servers | High | M–L | 5 hardcoded servers means no Python, Go, Java, C/C++, PHP or Ruby. This is the biggest coverage gap. |
| 4 | Format document, format on save, auto-save | High | S | The backend can already format. Agent edits need consistent formatting before review. |
| 5 | Outline, go to symbol in file, symbol breadcrumbs | Med-high | S | The backend can already ask for documentSymbol. All three views come from one request. |
| 6 | Merge conflict resolution | High | M–L | Agent worktrees and parallel sessions create conflicts often. Today, conflicts are only detected. |
| 7 | SCM gutter quick diff (added, changed and deleted markers) | Med-high | S–M | Shows what the agent changed while you read a file, not only in the diff view. |
| 8 | Editor commands in palette and keybindings | Med | S | Monaco actions such as comment line, move line, format and fold exist but can't be found or rebound. |
| 9 | Search: case-sensitive and whole-word toggles | Med | S | Cheap rg flags (`--case-sensitive`/`-i`, `--word-regexp`). |
| 10 | Signature help and inlay hints | Med | S each | Standard LSP requests. Monaco has the UI. |
| 11 | Problems badges on explorer and tabs | Med | S | Shows where the agent left errors. |
| 12 | Workspace symbols (`#` in quick open) | Med | S–M | Fast navigation in large repos. Also useful to agents. |
| 13 | More editor settings (font, tab size, word wrap, rulers, render whitespace) plus a JSON view | Med | S–M | Users switching from VS Code expect these. |
| 14 | Real debugger UI | Med (high for some users) | L | Breakpoints, launch config, call stack, variables, watch and debug console. A big build. Agents debug through logs and tests today. |
| 15 | Test explorer with run single test, gutter run, failure peek | Med | M–L | Today tests run per task. Per-test runs make agent fix loops tighter. |
| 16 | Local history / timeline per file | Med | M | A safety net for agent edits outside git. Partly covered by diff review undo. |
| 17 | Blame and SCM graph | Low-med | M | Useful context, but agents already read git log. |
| 18 | Terminal links and shell integration | Low-med | M | Clickable `file:line` in terminal output. |
| 19 | Keybinding chords and when-clauses | Low | M | Power-user feature. |
| 20 | Snippets, Emmet, Markdown preview, call/type hierarchy, code lens | Low | S–M each | Nice to have. Markdown preview can reuse the browser panel. |

## 3. Phases

### Phase 0: wire what already exists (about 1–2 weeks)

Small changes, because the backend or Monaco already does the work.

- **Format document and selection.** Add a Monaco `DocumentFormattingEditProvider` backed by the existing `Formatting` request kind. Add the commands `editor.formatDocument` (⇧⌥F) and format selection.
- **Format on save and auto-save.** New settings `editorFormatOnSave` (per language) and `filesAutoSave` (`off | afterDelay | onFocusChange`) in `workspace-settings.ts`. Use them in the save path.
- **Document symbols.** Add a Monaco `DocumentSymbolProvider` backed by the existing `DocumentSymbol` request. That gives Monaco's own outline-aware features. Then add:
  - an "Outline" section in the Explorer view (not a new view container);
  - a `@` mode in `CommandPaletteOverlay` ("Go to symbol in file", ⇧⌘O);
  - symbol segments after the path in `breadcrumbPath`.
- **Editor commands in palette.** Add the main Monaco actions (comment line, move/copy line, fold/unfold, change case, go to line, format) to `workspaceCommandRegistry` so the palette shows them and the keybinding settings can rebind them.
- **Search toggles.** Add `caseSensitive` and `wholeWord` to the search request. Pass `--case-sensitive`/`--ignore-case` and `--word-regexp` in `workspace_search.rs`. Add Aa and ab toggles to the search input.
- **Editor settings.** Font size, tab size, insert spaces, word wrap, rulers and render whitespace, next to the minimap setting.

### Phase 1: close the edit → diagnose → fix loop (about 3–4 weeks)

- **Problem matchers.** Built-in matchers for `tsc`, `eslint` (stylish and unix), `cargo`/`rustc`, `go build`, `pytest`, `jest`/`vitest` and gcc/clang. They cover the task types that `task_discovery.rs` already finds. Each discovered task gets a default matcher, and custom tasks can set `problemMatcher` in `.gyro/tasks.json`.
  - Parse output in Rust, in the task runner, as output streams.
  - Emit diagnostics with `source: "task:<id>"` into the same `ide.diagnostics` store. Clear them when the task is run again.
  - Problems gets a source filter (LSP or task).
  - Add a capability descriptor so agents can read task problems.
- **Code actions.** Add a `CodeActionProvider` backed by a new `CodeAction` request kind and `codeAction/resolve`. Apply `WorkspaceEdit` through `workspace-edits.ts`, and run `workspace/executeCommand`.
  - In the lightbulb menu and the Problems row, add **"Fix with agent"**. It sends the diagnostic, the code range and the available quick fixes to the session that owns the file, or to a new session. This reuses the `check-problem-drag` payload.
- **Signature help and inlay hints.** New request kinds `SignatureHelp` and `InlayHint`, and Monaco providers for them. Turn inlay hints on with a setting, default off.
- **SCM quick diff.** Compute line changes against HEAD (or the index) in the editor and show gutter decorations. Clicking one opens Monaco's inline diff peek, with revert and stage for that hunk.
- **Problems badges.** Error and warning counts on explorer nodes and tabs, using the same data as the status bar.
- **Merge conflicts, v1.**
  - Inline conflict markers with CodeLens-style actions: accept current, accept incoming, accept both, compare.
  - "Resolve with agent" for each file.
  - A conflict list in SCM.
  - A three-pane merge editor is Phase 3.

### Phase 2: Plugins page and wider language coverage (about 3–4 weeks)

See section 4. In short:

- Replace the hardcoded server table with a registry made of a curated catalog plus user overrides.
- Add Python (pyright or basedpyright), Go (gopls), C/C++ (clangd), Java (jdtls), PHP, Ruby, YAML, TOML, Markdown, Bash and Docker language servers to the catalog.
- Add formatters and linters (prettier, biome, ruff, black, rustfmt, gofmt, eslint) as a plugin kind. The formatter becomes the source for Phase 0's format on save when there is no server formatter.
- Add language packs (grammar, language configuration and snippets) so syntax highlighting covers the languages above.
- Workspace symbols and a language status item in the status bar, which opens the plugin's entry.

### Phase 3: heavy features (6 weeks or more, pick by demand)

- **Debugger v1**, built on `debug.rs` and debug adapter plugins:
  - `launch` configs in `.gyro/launch.json`, with import from `.vscode/launch.json`;
  - gutter breakpoints, including conditional breakpoints and logpoints;
  - Run view sections: call stack, variables, watch and breakpoints;
  - a debug console REPL and a debug toolbar;
  - hover evaluation and inline values;
  - "Explain this state" sends the stack and variables to the agent.
- **Test explorer.** Use per-test results from the matcher and JSON reporters (cargo, jest/vitest, pytest, go test). Add a gutter run/debug button per test, failure peek and re-run failed tests.
- **Three-pane merge editor**, using Monaco's diff pieces. This follows the model of `workbench/contrib/mergeEditor`.
- **Local history** snapshots on save and before each agent edit, shown in a per-file timeline.
- Blame and graph in SCM. Terminal links and shell integration. Keybinding chords and when-clauses. Settings JSON view.

## 4. Plugins page (code support, not a marketplace)

### Goals

- One place to see and control everything that gives a language "smarts": language servers, formatters, linters, language packs and debug adapters.
- No browsing, ratings, publishers or remote code. Gyro ships a **curated catalog** of known tools. The user can also point at a local binary or import a local manifest (the existing `IdeContribution` flow).
- Keep the current promise: "Gyro does not auto-install external tools." Installing is always a visible step the user approves, such as running a command in the terminal or asking an agent.

### Where it lives

- **Home: Settings → Workspace → Plugins.** This renames and grows the existing "Tools" section (`tools-contributions`, `surfaces.tsx:1183/1307/19046`). It already has the "Language services" list and the "Local contributions" import. It already respects scopes (Across Gyro, This project, This folder), so enablement scope comes free.
- **Entry points from Workspace.** These are not a new activity bar view; Workspace already has 6 view containers, and plugins are set up once and rarely changed.
  - A status bar language item, as in VS Code's `languageStatus`: `{ } TypeScript ●`. Click it for a popover with server state, formatter, linter, Restart, Show output and "Manage in Plugins".
  - An editor banner when a file has no server: "No language server for Python. Set up pyright?". It offers **Set up**, **Ask agent** and **Dismiss for .py**.
  - Command palette: `Plugins: Show`, `Plugins: Restart language server`, `Format document with…`, `Plugins: Detect installed tools`.
  - In the Problems empty state, a link to the plugin when no linter is set up.

### What it lists

Group the list into tabs or filter chips: **All · Language servers · Formatters · Linters · Language packs · Debug adapters**. There is a search box and an "Only for this project's languages" filter, on by default. That filter uses the file types found in the workspace roots.

Each row shows:

| Field | Example |
|---|---|
| Name and kind | `rust-analyzer` · Language server |
| Languages and file patterns | Rust · `*.rs` |
| Source | Built-in catalog · Detected on PATH · Local manifest · Custom |
| Status | Running · Ready · Not installed · Error (with message) · Disabled · Blocked in restricted mode |
| Version and path | `1.82.0 · /Users/…/.cargo/bin/rust-analyzer` |
| Toggle | an enable switch, with a scope picker (Across Gyro or This project) |
| Actions | Set up… · Restart · Show output · Configure · Remove (custom or local only) |

Kinds and what "enabled" means for each:

- **Language server.** Starts on the first file that matches. It supplies completion, hover, diagnostics, formatting, symbols and code actions, depending on its capabilities, which are shown as chips on the detail page.
- **Formatter.** Can be picked as the default formatter per language: Prettier for TS/JS/CSS/JSON/MD, Biome, ruff format or black, rustfmt, gofmt, clang-format. It runs as a process on a buffer or file. Per language, the "Default formatter" is either Language server or one formatter plugin.
- **Linter.** Runs on save or on type (it has a setting) and publishes diagnostics with its own `source`: eslint, ruff, clippy (via cargo task matcher), golangci-lint, shellcheck. Where a linter has a language server mode (eslint, ruff server), prefer that and list it as one item.
- **Language pack.** A grammar, a language configuration (comments, brackets, auto-closing) and snippets. The current bundled grammars show here as built-in packs that are always on and can't be removed. Local packs come from a manifest.
- **Debug adapter.** lldb-dap (Rust, C, C++), debugpy (Python), js-debug (Node), delve `dlv dap` (Go). Enabled adapters show up as types in launch config and replace the free-text adapter field in Run and Test.

### Detail page (click a row)

- What it does, which languages it covers, its capabilities and the exact command line it runs.
- **Setup.** Detects the tool with `which` and `--version`. If it is missing, Setup shows the install commands for this OS, such as `npm i -g pyright`, `brew install llvm`, `rustup component add rust-analyzer` or `go install golang.org/x/tools/gopls@latest`. The choices are:
  1. **Run in terminal.** Opens a Workspace terminal with the command filled in but not run.
  2. **Ask agent.** Starts a session with a setup brief.
  3. **Copy.**
  4. **Use existing binary…**, a file picker.

  After install, Gyro checks again on its own.
- **Configure.**
  - A command path override and extra args.
  - Server `initializationOptions` and `workspace/configuration` settings as JSON, with a small form for common keys such as pyright `typeCheckingMode` and rust-analyzer `check.command`.
  - Environment variables.
  - Format and lint triggers.
- **Output.** A link to the plugin's output channel (the `lsp` and `debug` kinds already exist in `OutputChannel`).

### How toggles behave

- Turning a plugin **on** in a scope saves it. Language servers start lazily on the next matching file. If a matching file is open, the server starts right away.
- Turning it **off** stops a running server (`lsp_stop`), clears its diagnostics and moves the affected languages to the next plugin that is enabled. If there is none, Monaco's basic features remain.
- **Project scope wins over Across Gyro.** A project can turn off a server that is on everywhere else.
- **Restricted mode.** Plugins whose command or config comes from the project (for example a project `.gyro/plugins.json` naming `./node_modules/.bin/…`) show "Blocked in restricted mode" until the workspace is trusted. Built-in catalog entries that resolve to PATH binaries are allowed.
- **First run of a new command line.** Gyro shows the exact command once and needs one confirmation. This is the allowlist (`language_server_command_is_allowed`) turned into something the user can see and approve.
- **Conflicts.** If two enabled plugins claim the same role for a language, such as two formatters, the row shows a warning and asks the user to pick a default.

### Data model

- New type in `packages/ui/src/types.ts`:
  ```ts
  type CodeSupportPluginKind = "language-server" | "formatter" | "linter" | "language-pack" | "debug-adapter";
  interface CodeSupportPlugin {
    id: string; label: string; kind: CodeSupportPluginKind;
    languages: string[]; filePatterns: string[];
    command?: { program: string; args: string[] }; detect?: { program: string; versionArgs: string[] };
    install?: Partial<Record<"macos" | "linux" | "windows", string[]>>;
    source: "catalog" | "detected" | "local" | "custom";
    capabilities?: string[];
  }
  interface CodeSupportPluginState { pluginId: string; status: LanguageServerState["status"] | "disabled" | "blocked"; version?: string; resolvedPath?: string; message?: string; }
  ```
- Settings, per scope, in `workspace-settings.ts`:
  - `codeSupport.plugins[id] = { enabled, commandOverride?, args?, env?, settings? }`
  - `codeSupport.defaultFormatter[languageId]`
  - `codeSupport.formatOnSave[languageId]`
  - `codeSupport.lintOn: "save" | "type"`
- `LanguageServerState` stays as the runtime state of a running server and gains `pluginId`.
- `IdeContribution` with `permissions` `"languages"` or `"debug"` becomes a `source: "local"` plugin. Local manifests keep working.
- **Catalog source.** Ship a bundled `code-support-catalog.json` so the app works offline. It can later be refreshed from the same remote catalog pipeline the model catalog uses (`catalog/` in gyro-website), but only for data: names, commands and install hints. Never code.

### Backend changes

- Replace `LANGUAGE_SERVER_BY_SUFFIX` in `ide/language_server.rs` with a registry built from the catalog and the user's settings. `lsp_start` resolves the server from the file path and the enabled plugins.
- The allowlist becomes "commands from enabled plugins that the user confirmed".
- New commands:
  - `code_support_detect` (probe PATH and versions, cached);
  - `code_support_list` (catalog merged with state);
  - `formatter_run` (stdin → stdout, with a timeout);
  - `linter_run`, or linters as LSP when they support it.
- `debug.rs` takes the adapter command from the enabled debug adapter plugin instead of free text.
- `lsp_capability.rs` reports to agents which plugins are enabled and available, so an agent can say "pyright isn't installed" and offer to set it up.

## 5. Key files to touch

| Area | Files |
|---|---|
| Editor providers (format, symbols, code actions, signature help, inlay hints) | `apps/desktop/src/editor/workspace-code-editor.tsx`, `apps/desktop/src/editor/language-sessions.ts`, `apps/desktop/src/editor/workspace-edits.ts`, `apps/desktop/src/monaco-editor.ts` |
| LSP request kinds and server registry | `apps/desktop/src-tauri/src/ide/language_server.rs`, `apps/desktop/src-tauri/src/ide/types.rs`, `apps/desktop/src-tauri/src/lsp_capability.rs` |
| Editor options and settings | `apps/desktop/src/editor-presentation.ts`, `packages/ui/src/workspace-settings.ts`, `WorkspaceSettings` in `packages/ui/src/surfaces.tsx` (~10150-10560) |
| Commands, palette, keybindings | `packages/ui/src/workspace-shell.ts`, `CommandPaletteOverlay` in `apps/desktop/src/App.tsx` (~20047), `apps/desktop/src/global-search.ts`, `settings-shortcut-conflicts.tsx` |
| Outline and breadcrumbs | `packages/ui/src/workspace-sidebar.tsx` (Explorer), `EditorGroupPane` in `packages/ui/src/surfaces.tsx` (~11398) |
| Search toggles | `apps/desktop/src-tauri/src/workspace_search.rs`, search view in `packages/ui/src/workspace-sidebar.tsx` |
| Problem matchers | `apps/desktop/src-tauri/src/ide/tasks.rs`, `apps/desktop/src-tauri/src/ide/task_discovery.rs`, diagnostics store in `apps/desktop/src/app-state.tsx` (~1362), Problems pane in `surfaces.tsx` (~13318) |
| SCM quick diff and conflicts | `apps/desktop/src-tauri/src/git/commands.rs`, `git/status_cache.rs`, `workspace-code-editor.tsx` decorations, SCM view in `workspace-sidebar.tsx` |
| Plugins page | settings sections in `packages/ui/src/surfaces.tsx` (`tools-contributions`, 1183/1307/19046), `IdeStatusBar` (11130), `packages/ui/src/types.ts` (`IdeContribution`, `LanguageServerState`, new `CodeSupportPlugin`), `packages/ui/src/workbench-state.ts` (`defaultIdeContributions`), new `apps/desktop/src-tauri/src/ide/code_support.rs`, new bundled `code-support-catalog.json` |
| Language packs | `apps/desktop/src/editor/textmate-*.ts`, `apps/desktop/src/editor/custom-grammars.ts`, `textmate/grammars/` |
| Debugger | `apps/desktop/src-tauri/src/ide/debug.rs`, debug handlers in `App.tsx` (~5480-5620), Run and Test view in `workspace-sidebar.tsx` |
| Tests | `TestResultsPane` in `surfaces.tsx` (~13428), `ide/tests.rs` |

New or extended checks, following the existing `scripts/check-*.mjs` pattern:

- `check-workspace-navigation-browser.mjs`: extend with mocked format, documentSymbol, codeAction and signatureHelp.
- `check-run-tasks.mjs`: add matcher fixtures for tsc, cargo and pytest output.
- `check-workspace-search.mjs`: case and whole-word.
- New `check-code-support-plugins.mjs` for catalog merge, scope precedence, restricted-mode blocking, the first-run confirmation and server fallback on disable.
- `check-problem-drag.mjs`: task-source problems.

## Open questions for product

1. Should "Fix with agent" go to the session that last edited the file, or always open a new one?
2. Should the plugin catalog be refreshable from the remote catalog in v1, or bundled only?
3. Debugger scope: build Phase 3 v1 for Rust, Node and Python only, or wait for user demand?
4. Should the Plugins page also be reachable as its own Workspace view for heavy IDE users, or stay in Settings only, as this plan proposes?
