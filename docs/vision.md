# Vision

Gyro puts chat, CLI, and IDE in one place. A coding task should not require
rebuilding context as the conversation, terminal, files, diffs, and run state
move between separate tools.

It is built for developers who use more than one agent or provider and are tired
of losing context while switching between them, as well as developers who want
the leverage of coding agents without giving up control of their local projects,
terminal state, diffs, credentials, or Git workflow. The first alpha audience
remains macOS developers who already work in the terminal, already understand
Git, and want one calm place to direct, inspect, approve, and resume agent work.

Unification is the promise. Local-first storage, approval before mutation, and
honest run state are what make it safe to trust one workspace with the whole
coding loop.

## Product Pillars

- Unified coding context: chat, subscription CLIs, files, diffs, terminals,
  tasks, and run state should remain part of one understandable session.
- Provider-agnostic workflow: developers should be able to use supported agents
  without adopting a separate workspace and history for each provider.
- CLI and app continuity: terminal-first and app-first workflows should share the same sessions instead of becoming parallel histories.
- Local-first trust: sessions, project history, config, and worktrees live on the user's machine by default.
- Agent run clarity: every run should show what workspace, branch, provider, terminal, files, approvals, and next action are involved.
- Approval before mutation: commands, file edits, and sensitive context expansion should be visible before they change local state.
- Worktree safety: risky or parallel tasks should be easy to isolate without forcing the user to hand-manage Git plumbing.

## Why This Is Hard to Copy

No single provider—Anthropic, OpenAI, or an IDE vendor—has an incentive to
build a neutral cockpit across providers and interfaces; each benefits when the
developer stays inside its own CLI or IDE. Gyro's durable position is the
provider-agnostic, local-first layer above them all. That is a structural moat,
not merely a UI moat.

## Design Principles

- Calm command center: Gyro should feel focused, quiet, and operational, with the agent's state easier to scan than the decoration around it.
- Dense but readable: coding-agent work creates a lot of state, so layouts should favor compact panels, stable controls, and clear grouping.
- Visible agent state: idle, running, waiting, blocked, approval-needed, failed, and done states should be explicit wherever work appears.
- No fake activity: empty states should be honest; the app should never imply configured providers, live terminals, diffs, or tasks that do not exist.
- Premium utility over decoration: polish comes from precise spacing, restrained color, crisp typography, reliable interaction, and fast paths to useful actions.

## Product Shape

The v1 shape is a unified agent workspace with chat, subscription CLI sessions,
terminal, file editing and preview, diffs, settings, provider setup, approvals,
and CLI attach. Its integrated IDE surface is not a claim that the first release
replaces a mature standalone IDE. Editor and code-intelligence layers should
deepen the unified workflow over time while keeping the same local-first engine
underneath.

The product should be judged by whether a developer can open a repo, start or
attach an agent run, understand what the agent wants to do, approve or reject
changes, and keep moving without losing context.

## Open Core, and What Stays Free

The unification itself—chat, CLI, and IDE in one local session—is never
paywalled. Everything chargeable must sit around that experience, not inside it.
If a future feature cannot be described that way, it does not belong on the
paid list. Local usage must remain fully functional without a Gyro-hosted
service.

Potential paid areas, in priority order:

1. **Cross-device and cross-machine session continuity.** Start a session on one
   Mac, resume it on another, or check its status remotely through light hosted
   infrastructure.
2. **Unified provider usage and cost dashboard.** Aggregate and visualize usage
   and spend across Codex, Claude Code, Kimi, and other supported providers in
   one place.
3. **Team sync and shared sessions.** Add collaboration only after real teams of
   two or more are using Gyro; do not build it ahead of demonstrated demand.
4. **Organization policy controls and audit exports.** Enforce approval policy
   and export compliance logs across a team as a later, enterprise-only layer.
5. **Hosted model credits.** Keep this as a possible, low-priority convenience,
   not a near-term plan or product differentiator; it is commoditized and
   low-margin.
6. **Priority support and onboarding.** Offer this as a small later add-on, not
   as a primary revenue driver at this stage.
