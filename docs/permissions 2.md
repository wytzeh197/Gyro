# Permissions and remembered choices

Gyro starts a new installation in **Ask for approval**. Commands and file edits
require approval until the user chooses another permission mode.

The chosen mode is a user preference, not a per-turn suggestion. Once the user
selects Ask for approval, Approve for me, or Full access, Gyro saves that choice
in its local configuration and restores it on the next launch. Gyro must not
silently reset the choice after a completed run, restart, provider switch, or
update.

## Mode contract

| Mode             | Normal provider run                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Ask for approval | Always ask before commands and file edits.                                                           |
| Approve for me   | Allow commands, edits, and sub-agent delegation within Gyro's provider/workspace boundary.           |
| Full access      | Allow normal provider runs to use their unrestricted execution mode without Gyro capability prompts. |

Plan remains a non-mutating ceiling and Council remains advisory-only regardless
of the remembered normal-run mode. Changing mode is always explicit and the
current mode must remain visible in the composer.

Automatic sub-agent delegation is available at **Max** and **Ultra** effort.
Low, Medium, High, XHigh, and an unspecified effort run with one agent unless
the current user request explicitly asks to use sub-agents. An explicit request
to work without sub-agents takes precedence at every effort. Permission mode
does not enable delegation by itself. Gyro applies this rule to tool discovery,
model instructions, and execution, including resumed chats with older tool lists.
Existing children can still be inspected, waited for, and stopped.

Sub-agent spawning and follow-up tasks inherit the parent's model, workspace,
and permission ceiling. For an eligible turn, Approve for me automatically allows
delegation unless the project policy explicitly denies it; Full access uses the existing normal-run
override. Switching to either mode also releases eligible delegation requests
already waiting for approval. Ask for approval retains the explicit spawn
decision. Plan children stay read-only, Council cannot delegate, and children
cannot start further agents.

Project capability grants remain separately revisioned. They narrow or approve
specific Gyro capabilities when Full Access is not active; they do not silently
change the user's selected top-level mode.

In Full Access, chat Workspace edit submissions apply immediately through the
guarded file transaction. They return an applied result rather than an approval
card. Hash conflicts, unsaved editor changes and workspace path checks still
stop an unsafe replacement. Outside Full Access, the same submission remains a
review proposal. An explicit editor review action still creates a proposal.

## Execution boundaries

Model-opened terminals and model-requested workspace tasks filter inherited
credential-shaped environment variables, including explicit launch overrides.
This applies independently of the selected approval mode. Human terminal panes
and provider login flows keep their existing authentication behavior. Commands
that rely on ambient API keys or tokens may therefore need a different credential
path; an approval alone does not pass those secrets into a model-owned command.

On macOS, these Gyro-owned model commands also use a workspace filesystem policy:
writes are limited to the bound workspace and private scratch space, with known
credential stores, control metadata, and Gyro private data protected. Full access
bypasses this filesystem policy only in Normal mode and within a delegated
child's inherited ceiling. Sandbox setup failure does not retry unrestricted.

IP networking remains allowed. Human terminals and provider-native tools have
separate execution paths. See the [agent execution boundary matrix](agent-execution-boundaries.md)
for the exact scope, compatibility limits, and remaining acceptance work.
