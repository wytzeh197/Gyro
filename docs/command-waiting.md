# Waiting for commands in chat

Models can keep working through long-running builds and CI checks using
`gyro_terminal_wait`. No additional user message is needed between the command
finishing and the model receiving its result.

For example: “Prepare the release, wait for both Intel and Apple Silicon builds,
and continue once they pass.” The model can start a finite command with
`gyro_terminal_open`, or a discovered task with `background: true`, then wait on
the returned `resource.id`:

```json
{ "resourceId": "<resource.id from the command result>", "timeoutMs": 60000 }
```

The wait returns bounded terminal output, `data.completed`, `data.exitCode`, and
the terminal snapshot. If it is still running, the model calls wait again on
the same resource. A wait timeout never restarts or kills the command. A failed
command is finished too: the model must inspect the exit code and output before
continuing. The chat activity says “Wait for command.”

For GitHub Actions, start `gh run watch RUN_ID --exit-status` in the model-owned
terminal. It completes after all jobs in that workflow, including both build
architectures. If architectures use separate workflow runs, watch both run IDs.
Use a finite watcher command rather than an interactive shell that never exits.

Each call waits 60 seconds by default and up to 5 minutes (`timeoutMs: 300000`),
and is cancellable. Every wait call re-sends the model's context, so one long
wait on a build costs far less than many short ones. Claude runs have native
background shells disabled: `--print` exits when the reply ends and would take
them down, so long work always goes through the model-owned terminal. Waiting itself is an
observation; starting a command still uses the existing command approval policy.
Resource IDs bind the wait to the original command in this chat and workspace,
so it cannot silently switch to a newer command or another chat's process.
Completed output stays available when other chats start terminals.

This runs within an active provider turn while Gyro is open. It is not a
scheduled wakeup or a promise to resume after quitting the app. Existing provider
turn/runtime/usage limits still apply (including Ollama's tool-round limit).
Publishing remains subject to the user's original authorization.

Processes that should stay up after the reply — dev servers, watchers, local
services — are not waited on. Gyro watches them under the final message and
relaunches the same command if they exit without the user or model stopping
them. See `docs/process-keep-alive.md`.

Validation: 23 desktop terminal tests (including five new wait tests), ten core
capability tests, the provider manifest check, the chat activity check, and
desktop TypeScript checking passed. No real release was published for testing.