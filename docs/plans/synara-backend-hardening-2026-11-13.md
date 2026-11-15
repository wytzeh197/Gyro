# Backend hardening: persistence and database safeguards

This implements the first two priorities from `docs/research/synara-backend-2026-11-13.md`. The research compared actual Synara and Gyro code and reproduced duplicate-message, stale-running-status, and unsupported-schema acceptance bugs. This change does not claim that streaming recovery, Git admission, SQLite memory/latency tuning, or warm provider reuse are complete.

## Durable turn indexes

Schema 17 adds `session_turn_index`. Its per-session watermark records file identity, indexed byte offset, modification time, and a hash of the bytes ending at that offset. Message rows, provider-status rows, and the watermark commit in one SQLite transaction under the same exclusive JSONL lock as appends.

Before message deduplication or lifecycle queries, Gyro catches up the durable log tail. Failure leaves the prior watermark intact and returns an error rather than trusting a partial index. After a new record is fsynced, index failure still preserves the existing successful-append contract. A retry repairs the index and returns the original event instead of appending a duplicate.

Global interrupted-turn discovery checks every session, including those missing a running-status row. Batch status writes use the same projection path. Replacement/truncation rebuilds projections; partial final lines remain unindexed until append repair. Complete malformed or oversized records are skipped, consistent with tolerant history reading, with bounded memory. Normal warm checks read metadata, the watermark and at most 256 anchor bytes; they do not scan event records. The first check of an older log scans that log once.

The watermark is for internally append-only logs. It detects identity changes, truncation, same-size modification, and changes at the boundary; it is not an integrity proof against arbitrary external rewrites that preserve that boundary. The first rebuild takes a SQLite write transaction for the scan; exceptionally large legacy logs can therefore delay other writers during their first recovery.

## Database compatibility and snapshots

Session, automation and agent-session opens reject a database version newer than this build, including reused pooled connections, before schema maintenance. The error includes the found and supported versions. Existing desktop/CLI concurrent migration coordination remains `BEGIN IMMEDIATE`.

Before migrating a nonempty older database, Gyro takes a consistent SQLite online-backup snapshot from a separate read connection while holding that migration reservation. The snapshot includes committed WAL data, passes `quick_check`, is synced and atomically published with private permissions. An empty new database needs no backup. Copying has a 60-second deadline, and known insufficient free space aborts before copying. Backup/validation failures abort migration; SQLite rolls back uncommitted schema work.

Snapshots live in `migration-backups` under the selected Gyro data directory. The newest three are retained. A retry takes a fresh snapshot because an older build may have written additional data since the prior failed attempt. This deliberately refines the research's proposed reuse-by-attempt approach. Abandoned temporary copies are cleaned under the migration reservation; unrelated files and symlinks are not pruned.

## Recovery commands

These bypass normal mutation/startup recovery so they remain usable with a damaged or unsupported active database:

```sh
gyro database backups --data-dir /path/to/Gyro --json
gyro database restore /path/to/snapshot.sqlite3 --output /path/to/restored.sqlite3 --json
```

`restore` checks the snapshot's supported schema and integrity, copies and syncs it to a new file, and refuses an existing output. It never replaces or activates the live database. A SQLite snapshot is not a complete Gyro backup: retain the matching sessions, configuration, workspace and journal directories. Activating a snapshot requires stopping all Gyro desktop/CLI processes, preserving the current database and WAL/SHM as a separate recovery set, and reconciling metadata created since that snapshot. Do not mix a restored database with the old database's WAL/SHM files. The new file lets recovery be inspected before any such offline replacement.

## Validation

All fault-injection and restore checks use disposable data directories, not the user's installed app database. Results on 2026-11-13:

- `cargo test --locked -p gyro-core -p gyro-cli -- --test-threads=4`: 1,222 passed, zero failed; eight ignored entries include subprocess helpers exercised by parent tests and existing opt-in tests.
- `cargo test --locked -p gyro-core --lib sqlite::recovery::tests -- --test-threads=4`: six passed after the final backup timeout/temp-file cleanup changes. The ignored crash helper was invoked by its parent test.
- `cargo test --locked -p gyro-cli --test database_recovery`: one passed. The real executable rejects normal startup on schema 9999, still lists/restores the snapshot, refuses to overwrite the restored file, and leaves the active schema untouched.
- `cargo test --locked -p gyro-desktop --lib -- --test-threads=4`: 1,043 passed, zero failed, 12 existing ignored tests. This includes startup reconciliation, provider finalizers, session history, and the other desktop unit tests.
- `cargo check --locked -p gyro-desktop`: passed, with nine existing unused/dead-code warnings in unrelated code.
- Provider stream-ordering checks passed for 42 catalog/custom models, including reorder/deduplication and terminal settlement. Chat draft/persistence checks passed.
- Rust formatting and `git diff --check` passed for the changed implementation files.

New tests inject failed message/status/watermark transactions, kill a writer after JSONL fsync, retry concurrently from two processes, replace/truncate logs, exercise unknown/deleted sessions, kill a migration, verify WAL data in snapshots, exercise backup-directory and disk-capacity failures, enforce retention, reject newer schemas on fresh and pooled connections, and refuse corrupt/existing restore targets. Concurrent migration tests passed in the full core suite. No physical full-disk or OS power-loss experiment was performed; disk-capacity checks and backup I/O failures were exercised instead.

Development-build measurements from the existing disposable benchmarks (250 sessions / 200 iterations; 2,000-event context fixtures): session open/read p50 50.7 µs, p95 65.7 µs; four-thread throughput 41.7 µs wall time per open; warm context medians 3.13 ms and 3.28 ms. Other compilation was active on this machine. These are post-change observations, not a before/after speedup claim. The recovery test directly asserts zero event bytes scanned for an unchanged log and only the new line's bytes after appending to a 2,000-event history.

No live paid provider run, signed installed-app upgrade, or production-database migration was performed. Concurrent unrelated UI/workspace changes were preserved. The research's streaming-recovery and performance experiments below remain separate implementation work.

## Remaining research priorities

1. Coalesced partial-response checkpoints with attempt/revision identity, bounded writes and reload/crash replay. Preserve final-response deduplication and explicit incomplete-output state.
2. Establish Git workload baseline, then add shared status reads and bounded admission with cancellation and mutation invalidation.
3. Measure database cache/RSS/connection counts and lock contention; add operation deadlines and cancellation before changing pool/cache limits.
4. Evaluate an optional warm Codex lifecycle only after paired measurements and tests for per-turn capability rebinding, account/workspace changes, stale callbacks, process death and eviction. No measured speedup currently justifies default process reuse.
