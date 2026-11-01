# Local project imports

Settings → Workspace → Import projects manually discovers locally stored Claude Code and Codex conversations. The welcome suggestion opens that page. Choosing data folders and dismissing the suggestion are persisted desktop preferences. Opening Settings only resolves source availability; it does not enumerate conversations.

Projects keep their original folders. Each selected chat becomes a desktop session with `importSource` provenance and its original dates. Source histories and credentials remain unchanged. Archived Codex chats require the explicit toggle and a new scan.

## Modules

- `crates/gyro-core/src/project_import/`: bounded, read-only discovery and adapters for Claude ancestry and Codex rollout variants. Displayed history excludes hidden reasoning and system/developer instructions. Unsupported records, omitted media, malformed lines, and incomplete trailing writes produce diagnostics.
- `crates/gyro-core/src/sessions/project_import_storage.rs`: schema-7 import mapping, provider/native-ID deduplication, staged and synced JSONL publication, index recovery, project relocation, and explicit fresh-session metadata.
- `apps/desktop/src-tauri/src/project_import.rs`: backend-issued candidates, import jobs, durable progress, and cancellation between chats. Completed chats remain after cancellation or interruption.
- `apps/desktop/src-tauri/src/project_import_continuation.rs`: original native ID and data home, missing-folder checks, and explicit recovery when continuation fails. Imported chats bypass automatic fresh-session retry until the user chooses Continue in a new session.
- `apps/desktop/src/use-project-import.tsx` and `packages/ui/src/project-import-settings.tsx`: desktop controller and dedicated themed Settings surface.

Historical tools are settled, collapsed, inspectable display rows. They never replay commands, pending approvals, file-change events, or usage charges. Local attachment references use the existing file-card open/preview flow; embedded and remote media formats that cannot be represented are reported as omitted.

Provider readiness checks and the existing sign-in terminal use the imported chat's stored data home. The backend resolves that context from session provenance and applies it only to the matching Claude or Codex provider; ordinary chats retain their existing connection flow.

Folder recovery and the explicit fresh-session choice also use a private, bounded journal. Pending choices can be completed after an interrupted JSONL write or database update without scanning an existing chat's full history. Recovery preserves a newer provider binding and never reverses a committed fresh-session choice.

## Desktop commands

`scan_project_imports`, `start_project_import`, `get_project_import_job`, and `cancel_project_import` provide typed scan/job payloads. `project-import-progress` broadcasts the current job. Starts accept candidate IDs issued by a cached scan, rather than arbitrary renderer file paths. Supporting commands resolve source availability, locate an imported project, check chat recovery state, and explicitly detach native continuation.

V1 performs one-time imports. Rescans discover new chats; they do not synchronize later edits into imported histories. Cloud-only histories, other providers, credentials, and application preferences are outside this importer.

## Validation

Run `cargo test -p gyro-core project_import --lib`, `cargo test -p gyro-desktop project_import --lib`, the UI/desktop typechecks, and the session-listing, timeline, chat-run, usage, token, workbench, and architecture checks. Sanitized JSONL fixtures live alongside the adapters. Runner tests assert the exact original session ID and environment without sending a provider request. Native acceptance testing uses an isolated debug data directory and sanitized source homes.

The October 5 implementation passed 35 importer tests, 51 session regressions, 14 desktop import/continuation tests, three scoped health tests, and one login-home test. UI/desktop typechecks, relevant reliability and theme/architecture checks, and the debug desktop app bundle passed. Native checks covered the welcome geometry in both themes, manual discovery, importing/opening both providers, repeat scans, archived chats, hidden-project restoration, missing-folder recovery, and explicit fresh continuation with preserved dates. No live provider message was sent.

Progress, cancellation, and failure states passed component preview checks and backend tests. Additional native state captures use a separate 502-chat fixture set and currently await an unlocked Mac. Native evidence and the test-app launch-isolation caveat are recorded in `artifacts/screenshots/project-import-native/qa.md`.

## Provider references

Claude documents its transcript entries as internal and subject to change between releases; diagnostics and version fixtures are therefore part of the adapter contract. See [Claude session storage](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored). Native Codex continuation follows its documented session-ID flow: [Codex resume reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-resume).
