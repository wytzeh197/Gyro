# Model tools

Gyro's model-facing tools return bounded observations so a large project does
not fill a chat's context in one call. Bounds should be visible to the model,
and collections that have more results provide a way to continue reading.
The existing workspace and approval policies apply to every page.

`maxBytes` is an optional observation-size hint: it defaults to 16 KiB, and
integer values are clamped to 1–128 KiB. An explicit `null` uses the default.
This applies to direct provider calls, API/Ollama validation, and Code Mode
(which further caps each observation at 16 KiB). Malformed types still return
correction guidance. Result truncation and continuation cursors still apply.

## Generated images

OpenAI chats enable Codex's native image-generation tool in Normal mode.
Generation still requires a Codex version, model, and account that expose that
tool; selecting a model with image input support does not establish generation
support. Plan and Council mode disable image generation.

Gyro handles `imageGeneration` events for the active thread and turn. Completed
PNG, JPEG, and WebP results are copied into the chat's private attachment
storage, then linked into the saved reply using the existing image preview.
This also works when Codex returns an image without accompanying text, and
keeps previews available after Codex removes its own output file. Image bytes
are excluded from the transcript and activity rows. The existing 10 MB image
limit and per-session attachment quotas apply. Provider failures and usage
limits are shown in the reply instead of being presented as successful images.

## Workspace discovery

`gyro_workspace_list` accepts an optional workspace-relative directory `path`,
`depth`, zero-based `offset`, and `limit` (up to 200). It returns `entries`,
`total`, `returned`, `hasMore`, and `nextOffset`. Use `path` to inspect a large
subtree and pass `nextOffset` with the same path and depth for the next page.
The page is shortened further when needed to fit the tool result budget. As
with other paged observations, repeat from offset zero if the tree changes.
The Workspace explorer still uses its complete tree listing.

`gyro_workspace_search` accepts an existing workspace-relative file or directory
as `path`. Omit `path`, pass an empty string, or use `.` to search the root.
A file path searches only that file; omit `globs` for this case because ripgrep
ignores glob filters on explicit files. To apply `globs`, use a directory or
omit `path`. Put filename patterns in `globs`, for
example `{"query":"begin.*Drag","path":"src","globs":["*.tsx"]}`.
A missing path returns correction guidance and never expands to a root search.
Workspace boundaries and sensitive-path protections also apply to file targets.

The query is always a ripgrep regular expression. Invalid expressions and globs
return correction guidance alongside the underlying error; escape regex
metacharacters when searching literal code. Search never silently retries as
literal text or drops requested globs.
Large match sets are shortened to fit the result budget, and the summary says
when to narrow the query or globs for the remaining matches.

## Workspace roots and live editor text

`gyro_workspace_get_context` returns the Session's versioned root IDs. A tool
request that acts on a Workspace root accepts `rootId`; it is required when a
Session has multiple roots. Paths remain relative to that root, and each root
uses its own project trust and approval policy. Pending edit proposals retain
the selected root through review and application.

Ordinary Workspace context lists editor metadata without selection text or
unsaved buffer content. The in-memory bridge also lists every open tab. It
holds the complete text of the active buffer, the active selection, and other
dirty buffers when that text fits in the capability result limit. Other clean
open files are left as metadata; read those with `gyro_workspace_read_range`.
`gyro_workspace_read_editor` requests live text for one open path and always
opens a one-time approval card with the requested text. The preview is
delivered only to the running UI, not saved in Session events. If the text
changes before approval completes, Gyro rejects the read. A dirty buffer whose
text did not fit is refused instead of returned as a clipped document.
The returned `documentVersion` can be passed to a Workspace edit to reject a
changed editor document; an unsaved buffer also blocks file proposals.

Ollama models without native function calling use Gyro's JSON action loop.
OpenAI-compatible endpoints that explicitly reject native tools on the first
request switch to the same loop. Gyro validates each action against the
advertised schema and retries one malformed action before reporting failure.

Native API and Ollama tool calls use the same schema validation. Invalid calls
return a correctable tool error before execution. For a native tool batch,
contiguous workspace list, search, read-file, and read-range calls may execute
four at a time, with results returned in call order. Writes, commands, editor
reads, and browser actions are sequential barriers. Each call still enters the
capability broker for policy, scope, approval, and cancellation checks. Reads
remain observations of live disk state, not an atomic workspace snapshot.

