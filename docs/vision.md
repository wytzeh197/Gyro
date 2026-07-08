# Vision

Gyro is a local-first agent workbench for trusted coding runs.

It is built for developers who want the leverage of coding agents without giving
up control of their local projects, terminal state, diffs, credentials, or Git
workflow. The first alpha audience is macOS developers who already work in the
terminal, already understand Git, and want one calm place to direct, inspect,
approve, and resume agent work.

## Product Pillars

- Local-first trust: sessions, project history, config, and worktrees live on the user's machine by default.
- Agent run clarity: every run should show what workspace, branch, provider, terminal, files, approvals, and next action are involved.
- Approval before mutation: commands, file edits, and sensitive context expansion should be visible before they change local state.
- CLI and app continuity: terminal-first and app-first workflows should share the same sessions instead of becoming parallel histories.
- Worktree safety: risky or parallel tasks should be easy to isolate without forcing the user to hand-manage Git plumbing.

## Design Principles

- Calm command center: Gyro should feel focused, quiet, and operational, with the agent's state easier to scan than the decoration around it.
- Dense but readable: coding-agent work creates a lot of state, so layouts should favor compact panels, stable controls, and clear grouping.
- Visible agent state: idle, running, waiting, blocked, approval-needed, failed, and done states should be explicit wherever work appears.
- No fake activity: empty states should be honest; the app should never imply configured providers, live terminals, diffs, or tasks that do not exist.
- Premium utility over decoration: polish comes from precise spacing, restrained color, crisp typography, reliable interaction, and fast paths to useful actions.

## Product Shape

Gyro is not trying to replace a full IDE in its first release. The v1 shape is a
trusted agent workspace with chat, terminal, file preview, diffs, settings,
provider setup, approvals, and CLI attach. Editor and IDE layers should deepen
that workflow later while keeping the same local-first engine underneath.

The product should be judged by whether a developer can open a repo, start or
attach an agent run, understand what the agent wants to do, approve or reject
changes, and keep moving without losing context.
