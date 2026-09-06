# Clean-machine path

The clean-machine path is the shortest trusted loop on a Mac that has never
run Gyro:

1. Install and open Gyro.app (see [install-macos.md](install-macos.md)).
2. **Optionally open a project** — pick a local folder when the chat should
   work with files, diffs, and workspace tools.
3. **Connect a provider** — Codex CLI or Claude Code via the provider's own
   login (no Gyro config file, no API key pasted into Gyro).
4. **Send a first message** and complete one streamed response.
5. **Review a proposed edit** — approve or reject through Gyro's mutation
   transaction, not a free-floating terminal prompt.

This is launch blocker 3 and the core of the v0.2 private-alpha gate.
Signing and notarization remain a separate distribution gate.

## What the product enforces

| Gate     | Behavior                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| Project  | A chat can use **No folder**. File, diff, terminal, and workspace tools remain tied to a user-selected project.     |
| Provider | Send requires a connected executable provider. Disconnected rows in the model picker start `connect-provider:{id}`. |
| Honesty  | Blocked send disables the send control and states the next step in the composer placeholder.                        |
| Mutation | Supported Codex/Claude text edits use the journaled propose/review/apply/reject/recover path in `gyro-core`.        |

Shared logic lives in `packages/ui/src/clean-machine-path.ts` so UI and checks
cannot drift.

## Automated evidence

```bash
node --experimental-strip-types scripts/check-clean-machine-path.mjs
```

Also covered indirectly by:

- `pnpm smoke:workbench` — optional-project chat and workspace-tool rules
- `cargo test -p gyro-core mutations` — mutation journal and recovery
- `gyro doctor` / `gyro setup` — required vs optional checks with next actions

## Manual acceptance (Codex-only clean account)

Use a macOS user that has never configured Gyro. Provider CLIs may be installed.

1. Launch Gyro.app. Do not edit `~/Library/Application Support/Gyro/`.
2. Empty Chat must show **No folder** as the selected project context; **Open
   project** remains available for file-aware work.
3. Send stays blocked until a provider is connected, whether or not a project
   is selected.
4. Connect **OpenAI / Codex** from the readiness CTA or model picker → Connect.
5. Finish the provider-owned login. Gyro should show the provider as ready
   without a config edit.
6. Send: `Summarize the top-level README in one short paragraph.`
7. Confirm a streamed assistant response appears and the session survives an
   app restart (`resume` / reopen the same chat).
8. Ask for a small text-file edit in the repo. Approve in Diff / Chat; confirm
   disk matches the approved content. Reject a second proposal and confirm no
   write.

Repeat steps 4–8 with **Anthropic / Claude Code** on a clean account that has
only Claude installed (or with Codex disabled).

## Known limits (not part of this path)

- Application DMGs are still ad-hoc signed; first launch needs **Open Anyway**.
- Cursor and OpenCode are not approval-safe adapters yet.
- Notebook and binary mutations fail closed.
- Authenticated offline / stale-resume / physical sleep-wake proofs remain
  separate acceptance items on the roadmap.

## Exit criteria

The path is done when a new user can complete steps 2–5 above for Codex or
Claude without editing a config file, without guessing why send is disabled,
and without a mutation landing outside the approval transaction.
