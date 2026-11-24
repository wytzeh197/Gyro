# Chat permissions

A new installation starts in **Ask for Approval**. The approval preference applies
to ordinary chat turns. The composer shows the permissions for the selected
provider and workspace. Plan, Council, and unattended runs retain their own
limits.

| Mode | Behavior |
| --- | --- |
| Ask for Approval | Review commands and edits before they run. Antigravity cannot ask per tool, so it runs read-only Plan mode instead. |
| Approve for Me | Routine work runs without prompts; riskier actions still ask. What counts as routine depends on the provider (see below). |
| Full Access | Explicitly grant broader file and network access to a saved chat until Gyro quits. Changing the workspace or provider ends the grant. New chats begin with the regular approval preference. |

Approve for Me by provider:

| Provider | What runs without prompts | What still asks |
| --- | --- | --- |
| Codex | Commands and edits in the `workspace-write` sandbox | Edits outside the project ask; commands that leave the sandbox are blocked |
| Claude | Claude's `auto` permission mode | Anything outside auto mode |
| Grok | `auto` mode in the workspace sandbox | Anything Grok escalates |
| Kimi | Ordinary tool calls (`--yolo`) | Anything Kimi escalates |
| Gemini | Edits (`auto_edit`) inside `--sandbox`; Gyro approves Gemini's other tool requests | Nothing native; Gyro tools follow project policy |
| Cursor | Tools inside Cursor's sandbox (`--sandbox enabled`) | Anything that needs to run outside the sandbox |
| Antigravity | Edits (`accept-edits`) in Google's sandbox | Shell commands the CLI soft-denies |
| OpenCode | Edits and reads in the project, plus `git status`, `git diff`, `git log`, `ls`, `pwd` | Other shell commands, web fetch and search, and paths outside the project; `.env` files are never read |
| Ollama, DeepSeek, Mistral, OpenRouter, custom | Bounded workspace commands through Gyro | HTTPS commands, terminals, tasks, and file edits (edits go to review) |

On every provider, HTTPS commands still need one-invocation approval, and
Gyro's own tools follow the project's capability policy.

Upgrading from a configuration with global Full Access restores **Ask for
Approval**. The chat grant is held in memory. Queued submissions and recovered
turns re-enter under the regular permissions.

## Workspace commands

Bounded commands can write in the selected workspace and private scratch
storage. A foreground command can request exact public HTTPS hostnames on port
443. Gyro shows the command, workspace, and destinations before starting it.
Approval opens the destinations for one invocation. Public IPv4 resolution is
required. Model terminals can host loopback preview servers. Their outbound
access stays blocked in bounded mode.

Provider sign-in and model traffic follow their own policies. Browser actions,
web fetch, and Gyro web search use site permissions. **Allow for this chat**
remembers a site in the current chat until Gyro quits. **Allow for project**
saves the site across chats. Open **Settings → Permissions → Saved sites**
from a project to revoke a saved site and clear its remembered access in that
project's chats. See the [execution boundary matrix](agent-execution-boundaries.md)
for route details and acceptance.

## Stop and recover

Stop remains available while you draft a follow-up. The queue pauses when you
stop the active response. **Resume** uses a saved provider conversation when
available. **Retry** reattempts an interrupted send that can safely be retried.

**Changes from this turn** survives a stopped or failed run. **Undo recorded
edit** restores files from a guarded Gyro edit transaction when the current
files still match and the editor has no unsaved changes. Provider-reported
changes may be available for review with no undo data. Undo data is stored
locally and removed when its chat is deleted.
