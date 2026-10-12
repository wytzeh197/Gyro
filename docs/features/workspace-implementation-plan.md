# Workspace implementation plan

Make Workspace dependable for everyday coding by completing cross-file navigation and rename, syntax highlighting, formatting, quick fixes, and search. These five priorities form the first delivery wave. Debugging, individual test integration, and extension infrastructure follow after the editor workflows work end to end.

Planning baseline: October 11, 2026, local source version `0.1.0-alpha.49.7`. This sequence deepens Workspace; distribution and provider-readiness gates in the [release roadmap](../roadmap.md) remain separate.

Implementation started October 11, 2026. Priority 1 now has host cross-file definition/reference navigation, shared canonical models, location history, all-buffer language-server synchronization, and a guarded multi-file rename workflow with preview, undo, Save All, and background-draft recovery. See the [navigation/rename QA and remaining acceptance limits](../design/workspace-navigation-and-rename/design-qa.md). Priority 2 now bundles Vue, Svelte, Astro, and indented Sass highlighting with multiline and embedded-language state, shared theme roles, and retryable loading. See the [syntax QA](../design/workspace-syntax-highlighting/design-qa.md). Format Document and Format Selection are next; quick fixes and search remain planned.

The first rename slice stays within one owning workspace root and language-server family. Cross-root and cross-server transactions are rejected until the source server can share every target's live document snapshot. Navigation and independent rename workflows remain available in each root. Packaged-app acceptance is still required before release.

## Delivery order

P0 means the first Workspace delivery wave. P1 extends the daily coding loop. P2 adds larger development platforms. Effort describes relative scope, not a calendar commitment.

| Order | Priority | Deliverable                                                | Dependency                                                              | Effort          |
| ----- | -------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| 1     | P0       | Cross-file navigation and reliable symbol rename           | Canonical documents, LSP synchronization, shared text-edit transactions | Large           |
| 2     | P0       | Working highlighting for important missing languages       | Bundled grammar/runtime validation                                      | Medium          |
| 3     | P0       | Format Document and Format Selection                       | Shared edits and server capability routing                              | Medium          |
| 4     | P0       | Quick fixes and organize imports                           | Shared edits, complete diagnostics, server-request handling             | Large           |
| 5     | P0       | Search controls, accurate results, and replacement preview | Search controls can start independently; replacement uses shared edits  | Medium to large |
| 6     | P1       | Symbol navigation, save/recovery, editor settings          | First delivery wave                                                     | Medium          |
| 7     | P1       | Additional language tooling and Git review depth           | Stable provider and edit contracts                                      | Large           |
| 8     | P2       | Complete debugging and individual test workflows           | Stable editor navigation and diagnostics                                | Large           |
| 9     | P2       | Extensions, remote workspaces, specialized editors         | Explicit product and architecture decisions                             | Very large      |

Start the grammar integration and search-control work alongside priority 1. Formatting, quick fixes, and replacement must reuse the edit service introduced for rename. Deliver vertical slices through the real Workspace instead of a broad workbench rewrite.

## Cross file navigation and rename

**User outcome:** Go to Definition opens the right file and location, including a file that has never been opened. Rename updates a symbol across files while preserving unsaved changes.

At the planning baseline, definition/reference requests already returned locations, but consistent document identity, host navigation, and project-wide edit application were missing. The editor used path-based Monaco URIs while LSP locations used `file://` URIs. The rename converter accepted only `changes` and dropped versioned `documentChanges`. The first implementation addresses those gaps.

### Shared document foundation

