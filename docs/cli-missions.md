# CLI missions

Product direction for evolving Gyro’s CLI surface from a provider launcher into
mission control for coding agents.

## One-sentence promise

**A mission is one goal chat that plans work and owns multiple CLI workers —
often many copies of the same runtime (e.g. Grok Build × N), each with a
different task.**

## Principles

1. **Task-first, not brand-first.** Workers are owned by subgoals; the CLI
   profile is a runtime default, not the primary information architecture.
2. **Same-model fan-out is the default.** Multi-provider override is advanced.
3. **One control plane.** One goal thread per mission; workers are not peer
   chats competing for attention.
4. **Isolation for parallel workers.** Prefer worktrees (or clear path scopes)
   so concurrent agents do not thrash one tree.
5. **Honest state.** Idle, running, waiting, blocked, done, and failed are
   explicit per worker.
6. **Approval before mutation stays visible.** Parallel work must not become
   silent mutation.
7. **Progressive depth.** Single-run clarity first; then mission shell; then
   plan-approve-spawn; then integration polish.

## Phases

| Phase | Name | Outcome |
|-------|------|---------|
| 0 | Framing | Named direction; IA points at missions + open CLI |
| 1 | Mission shell | Goal chat + manual workers under one parent |
| 2 | Plan | Structured plan card; user approves before spawn |
| 3 | Spawn | Auto-create workers (same runtime × N), worktrees, caps |
| 4 | Integrate | Cross-worker diffs, conflicts, recovery, completion |

## Defaults

| Decision | Default |
|----------|---------|
| Worker runtime | Mission default profile (user preference / last used; often Grok Build) |
| Isolation | Worktree per parallel worker; shared tree OK when sequential |
| Spawn gate | Explicit plan approval (Phase 2+) |
| Orchestrator | Goal chat uses the normal Chat provider stack |
| Max workers | Soft 4, hard cap ≤ 8 (aligned with CLI launch presets) |
| Power path | Keep “Open Shell / Claude Code / …” for single CLI sessions |

## Non-goals (near term)

- Replacing Chat as the primary single-agent surface
- Multi-model as the marketing or default story
- Using Council as the orchestration engine
- Fully autonomous multi-agent spawn without approval
- Guaranteeing perfect non-overlapping edits without isolation or review

## Relationship to existing features

- **Chat** — one agent, one thread; still the default for focused work.
- **CLI profiles / terminal panes** — workers are real CLI runs, not simulated.
- **CLI launch presets** — static multi-pane fan-out; missions add goal + task
  binding and, later, plan-driven spawn.
- **Session goals / plans** — building blocks for mission goal and task list.
- **Worktrees** — isolation primitive for parallel workers.
- **Council** — parallel *answers* (frozen); missions are parallel *execution*.

## Alpha sequencing

Do not block single-agent reliability work on Phase 2–4. Ship Phase 0 framing
and Phase 1 mission shell when ready; automate only after the shell is calm and
honest.
