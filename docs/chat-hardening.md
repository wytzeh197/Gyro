# Chat reliability regression coverage

This pass covers final reply placement, saved/live event reconciliation,
permission-aware Workspace edits, short answers and composer resizing.
It also runs the existing cancellation, retry, queue, persistence and provider
contract suites.

| Failure | Protection |
| --- | --- |
| A final reply inherits an opening title's position | Completed replacements receive a closing position; obsolete offsets are not reused. |
| Identical final text remains above late tools | Unsegmented completed replies are placed after observed work even when text is unchanged. |
| Reopening repeatedly moves or duplicates the reply | Completion and saved/live merges are tested for idempotence. |
| Identical narration disappears from another turn | Deduplication and event lookup are scoped to the owning session and turn. |
| A damaged segment list slices text in the wrong place | The complete list must validate; otherwise paragraph recovery is used. |
| A final answer such as A, 7 or a symbol disappears | Both the run model and final response renderer preserve short completed answers. |
| A chat edit creates a review card in Full Access | Workspace edit submissions use the guarded transaction immediately in normal Full Access mode. |
| A conflicting edit overwrites newer work | Existing hash, path, binary and size checks remain; stale-hash rejection is tested. |
| Composer changes trigger a ResizeObserver feedback loop | Layout writes are coalesced into animation frames and cancelled on cleanup. |

## Checks

- `pnpm test`: reliability regressions and both TypeScript projects.
- `cargo test --workspace`: Rust unit and integration suites, including
  Full Access application, pending review mode and stale-file rejection.
- `pnpm --filter @gyro-dev/desktop build`: production frontend compilation.
- `git diff --check`: patch whitespace validation.

The new lifecycle cases run in `scripts/check-chat-hardening.mjs`, included in
the standard reliability command. Existing suites cover stop/queue behavior,
stream reordering, reconnect/retry, draft persistence and provider contracts.

## Browser replay

Run `pnpm --filter @gyro-dev/desktop dev --port 1437` and open
`http://127.0.0.1:1437/chat-hardening.html`.
This development fixture renders the real ChatThread with synthetic events;
it does not call a provider or change saved sessions.

1. Start turn, then Complete turn: live work is expanded; completion collapses it and keeps the final response visible. Click "Worked for …" to reopen the details.
2. Reload saved turn: repeated clicks keep its content and placement stable.
3. Short answer: the final response displays 7.
4. Long work: narration splits the work into stretches. The earlier stretch
   collapses to one summary line ("Ran 2 commands, Read 1 file, 1 other tool
   call ›"). The live tail shows its newest four calls under "+N more tool
   calls", with the running command marked "Active now". The failed command
   reads "Failed". No row appears for the reasoning headline.
5. Keep-alive: a completed turn shows a compact watch under the final reply
   for a chat-owned dev server that should stay running.

The browser replay was checked in Gyro Browser. Full Access writes were tested
against temporary workspaces through the real guarded mutation code. The pass
does not install a new desktop bundle or publish a release, and does not claim
live end-to-end coverage of every external provider.