1. Extract focused editor modules from `App.tsx`. Introduce a document registry with canonical URI, validated absolute path, owning workspace root, model, document version, disk hash, dirty state, and view state. Use one model for a file shown in multiple panes.
2. Register semantic providers once per language and route each request by model URI. Choose one semantic provider owner per language so bundled Monaco workers and managed servers do not return competing definitions, completions, or renames. Expose initialized server capabilities to the renderer and invalidate them on restart so commands can be gated correctly.
3. Synchronize every loaded document, including inactive dirty buffers. Use monotonic versions, flush pending changes before requests, and discard stale or cancelled responses. Negotiate position encoding and convert consistently; keep UTF-16 as the initial supported encoding.
4. Resolve snapshot ownership in the shared language-server pool. Editor queries must use live editor text; model-facing requests must not overwrite it with disk text. Make editor-snapshot queries explicit, or isolate disk-only semantic queries in another server session.
5. Preserve root boundaries and existing workspace-trust rules. Navigation outside authorized roots must present an explicit unavailable state. Resolve encoded paths and symlinks through the existing backend path validation.

### Navigation slice

Connect Monaco's editor opener to the existing host location opener. Normalize `Location` and `LocationLink`, load unopened targets, reveal the selection, and preserve existing dirty content. Add back/forward location history and reference-result navigation. Keep indexing, unavailable server, no results, and request failure distinct.

**Acceptance:** F12 and Cmd-click open unopened targets; references navigate across files; back returns to the previous cursor and scroll position. Spaces, percent signs, non-ASCII paths, multiple roots, and a dirty destination all work. Closing one split pane does not dispose the shared document.

### Edit service and rename slice

Build one text-edit service with prepare, preview, apply, and undo operations. It must normalize both `WorkspaceEdit.changes` and ordered text edits in `documentChanges`, preserve document versions, validate ranges and overlap rules, and validate every target before applying any change. Follow the [LSP WorkspaceEdit contract](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/types/workspaceEdit.md).

Use current dirty buffers as the source of truth and load unopened files into background buffers without changing focus. Apply the validated set as one user-visible transaction, retaining inverse edits or snapshots to restore already-applied buffers if application fails. Keep edits unsaved, show every changed file, and provide Save All using existing per-file hash guards. A save failure must identify exactly which files were saved and which remain dirty; it must never be described as an atomic disk commit. Transaction undo must refuse to overwrite subsequent unrelated edits.

Include minimal restart recovery in this slice. Current UI recovery skips dirty buffers without tabs and imposes count/content limits, so background transaction documents need recovery storage independent of tab visibility. Persist their working state in a bounded local transaction journal until they are saved or discarded, validate recovery capacity before accepting a batch, and expose pending changes on reopen and quit. Never accept a transaction whose unsaved documents would be silently omitted from recovery.

Add `prepareRename` where supported, a keyboard-accessible rename input, multi-file preview, cancellation, and a changed-files summary. Advertise only implemented edit capabilities. In the first slice, reject an entire edit containing create/rename/delete resource operations with an explanation; never silently apply only its text subset. Add resource operations later when a supported workflow needs them, with recovery handling for disk mutations.

**Acceptance:** Rename changes open, dirty, and unopened files; undo restores all affected buffers. A stale version, changed disk hash, invalid target, or malformed edit leaves the prepared transaction unapplied. Injected failure during application restores prior buffers or reports an explicit recoverable failure. An unsupported resource operation produces a clear failure. Restart after an unsaved rename restores every affected document, including unopened targets; exceeding recovery capacity prevents application with a clear explanation. Save All does not lose dirty text, and partial save failure remains recoverable.

## Syntax highlighting

**User outcome:** Common project files retain useful highlighting offline and while a language server is starting or unavailable.

At the planning baseline, the language registry declared TextMate grammars without an installed adapter, and the loader retained failed promises. The first implementation slice now installs a lazy adapter, exact runtime dependencies, licensed local grammar assets, and failure eviction. Completed line states, UTF-16 offsets, root-level retry isolation, and embedded script/style boundaries have behavioral guards. Zig and LaTeX remain follow-up work.

