# Permissions and remembered choices

Gyro starts a new installation in **Ask First**. Commands and file edits require
approval until the user chooses another permission mode.

The chosen mode is a user preference, not a per-turn suggestion. Once the user
selects Ask First, Auto Approve, or Full Access, Gyro saves that choice in its
local configuration and restores it on the next launch. Gyro must not silently
reset the choice after a completed run, restart, provider switch, or update.

## Mode contract

| Mode         | Normal provider run                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Ask First    | Ask before commands and edits.                                                                       |
| Auto Approve | Allow commands and edits within Gyro's provider/workspace boundary.                                  |
| Full Access  | Allow normal provider runs to use their unrestricted execution mode without Gyro capability prompts. |

Plan remains a non-mutating ceiling and Council remains advisory-only regardless
of the remembered normal-run mode. Changing mode is always explicit and the
current mode must remain visible in the composer.

Project capability grants remain separately revisioned. They narrow or approve
specific Gyro capabilities when Full Access is not active; they do not silently
change the user's selected top-level mode.
