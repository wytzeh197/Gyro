# Chat permissions

A new installation starts in **Ask for approval**. The approval preference applies
to ordinary chat turns. The composer shows the permissions for the selected
provider and workspace. Plan, Council, and unattended runs retain their own
limits.

| Mode | Behavior |
| --- | --- |
| Ask for approval | Review commands and edits before they run on the bounded Codex and Claude desktop routes. Other providers can request approval for the actions they report to Gyro. |
| Workspace access | Routine commands and edits can run in the selected workspace on the bounded Codex and Claude desktop routes. Commands that need outside HTTPS destinations require one-invocation approval. |
| Provider permissions | On other routes, native tool limits depend on the provider. Gyro mediates its own tools. |
| Full access | Explicitly grant broader file and network access to a saved chat until Gyro quits. Changing the workspace or provider ends the grant. New chats begin with the regular approval preference. |

Upgrading from a configuration with global Full access restores **Ask for
approval**. The chat grant is held in memory. Queued submissions and recovered
turns re-enter under the regular permissions.

## Workspace commands

Bounded commands can write in the selected workspace and private scratch
storage. A foreground command can request exact public HTTPS hostnames on port
443. Gyro shows the command, workspace, and destinations before starting it.
Approval opens the destinations for one invocation. Public IPv4 resolution is
required. Model terminals can host loopback preview servers. Their outbound
access stays blocked in bounded mode.

Provider sign-in, model traffic, and separately approved Browser and Web Fetch
actions follow their own policies. See the [execution boundary
matrix](agent-execution-boundaries.md) for route details and acceptance.

## Stop and recover

Stop remains available while you draft a follow-up. The queue pauses when you
stop the active response. **Resume** uses a saved provider conversation when
available. **Retry** reattempts an interrupted send that can safely be retried.

**Changes from this turn** survives a stopped or failed run. **Undo recorded
edit** restores files from a guarded Gyro edit transaction when the current
files still match and the editor has no unsaved changes. Provider-reported
changes may be available for review with no undo data. Undo data is stored
locally and removed when its chat is deleted.
