# Gyro: Goals and Features

## The short version

This plan is about making Gyro a complete local workspace for building software with AI. It covers the whole product: the chat interface, CLI, IDE/workspace, models and providers, files, terminal, Git review, and the path from an idea to a working result.

The browser and right-side panel are one important focus. The goal is for the user and the AI to see and use the browser, terminal, files, and review tools together inside the chat, with clear feedback about what is happening.

For version 0.1.0, we want the existing pieces to feel connected, reliable, and easy to understand. We will prioritize user value and trust over adding lots of new features.

---

## Detailed AI working plan

## Immediate focus

The first priority is to make one complete Gyro journey excellent and provable:

1. Open a real project.
2. State a concrete goal in Chat.
3. Let the selected provider work through the existing capabilities.
4. See the model's browser, terminal, file, and approval activity in the right-side panel.
5. Review the resulting changes and evidence.
6. Run or preview the result.
7. Resume the work later without losing context.

This is the best first focus because it strengthens the product's existing advantage instead of adding another disconnected feature. The right-side panel should be the first major improvement inside this journey: it needs to be visible, understandable, reliable, and useful to both the user and the model.

## Prompt for the first implementation task

```text
You are working on Gyro, a local-first macOS AI workspace. The first product priority is the right-side panel inside a chat.

Before changing anything, inspect the current checkout, the existing panel implementation, the browser and terminal integrations, the provider capability routing, relevant tests, and the running desktop app. Do not assume that a surface works because it exists in the UI or documentation.

Produce a concise evidence-backed map of:

- What the user can currently open, see, operate, resize, and take over.
- What the model can currently open, inspect, control, and report.
- How Browser, Terminal, Files, Review, and Side chat connect to the active chat and session.
- Which providers and models can use each capability in reality.
- Which controls are incomplete, misleading, duplicated, or broken.

Then recommend the smallest high-value scope that makes the right-side panel feel like one useful shared workspace. Prioritize:

1. Clear visibility into model actions and current state.
2. Reliable user takeover and interaction.
3. Consistent provider/model capability reporting.
4. Browser and terminal behavior that can be observed and verified.
5. A coherent path from chat request to working result and review.

Do not add generic AI features, automatic multi-agent orchestration, Council, hosted services, or broad computer control in this task. Preserve local-first behavior, approval boundaries, privacy protections, and existing working flows.

After agreeing on scope, implement only the approved improvements. Add or update focused tests, run the relevant checks, and verify the actual checkout runtime. Report changed files, tests, runtime evidence, remaining gaps, and any capability that is still unavailable. Never claim a feature works based only on static source inspection.
```

## Recommended model for the first task

Use **GPT-5.6 Terra with high reasoning effort**. This is a broad but practical repository task involving React/TypeScript, Rust/Tauri, provider capability routing, UI behavior, tests, and runtime verification. Terra at high effort is the best default for carrying that work through without making the task unnecessarily speculative.

Use **GPT-6 Astra** only if the task expands into a major architectural redesign or requires unusually deep cross-system reasoning. Use medium effort for a read-only inventory or review, but raise it to high for implementation and verification.

## Product goal

Gyro is a local-first AI workspace for turning conversations with AI into working software.

The core experience should let a user start with an idea, give the work to an AI model, see it happen in the real project, inspect and guide the changes, and finish with a working result they understand and control.

## Near-term release goal

Have Gyro 0.1.0 completely ready by the end of this month, with a dependable core chat-to-software workflow and a clear foundation for more capable agents.

## Features to add or strengthen

### Right-side work panel

The panel should be useful to both the user and the model, working side by side with the chat. It should include Browser, Terminal, Files, Review and diffs, and Side chat, while feeling clean, focused, understandable, and easy to take over.

### Visible, model-controlled browser

Every supported executable model should be able to use the browser where its provider supports the capability. The user should see the page, navigation and interaction state, screenshots, and what the model clicked, typed, or inspected.