OpenAI-compatible streams can split a function name as well as its arguments;
Gyro reassembles both. A response containing an unnamed tool, duplicate call
IDs, or an ID that changes within one indexed call fails before any tools from
that response are dispatched. Previously completed rounds stay completed.

## Browser observations and element references

`gyro_browser_find` uses associated form labels and `aria-labelledby` text in
addition to the existing names. This is a bounded DOM observation, not the
browser's complete accessibility tree.

Element references remain usable across page and subtree reads while their
elements stay connected and their references remain in the 4,096-entry cache.
Each document has its own reference prefix. After navigation, removal, or cache
eviction, use `gyro_browser_find` to observe a fresh reference.

Page reads mark `truncated` when character, text, depth, breadth, or node-scan
limits omit content. A read processes up to 5,000 nodes, including hidden nodes.
Use a targeted subtree reference or `find` to continue inspecting a large page.
An incomplete observation is not evidence that the omitted content is absent.

Disabled clicks and disabled/read-only form writes fail instead of reporting
success. Selecting an unavailable option leaves the current selection intact
and returns an error.

Model-owned browser callback waits observe the owning run's Stop signal and
workflow cancellation. Each callback retains its eight-second limit; callbacks
within one browser tool also share a fifteen-second waiting budget. Work that
is still queued on the native main thread checks cancellation and expiry before
dispatch. A cancelled wait returns a cancelled tool result instead of waiting
for the original callback timeout. Manual browser calls do not inherit a stopped
model run's cancellation state. Already dispatched WebKit or mouse actions are
not rolled back; re-observe the page before retrying an uncertain action.

Navigation in an existing browser (navigate, reload and open/reuse) validates
the resource and current navigation reservation on the native main thread before
dispatching. A cancelled or superseded queued request cannot navigate later.
Viewport layout and scroll-preservation waits share the same cancellation and
deadline budget; queued viewport changes also validate their resource before
changing native layout. Cancelling before dispatch restores a known previous
document/token. An unbound older pending request is reported as requiring recovery
instead of being restored to an indefinite loading state.

On macOS, the browser keeps its requested integer CSS viewport inside a separate
native container that fits the visible panel. This avoids fractional frame
rounding and automatic titlebar insets changing the page's layout dimensions.
Native pointer conversion and PNG capture use that same CSS coordinate space.
Closing either a chat browser or a private Check browser detaches the container.
The native fixture, pixel comparisons and hardware limits are recorded in
[`2026-11-07-browser-viewport-geometry`](performance/2026-11-07-browser-viewport-geometry/README.md).

The desktop browser also works before a chat's first message. Its workbench
owner is accepted only by the desktop IPC command; model tools still require a
durable chat UUID and derive subagent visibility from the stored relationship.
Workbench native labels hash the complete owner key so spaces and punctuation
in project paths cannot invalidate or merge labels. Screenshots from these
pre-chat browsers use the existing `new` attachment namespace and remain in
their owning draft. Native App evidence is in
[`2026-11-07-browser-full-shell`](performance/2026-11-07-browser-full-shell/README.md).

Closing a companion Browser resolves the current pane's chat record. Pane keys
stay stable when a draft becomes a chat or its session is replaced; decoding an
old key can target the wrong browser. A removed pane cannot close the active
chat's browser. Transition regressions and native two-chat companion evidence
are recorded in
[`2026-11-08-browser-chat-isolation`](performance/2026-11-08-browser-chat-isolation/README.md).

Each model browser tool stays bound to one browser resource instance. Closing
and reopening a chat's browser invalidates the previous instance's queued tools,
state updates, captures, and console/network callbacks. Re-observe the new
browser before retrying; a chat ID alone does not identify a browser instance.

Gyro's open, navigate, reload and macOS history requests also invalidate the
previous committed document. Until the next document commits, DOM tools,
pointer actions and screenshots reject the request rather than returning or
acting on the old page. Once the new document is interactive, its DOM remains
usable while images and other resources load. The native evaluator tags its
results with navigation identity; observation assembly and capture registration
check that identity again. Same-URL reloads invalidate old work too. If an action
was already dispatched when its document changed, it may have run: observe the
current page before retrying it.

On macOS, main-frame provisional-load observation applies that boundary to
navigation started by links, forms and page scripts too. Prevented navigation,
same-document routes/fragments and iframe loads retain the parent document's
references. The observer forwards the existing WebKit navigation delegate's
handlers and is detached when its browser closes.

