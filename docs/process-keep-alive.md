# Watching long-running processes after a turn

When a chat starts a process that is meant to stay up — a dev server, a
file/test watcher, a local service, or anything else in that family — Gyro
keeps an eye on it after the reply.

The turn can finish. The process stays. A compact watch sits under the final
message with its name, command, and live state. Stop and Terminal are on the
row. If the process exits without the person asking or stopping it (Stop in
chat or Terminal, or Ctrl+C), Gyro relaunches the same command, up to three
times with a short backoff. The watch then reads “Relaunched · watching”.

This is not a scheduled wakeup and not a new model turn. Gyro relaunches the
command the model already started. It also does not survive quitting the app:
like command waiting, the watch only runs while Gyro is open.

Finite work still uses `gyro_terminal_wait`. `gh run watch`, tests, builds,
and lints are not supervised. A model `gyro_terminal_stop` is an intentional
stop and is not relaunched.

Validation: `scripts/check-chat-keep-alive.mjs`, workbench keep-alive reducer
coverage, and the chat-hardening fixture’s Keep-alive replay.