The model should be able to navigate, inspect page structure, click, type, scroll, submit forms, and read useful console or network information. Sensitive credential fields must remain protected.

### User-friendly terminal

The user should be able to open a polished interactive terminal inside the panel and use it alongside the chat. The model should be able to start processes, read output, stop processes, and eventually send follow-up input to an existing model-owned terminal session.

### Clear model and provider capabilities

The UI and backend should agree about which models can use browser, terminal, file, review, and computer-control capabilities. Availability should be visible before and during a task, with useful explanations when unavailable.

### Reviewable work

Users should be able to understand what the model did, inspect diffs and evidence, guide the next step, and approve or reject meaningful changes from the same workspace.

### Future computer control

Longer term, Gyro could add general computer control for arbitrary screen coordinates, native macOS applications, and OS-level keyboard and mouse interaction, with explicit safety and permission boundaries.

## Current known gaps

- Browser actions are not sufficiently visible or easy for the user to take over.
- No general native-app or OS-level computer control.
- Model-owned terminal sessions cannot receive follow-up input after launch.
- Companion-panel files are browse-and-open rather than fully editable there.
- Provider capability declarations and backend support need reconciliation.
- The advertised Browser shortcut conflicts with the app-level New terminal shortcut.

## Guiding principles

- Local-first and privacy-conscious.
- The user stays informed and in control.
- Capabilities should be observable, reliable, and honest.
- Chat, tools, evidence, and changes should feel like one coherent workspace.
- Build toward a useful product, not feature parity for its own sake.

## What Gyro should improve to stand out

Gyro already has three valuable entry points: a chat interface, a CLI, and a workspace that functions as an IDE. The next product advantage should come from connecting them into one dependable loop rather than treating them as separate features.

### 1. Make the full journey coherent

The user should be able to move naturally from idea, to plan, to implementation, to review, to a working result. Chat, CLI commands, files, terminals, previews, and diffs should share context and make the current state obvious.

### 2. Make progress and actions legible

Users need a trustworthy explanation of what the model is doing, what it has changed, what it is waiting for, and what needs approval. This is especially important in the browser, terminal, and file surfaces.

### 3. Make the result tangible earlier

Gyro should help users reach a visible working result quickly: a running app, preview, website, test result, or other concrete artifact. The product should make that result easy to open, compare, share, and continue improving.

### 4. Improve handoff and continuity

Work should remain understandable when users switch between chat, CLI, IDE, another model, or another session. Decisions, commands, files changed, open questions, and next steps should not disappear into the transcript.

### 5. Add opinionated workflows without creating lock-in

Useful workflows could include fixing a bug, building a feature, reviewing a change, exploring a codebase, preparing a release, and investigating a failing test. They should guide users while keeping the underlying project, files, and model choice open.

### 6. Build trust as a product feature

Permission states, provider limitations, model capabilities, network access, destructive actions, and cost or usage implications should be clear before they matter. Reliability and honest boundaries are more differentiating than a long tools list.

### 7. Prioritize the highest-value gaps

For the next stage, the strongest priorities are: a coherent right-side work panel, observable browser and terminal actions, reliable model capability routing, fast project-to-preview workflows, and durable task continuity. General computer control can follow once these foundations are excellent.

## How to approach the work

### Phase 1: Connect what already exists

Define one shared task state across chat, CLI, and IDE: current objective, active model, permissions, files changed, running processes, browser sessions, pending approvals, and next step. Make this state visible and consistent everywhere.

### Phase 2: Make the right-side panel trustworthy

Prioritize the panel as the main shared workspace. Make browser and terminal activity visible, let the user take over cleanly, show capability and permission state, and fix interaction rough edges such as shortcut conflicts. Verify the real runtime behavior, not only the catalog or static UI.

### Phase 3: Improve the idea-to-result loop

Create a small number of opinionated workflows: build a feature, fix a bug, review changes, investigate a failing test, and run or preview the result. Each workflow should end in a concrete artifact or clear decision.

### Phase 4: Preserve continuity

