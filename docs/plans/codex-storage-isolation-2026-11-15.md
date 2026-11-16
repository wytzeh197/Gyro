# Codex storage isolation

Gyro launches Codex with a private `CODEX_HOME` under its own data directory:
`providers/codex/<hash of source home>/`. Desktop chats, `gyro run`, provider
usage, health checks, sign-in, and native compaction use that boundary. Imported
Codex accounts get separate homes derived from their recorded source home.
`CODEX_SQLITE_HOME`, `sqlite_home`, and `log_dir` are also scoped so inherited
settings cannot redirect the thread database into the Codex app's storage.

File-backed credentials and their locks are symlinked to the original home;
tokens are never copied. Codex must preserve credential symlinks during refresh.
Configuration, global instructions, skills, rules and MCP file credentials are
shared. Sessions, databases, memories, caches and desktop state are private.
OS keyring credentials are scoped by Codex home: keyring-only users may need to
sign in once from Gyro. Login and health checks use the same private home as chat.

Existing Gyro transcripts stay in the Gyro store. The runner only resumes a
thread acknowledged in the private home's `gyro-threads` directory. On the first
message with an older shared cursor, it starts a private thread and supplies
Gyro's conversation context, as during a provider handoff. This preserves the
visible transcript but does not transfer Codex's hidden state or its entire
paginated history. Subsequent turns resume normally, including after crashes.
Compaction uses Gyro's local summary until there is a private native thread.
Imported transcripts follow the same rule: continuing in Gyro does not append
to the original Codex app conversation.

Old shared entries are not automatically deleted or archived by the product.
For cleanup, verify exact `originator = 'gyro'`, back up the metadata, and use
Codex's reversible `thread/archive` API. Never match by title or project directory.

Verification:

- `cargo test --locked -p gyro-core provider_runtime`
- `cargo test --locked -p gyro-cli --test exit_codes codex`
- `cargo test --locked -p gyro-desktop project_import_continuation --lib`
- Build `gyro-cli`, then run `python3 scripts/check-codex-storage-isolation.py`.
  This runs the real Gyro and Codex binaries for two turns against a loopback SSE
  fixture, checks native resume with the previous answer in context, and checks
  that transcripts and SQLite files exist only in Gyro's private home. It uses
  disposable directories and no paid model endpoint.
