# Model tools

Gyro's model-facing tools return bounded observations so a large project does
not fill a chat's context in one call. Bounds should be visible to the model,
and collections that have more results provide a way to continue reading.
The existing workspace and approval policies apply to every page.

## Workspace discovery

`gyro_workspace_list` accepts an optional workspace-relative directory `path`,
`depth`, zero-based `offset`, and `limit` (up to 200). It returns `entries`,
`total`, `returned`, `hasMore`, and `nextOffset`. Use `path` to inspect a large
subtree and pass `nextOffset` with the same path and depth for the next page.
The page is shortened further when needed to fit the tool result budget. As
with other paged observations, repeat from offset zero if the tree changes.
The Workspace explorer still uses its complete tree listing.

`gyro_workspace_search` always interprets its query as a ripgrep regular
expression. An invalid expression or ripgrep failure is reported as an error;
it never silently retries as a literal search or drops requested globs.
Large match sets are shortened to fit the result budget, and the summary says
when to narrow the query or globs for the remaining matches.

## Workspace roots and live editor text

`gyro_workspace_get_context` returns the Session's versioned root IDs. A tool
request that acts on a Workspace root accepts `rootId`; it is required when a
Session has multiple roots. Paths remain relative to that root, and each root
uses its own project trust and approval policy. Pending edit proposals retain
the selected root through review and application.

Ordinary Workspace context lists editor metadata without selection text or
unsaved buffer content. `gyro_workspace_read_editor` requests live text for a
specific path and always opens a one-time approval card with the requested
text. The preview is delivered only to the running UI, not saved in Session
events. If the text changes before approval completes, Gyro rejects the read.
The returned `documentVersion` can be passed to a Workspace edit to reject a
changed editor document; an unsaved buffer also blocks file proposals.

Ollama models without native function calling use Gyro's JSON action loop.
OpenAI-compatible endpoints that explicitly reject native tools on the first
request switch to the same loop. Gyro validates each action against the
advertised schema and retries one malformed action before reporting failure.

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