Add durable summaries for decisions, files changed, commands run, unresolved questions, and recommended next actions. Make switching between chat, CLI, IDE, and sessions feel like continuing work rather than starting over.

### Phase 5: Expand agent capability carefully

After the core loop is dependable, add model terminal input, richer browser takeover and evidence, broader provider support, and eventually general computer control. Each capability should have explicit permissions, visible boundaries, and a safe fallback.

### Measurement

Judge each phase by user-visible outcomes: time from idea to first working result, percentage of tasks completed without losing context, successful browser and terminal interactions, review clarity, and recovery from model or tool failure. Avoid measuring progress by the number of tools alone.

## Current feature review

### What is good

- The core positioning is clear: chat, CLI, and IDE/workspace in one local session.
- Local-first storage, provider-owned logins, loopback Ollama support, approval policy, redaction, and worktrees create a credible trust story.
- Shared sessions and CLI-to-app continuity address a real pain: losing context between agent, terminal, files, and diffs.
- The workspace has useful developer foundations: Explorer, search, Monaco editing, Git status, diffs, tasks, tests, diagnostics, terminals, and browser preview.
- Recovery and honesty work is valuable: resumable sessions, guarded file transactions, rollback journaling, explicit provider readiness, and visible run state.
- Provider breadth is a meaningful differentiator as long as each provider's actual capability is represented accurately.

### What is weak or unfinished

- The first-run and installation experience is still a trust barrier. The public alpha requires Gatekeeper intervention, and a clean-machine path across every claimed provider is not yet proven.
- The product has many surfaces, but the relationship between Chat, CLI, Workspace, AI tools, tasks, automations, and the right-side companion is not always obvious. Users can see features without knowing which one is the primary path.
- Browser support is technically promising but not yet a strong user experience: model actions, evidence, and takeover are not sufficiently visible.
- Terminal control is split between a good user terminal and weaker model-owned terminal control. The model cannot reliably continue interacting with an existing terminal process.
- Provider support is broad but uneven. Some providers are adapters or experimental, some models are chat-only, and UI capability claims can diverge from backend support.
- The codebase has structural concentration in very large files, increasing the cost and risk of improving the product.
- The roadmap and release documentation can drift from the current release state; current claims should always be checked against the current checkout and real runtime.
- Experimental LSP/DAP and similar surfaces risk implying a level of completeness the product has not yet earned.

### What is unnecessary or premature

- Council or parallel-answer experiences should remain frozen; they dilute the execution-focused product story.
- Automatic multi-agent orchestration is premature before the single-agent loop is proven on clean machines.
- A hosted paid layer, team collaboration, and cross-device sync should not compete with the local core before there is demonstrated demand and a privacy model.
- Windows and Linux support are distractions while macOS installation and first-run reliability remain unfinished.
- General native computer control is interesting, but lower priority than making browser, terminal, files, review, and approvals excellent.
- Trying to become a full replacement for mature IDEs would expand scope without strengthening Gyro's clearest advantage.

### Improvements in priority order

1. Make installation and first run dependable and proven on clean Apple Silicon and Intel machines.
2. Define one obvious primary journey: open a project, state a goal, run an agent, inspect actions, approve changes, see the result, and resume later.
3. Make the right-side panel a transparent shared work surface, with visible browser actions, evidence, permissions, terminal state, and user takeover.
4. Reconcile provider and model capability declarations across UI, backend, documentation, and runtime behavior.
5. Finish or remove experimental and placeholder surfaces; every visible control should work, be honestly unavailable, or be omitted.
6. Improve continuity with durable task summaries covering decisions, files changed, commands, approvals, blockers, and next actions.
7. Reduce structural debt before adding large new product surfaces.

### Overall judgment

Gyro has a real product foundation and a credible point of difference. It is not missing a giant new idea; it is missing a sharper, more dependable expression of the idea it already has. The next stage should be consolidation and proof: make the existing loop calm, visible, reliable, and easy to resume. That will create more user value than adding another major feature category.