1. Validate a locally bundled TextMate tokenizer in the packaged Tauri WebKit app, including WASM loading and CSP. The proposed runtime is [vscode-textmate](https://github.com/microsoft/vscode-textmate) with [vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma). Pin compatible versions and bundle grammar assets with their licenses.
2. Start with Vue, Svelte, Astro, and Sass. Reuse existing Monaco/custom grammars for languages already working. Add Zig and LaTeX in a follow-up after the first grammar set passes.
3. Load each grammar once, preserve multiline tokenizer state, and map grammar scopes to existing Gyro syntax roles. Validate embedded script/style sections rather than assuming grammar availability proves correct highlighting.
4. Keep lexical colors available when semantic tokens are absent. Bind semantic results to document versions and preserve the current large/minified-file limits. Show language detection, highlighting availability, and language-server availability as separate facts.

**Acceptance:** Real tokenization tests distinguish comments, strings, keywords, and embedded languages. Theme inspection passes in light and dark. Opening multiple files does not recolor unrelated models or register duplicate providers. Offline packaged-app loading works, and a failed grammar load can recover.

Do not treat the language-picker entry count as the number of supported grammars or language servers.

## Formatting

**User outcome:** Format Document and Format Selection produce predictable, undoable edits without silently saving the file.

1. Add capability-gated formatting providers and commands, with one selected formatter per language. Start with the existing managed JS/TS, Rust, JSON, HTML, and CSS server families where the installed server advertises formatting.
2. Pass indentation options through the request; add tab-size and insert-spaces settings using the existing user/workspace/folder precedence. Apply formatting through the shared text-edit service, preserve selection/view state, and make it one undoable action.
3. Cancel or invalidate results when the user changes the document during formatting. Missing server/tool and unsupported selection formatting need explicit states.
4. Add default-formatter selection and opt-in format-on-save only after manual formatting passes. Validate precedence with `.editorconfig` before claiming support. Avoid an automatic dependency-installation path in this wave.

**Acceptance:** Representative TS/JS and Rust files format through real servers; selection formatting respects the chosen range where supported. A missing formatter gives a useful message. A stale response changes nothing. Undo restores the previous buffer, and save still uses the disk hash guard.

## Quick fixes and organize imports

**User outcome:** A diagnostic offers relevant fixes at the cursor and in Problems. Applying a fix updates the intended files and reports the actual result.

1. Preserve diagnostic `code`, `data`, `tags`, related information, source, severity, range, and document identity. Populate Monaco markers from the same diagnostics shown in Problems, without duplicating diagnostics from competing providers.
2. Register code-action discovery with diagnostic context, action kinds, disabled reasons, and lazy `codeAction/resolve`. Surface Quick Fix through the editor lightbulb/context menu and command palette; add Organize Imports as a distinct command.
3. Route text edits through the shared service. Start with edit-only actions, then support command-only actions through a server-level request API for `workspace/executeCommand`; the current document request wrapper is unsuitable because it always adds `textDocument`. For an action containing both an edit and a command, apply the edit first and execute the command only after successful application. Until command support exists, reject the whole combined action. If the command fails after an edit succeeds, report that exact partial outcome and retain undo for the edit.
4. Implement real server-request handling for `workspace/applyEdit`. Route requests into the edit service without holding the language-server request lock, and return truthful success/failure. Preserve existing approval policy for agent-originated actions and governed commands; keep direct user editor actions consistent with existing editing behavior.

**Acceptance:** A TS missing-import fix and a representative Rust fix work against real servers. Organize Imports is undoable. Resolved, command-only, and combined edit/command fixes complete correctly; a combined action never executes its command after failed edit application. Disabled actions explain why; cancellation, stale edits, and failed application never report success. Closing the menu restores keyboard focus.

## Search and replacement

**User outcome:** Search modes mean what their controls say, and Replace All shows the exact changes before applying them.

### Search controls and result accuracy

Expose case-sensitive, whole-word, and regex controls in the existing Search panel. Extend query types, state, persistence, IPC, and Rust options together. The native backend already supports regex and correctly converts ripgrep byte offsets to UTF-16 columns; retain that work.

Preserve leading and trailing query whitespace. Return explicit completion, cancellation, error, and result-limit states. Cancel superseded backend scans. Invalid regex must produce an error rather than silently becoming literal search. A fallback must preserve the requested regex, glob, ignore, and size-limit semantics or report that the mode is unavailable.

Search live dirty buffers in place of their disk versions, deduplicate canonical paths, and maintain consistent matching semantics across buffer and disk sources. Do not use a JavaScript matcher with different regex behavior for editor-buffer results.

**Acceptance:** Test literal metacharacters, query whitespace, Unicode whole words, emoji before matches, CRLF, includes/excludes, multiple roots, invalid patterns, and all toggle combinations. Rapid typing cannot display stale results. Result limits are visible. Unsaved matches appear, and outdated disk matches for the same file disappear.

### Replacement preview and application

Replace the current sequential `split/join` workflow with a prepared transaction. Offer per-file diffs, selected matches/files, and an explicit Apply action. Bind the preview to query options, buffer versions, and disk hashes; invalidate it when any input changes.

Ship literal replacement first. Use the shared edit service so dirty buffers remain unsaved and unopened targets become background dirty buffers with a changed-files summary and Save All. Add numbered/named regex captures in a separate slice using one documented native matching and replacement contract. Preview and application must use the same match plan. Reject unsupported expressions and cover zero-width matches without looping.

**Acceptance:** Preview equals the applied edits. Empty replacement is supported. A changed target invalidates the preview before application. Undo restores all affected buffers without overwriting later edits. Restart preserves unsaved replacements in background documents. Capture groups, escaped dollar signs, optional groups, and Unicode behave identically in preview and application.

## Implementation slices

Each slice should be independently reviewable and have a working user-visible outcome or a concrete behavioral gate.

| Slice | Scope                                                                                                | Can proceed alongside                               |
| ----- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | Canonical document registry, provider ownership, all-buffer LSP lifecycle, focused module extraction | Grammar/runtime validation; search query contract   |
| 2     | Cross-file opener, definition/reference routing, location history                                    | Grammar integration; search controls                |
| 3     | Shared text-edit planner, background buffers, validation, undo, minimal restart recovery, Save All   | Grammar fixtures; native search status/cancellation |
| 4     | Prepare Rename, rename preview, native multi-file acceptance                                         | Search buffer overlay                               |
| 5     | Bundled initial grammar set and actual tokenizer tests                                               | Navigation/edit work                                |
| 6     | Manual formatting and indentation settings                                                           | Search controls and status                          |
| 7     | Diagnostic metadata, Monaco markers, edit-only quick fixes                                           | Replacement preview                                 |
| 8     | Server-level commands, applyEdit request handling, command-only fixes                                | Regex replacement preparation                       |
| 9     | Search controls, truthful status, cancellation, live-buffer results                                  | Slices 2 through 8 as dependencies permit           |
| 10    | Literal replacement preview, shared apply/undo, changed-file handling                                | Quick-fix validation                                |
| 11    | Regex captures and preview/application parity                                                        | First-wave native acceptance                        |

Proposed module boundaries: document registry, navigation controller, edit planner/controller, and language-feature registration under `apps/desktop/src/editor/`; grammar assets beside the syntax loader; search matching/status in the existing Rust search module. Put new composed UI in focused `packages/ui/src` modules. Keep `App.tsx`, `surfaces.tsx`, `lib.rs`, and global styles within the existing architecture ceilings.

## Follow up priorities

| Priority | Work                                                                                  | Reason for this position                                                                |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P1 first | Outline, document/workspace symbols, breadcrumbs, signature help                      | Reuses dependable document identity and LSP routing; improves navigation immediately    |
| P1 first | Auto-save options, broader recovery controls, save-conflict workflow, editor settings | Extends the first-wave transaction recovery and Save All into the daily edit/save loop  |
| P1 next  | Python and Go tooling, explicit server readiness/setup, more grammars                 | Expand through the established provider contract and test one language family at a time |
| P1 next  | Hunk/line staging, merge-conflict editor, terminal search and file links              | Deepens review and terminal workflows after editor correctness                          |
| P2 first | Debug launch/attach, breakpoints, stopped locations, stack/variables/watches          | Complete one supported debugger end to end before adding adapters                       |
| P2 next  | Framework test adapters, individual test results, debug-test and coverage             | Start with one JS/TS framework and reuse diagnostics/navigation                         |
| P2 later | Executable extensions, remote environments, notebook kernels                          | Separate platform investments; do not make the first delivery wave depend on them       |

## Acceptance and release gates

Use small disposable TS/React and Rust projects with references across files, duplicate filenames in multiple roots, dirty buffers, external modifications, Unicode paths, and deliberately failing server responses. Keep behavioral assertions focused on the shipped implementation; string checks alone cannot prove editor navigation, tokenization, or edit application.

Extend `check-code-intelligence.mjs`, `check-syntax-highlighting.mjs`, and `check-workspace-search.mjs`, with Rust tests for native search and request/edit handling. Register any new guard and its runner in the same change, following [Verification](../verification.md).

For each slice, run relevant typechecks and behavioral tests. For UI changes, inspect the production component in fixtures across the established themes, densities, sizes, and minimum window dimensions. Before shipping the first wave, run `pnpm check`, `pnpm test`, `pnpm smoke:workbench`, and `cargo test --workspace`, then verify the real flows in an isolated packaged debug app. Record native outcomes separately from fixture rendering and protocol tests.

The first wave is complete when a developer can navigate to an unopened definition, rename across files, read Vue/Svelte/Astro syntax, format a file, apply a diagnostic fix, search with explicit modes, preview replacement, undo the changes, and save without losing existing work.

## Implementation anchors

- [Desktop Workspace wiring](../../apps/desktop/src/App.tsx): host location opening/history, buffer save, language-session and rename hooks, and search/replace controllers.
- [Workspace code editor](../../apps/desktop/src/editor/workspace-code-editor.tsx) and [document URIs](../../apps/desktop/src/editor/document-uri.ts): shared models, semantic-provider routing, cross-file editor opener, and per-pane view state.
- [Language sessions](../../apps/desktop/src/editor/language-sessions.ts) and [React integration](../../apps/desktop/src/editor/use-language-sessions.ts): all-buffer synchronization, document ownership, versions, and stale-response rejection.
- [Workspace edits](../../apps/desktop/src/editor/workspace-edits.ts), [rename controller](../../apps/desktop/src/editor/use-workspace-rename.ts), and [edit recovery](../../apps/desktop/src/editor/edit-recovery.ts): reusable text-edit planning, guarded batches, undo, Save All, and durable background drafts.
- [Rename UI](../../packages/ui/src/workspace-rename.tsx): keyboard-accessible preview and editor changes bar.
- [Managed language servers](../../apps/desktop/src-tauri/src/language_server.rs): server capabilities, document ownership, request routing, and server-initiated requests.
- [Monaco configuration](../../apps/desktop/src/monaco-editor.ts) and [syntax loading](../../apps/desktop/src/editor/monaco-syntax.ts): provider ownership and the TextMate registration hook.
- [Syntax loader](../../apps/desktop/src/editor/syntax-loader.ts): provider caching and retry behavior.
- [Workbench state](../../packages/ui/src/workbench-state.ts): background buffers, dirty state, batch changes, and focus preservation.
- [Native search](../../apps/desktop/src-tauri/src/workspace_search.rs), [search types](../../packages/ui/src/types.ts), and [search results](../../packages/ui/src/workspace-search-results.tsx): query options, matching, Unicode positions, and result status.
- [Workspace settings](../../packages/ui/src/workspace-settings.ts): existing user/workspace/folder precedence.