Failed or cancelled macOS loads stop the loading state and report a navigation
error to the panel and browser tools. The old native page stays hidden behind
the existing recovery controls. Try again requests the failed destination;
it does not reload the previous document left in WebKit after a provisional
failure. Back can explicitly recover that previous document. A failure after
commit still requires native history navigation rather than restoring a
partial page as successful. Native navigation tokens reject late failure,
commit and finish callbacks from a superseded load, including same-URL reloads.

The desktop checks native open/load/failure/title/viewport notifications against a fresh
snapshot with the same chat and resource IDs before updating the browser panel.
It uses that snapshot's values. A user close or newer open discards older UI
results and errors, including viewport changes and screenshot completion.
Creation and closure stay ordered per chat; stuck reads or history requests do
not hold up Close or a replacement browser's updates. Bursts of queued events
of the same kind retain the latest observation.

## Edit proposal outcomes

`gyro_workspace_edit` and `gyro_workspace_propose_edit` return `applied` and
`approvalRequired` alongside the durable proposal `status` and `proposalId`.
A completed tool response can mean that a proposal was created; only
`applied: true` confirms that its content was written to disk. A pending proposal
has `applied: false`, `approvalRequired: true`, and a `nextStep` explaining that
the file on disk remains unchanged. Keep its ID, continue independent work, and
wait for review before verifying that edit. Repeating the same edit creates
another proposal rather than applying the pending one.

## Code formatting

`gyro_code_format` asks the workspace language server for
`textDocument/formatting` and returns the formatter's edits instead of writing
the file. Each edit carries a 1-based `startLine`, `startColumn`, `endLine`,
`endColumn`, and its `newText`, so it can be applied with
`gyro_workspace_edit` or handed to the editor. Pass `tabSize` (1-16, default 4)
and `insertSpaces` (default true) to match the file's style. Edit pages use the
same `offset`/`limit`/`total`/`nextOffset` protocol as definitions and
references.

## Code navigation

`gyro_code_definition`, `gyro_code_references`, and `gyro_code_symbols` accept
an optional zero-based `offset` and positive `limit`. Definition and reference
pages allow up to 50 entries; symbol pages allow up to 200. Omitting `limit`
uses that maximum.

Results include `total`, `returned`, `offset`, `hasMore`, and `nextOffset`.
Use `nextOffset` with the same query to continue. It is `null` on the final
page. The cursor reflects the entries actually returned, including when the
JSON byte budget requires a smaller page. `truncated` means the result contains
only part of the collection; it does not mean the missing entries were absent
from the language server's response.

Symbols retain their nesting depth, including symbols deeper than three
levels. Language servers that are still indexing continue to return
`status: "indexing"` and `retryAfterMs`; that is not an empty search result.
Hover results mark text shortened to the tool's character limit with
`truncated: true`.

Navigation positions use one-based lines and Unicode character columns. A
returned `column` can be used in another code tool call, including on lines
containing emoji. If the original workspace source is unavailable or the
language server returns an invalid position, `column` is `null`;
`columnUnavailableReason` explains why, and `utf16Column` preserves the
language server's position for diagnosis. Do not pass `utf16Column` as a tool
column.

Pages are observations of the current language-server state. If source files
change or indexing progresses between calls, repeat the query from offset
zero when a consistent result set matters.

## Git history

`gyro_git_log` accepts an optional zero-based `offset` alongside its existing
`revision`, `path`, and `limit` filters. It returns `hasMore` and `nextOffset`;
use the same filters and the returned offset to continue. Use a commit hash
as `revision` when paging a history that might receive new commits.

`gyro_git_blame` returns `totalLines`, `hasMore`, and `nextLineStart`. Continue
with that line number to inspect the rest of a file. A nonempty file without a
trailing newline is supported, including a single-line file. Git show disables
external diff and text-conversion helpers so inspection does not invoke
repository-configured programs.

## Incomplete provider output

OpenAI-compatible providers that end a response with `finish_reason: "length"`
or `"content_filter"` fail the request explicitly. Ollama responses with
`done_reason: "length"` do the same. Tool calls from that incomplete response
are not dispatched, even if their partial arguments happen to parse as JSON.
Previously completed tool rounds remain completed; this check is not a
transaction rollback. The user can retry a narrower request or adjust the
provider's output limit where supported.
