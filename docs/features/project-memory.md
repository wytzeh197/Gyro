# Project memory implementation

Updated 2026-11-11. [Release implementation plan](../plans/v0.1.2-implementation-plan.md).
This describes current source, not release or installed-app acceptance.

## File and authority boundary

`gyro_core::project_memory` owns lossless parsing and pure hash-bound edit plans
for `.gyro/memory.md`. Legacy entries remain readable without rewriting their
bytes. Managed entries have stable IDs, validated v2 comment metadata, kind,
relative source references, content hashes, and optional supersession. Invalid,
changed-source, or superseded entries are excluded from automatic context.
Unknown comments, surrounding prose, CRLF, Unicode and unrelated whitespace survive
edits. File reads use descriptor-confined, no-follow regular-file opens.

The limits are 256 KiB per document, 200 entries on writes, and 500 Unicode
characters per new/edited entry. Missing and existing-empty bases are distinct.
Native human edits use the existing mutation lane with an exact expected base,
current root/policy checks and live unsaved-editor checks. Model/CLI writes retain
normal mutation approvals. No parser, metadata, or suggestion grants authority.

## Token efficiency

New project settings default to **768 UTF-8 bytes and at most four entries**,
approximately 250 tokens by the conservative bytes/3 estimate. This is a ceiling,
not a fixed prompt charge. Existing saved budgets are preserved. Users can select
larger budgets, with hard ceilings of 6 KiB/eight entries and a one-percent
allowance for known model context windows.

Selection is local and deterministic: lexical rarity, explicit references,
scoped paths, then stable ordering. It uses no embeddings, model retrieval call,
startup conversation mining, or duplicate text index. Unrelated requests can cost
zero memory tokens. Metadata/source bodies are not sent with each selected fact;
prompt references use short keys.

Context stays in the dynamic prompt tail so the stable prefix remains unchanged.
An acknowledged unchanged provider thread receives no repeated memory text.
Valid earlier facts remain referenced on a generic continuation without being
resent. Changed/forgotten facts cause bounded invalidation. Unknown, interrupted,
or model-switched delivery is conservatively reset. Receipts are invalidated
before dispatch and acknowledged against the exact successful provider cursor;
they record IDs, hashes, sizes and reuse, not a second copy of fact text. The
composer hint and Memory receipts describe prepared context, not proof of model
use. Desktop and standalone CLI use the same selection/rendering implementation.

## Suggestions and UI

Candidate suggestions are requested only for explicit durable user-decision cues
in an eligible ordinary completed chat. They piggyback on that answer, with no
extra model call. Each suggestion requires an exact quote from the active user
message. Private provenance binds actual session/turn/event IDs; model-supplied
provenance is not accepted. Accept/edit/dismiss are explicit actions with revision
checks. Acceptance has a recoverable deterministic-ID intent; reconciliation
checks the text and metadata. Accepted/dismissed private draft text and quotations
are cleared.

Project memory is available in the sidebar project's hover menu → Edit project
→ Project memory. The existing companion and `/memory` also open the same panel.
It includes root selection, search, entries, edit/forget, suggestions, source
references, settings and context receipts. Drafts survive conflicts; async
responses are scoped to the current session/root. Forgetting removes future
memory retrieval, but already-sent provider context and separately captured
conversation/review/workflow artifacts have their own retention and deletion.

## Access across models and new chats

Every fresh project chat resolves memory from its persisted, authorized workspace
roots; memory is not owned by a provider, model, or the chat where it was saved.
The same loader runs before each desktop/CLI dispatch, so edits in another chat
are visible on the next turn. Model switches cannot reuse a different model's
acknowledged memory receipt. Fresh provider contexts receive selected facts even
when the previous provider thread had already received them.

Normal, Plan, and user-facing Model Council chats receive relevant memory.
Council previously had an overly broad exclusion; it now receives read-only
prompt context while retaining its no-tools policy. Internal reviews, extraction,
titles, and summaries remain isolated from automatic project-memory loading.
Frozen workflow execution also retains its explicit input boundary.

Codex, Claude, ACP providers, and Antigravity use the host context-message path;
Ollama and OpenAI-compatible APIs (including custom endpoints) use the host's
stable/dynamic prompt sections. Both include memory without requiring the model
to call a tool first. Normal and Plan models can additionally use the memory-read
tool where their adapter supports Gyro tools. Relevant selection remains bounded;
a generic or unrelated message does not send the entire memory file. Disabled
memory and project inspection policies remain effective. Separate project roots
and worktree checkouts do not implicitly share another checkout's uncommitted notes.

## Verification and remaining acceptance

The 2026-11-11 backend run passed **40 tests**: 30 core project-memory tests,
eight desktop tests selected by `memory`, and two CLI tests selected by `memory`.
Commands: `cargo test --locked --offline -p gyro-core project_memory --lib`,
`cargo test --locked --offline -p gyro-desktop --lib memory`, and
`cargo test --locked --offline -p gyro-cli memory`.

The new provider matrix iterates every executable registry provider plus a custom
endpoint ID. Core checks use two synthetic model IDs and fresh Normal, Plan, and
Council sessions, then verify restart, model-switch, and cross-chat edit behavior.
Desktop checks exercise both production prompt paths, fresh/resumed delivery,
confirmed reuse, and providers with/without native tool support. CLI checks also
exercise both host prompt paths. These are local backend/prompt tests without
credentials or paid model calls, not live-provider acceptance.

Earlier validation covered desktop TypeScript, architecture boundaries, UI tokens,
and browser fixtures for editing, conflicts, forgetting, receipts, suggestions,
and narrow/light/dark views. The 2026-11-11 settings fixture additionally verifies
project-hover navigation, saving within the dialog, and focus restoration.

Native WebView interaction, real provider fresh/resumed delivery, multi-process
candidate recovery and installed-app acceptance remain release checks. Test
fixtures and content-free receipts do not establish those outcomes. SQLite
session schema 13 owns memory, review and workflow persistence through the
existing migration/initialization paths; there is no competing `user_version`.
