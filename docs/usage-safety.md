# Usage safety

A design for keeping a user's provider quota from disappearing in a single
click, and a record of what has been built against it.

Status: layers 0 through 3 are implemented. Layer 4 is partial.

| Layer          | State   | Where                                                                                                  |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| 0 — Ledger     | Built   | `crates/gyro-core/src/usage.rs`, `usage_ledger` table                                                  |
| 1 — Budgets    | Built   | `UsageBudget`, `budget_state`, `budget_decision`                                                       |
| 2 — Preflight  | Built   | `estimateTurnCost` + composer confirm                                                                  |
| 3 — Breakers   | Built   | `guard_decision`, enforced in `run_provider_chat_with_retry`                                           |
| 4 — Visibility | Partial | Cost line, safety banner, and per-provider windows (plan or ledger) built; origin breakdown screen not |

## The pause is a state, not a switch

A boolean can only say "no". `PauseState` carries why work stopped, what it
covers, and when it lifts:

- **Reason** — manual, or a budget that ran out, named by provider.
- **Scope** — everything, or automations only, so a schedule can be stopped
  without stopping the person at the keyboard.
- **Expiry** — a budget pause resumes itself when its rolling window frees up;
  a manual pause has no expiry and waits for the user.

Exhausting a budget writes the pause to config, so the block survives a restart
and explains itself rather than presenting as an unexplained failure. A manual
pause outranks an automatic one and is never overwritten by it — resuming work
the user stopped on purpose would be the worst possible bug in this system.

## Why quota vanishes today

Gyro currently has no idea what it has spent. It has three separate blind
spots, and they compound.

**1. Providers report their limits unevenly.** OpenAI's Codex CLI answers
`account/rateLimits/read` with a used percentage; Anthropic's account API
answers `/api/oauth/usage` the same way, with `rate_limit_event` frames naming
windows and resets mid-answer as a fallback; xAI's Grok Build reports a weekly
credit percentage over ACP `_x.ai/billing`; Kimi answers `/coding/v1/usages`
with one row per metered window. Gemini reports nothing at all. Because
`ProviderUsageWindow.usedPercent` is deliberately optional and the ledger
measures every provider locally, a missing reading shows as unfilled or as
local spend rather than as an invented number.

**2. One keystroke can buy many turns.** The multipliers are invisible at the
moment they are committed:

| Action               | Provider calls for one Enter              |
| -------------------- | ----------------------------------------- |
| Normal turn          | 1                                         |
| Council turn         | up to 4 seats + 1 synthesizer = **5**     |
| Council re-synthesis | +1 each retry                             |
| Automation           | 1 per scheduled fire, unattended, forever |

Effort multiplies again inside each of those: `ultra` and `max` buy far more
reasoning tokens per turn than `low`. A council turn at max effort across four
seats is the single most expensive thing the app can do, and today it costs
exactly one keypress with no confirmation.

**3. Nothing counts, and nothing stops.** There is no ledger, no budget, no
ceiling, and no kill switch. A loop — an automation that reschedules, a retry
that retries — runs until the provider itself refuses.

## Principles

- **Measure locally.** Never depend on the provider to tell us what we spent.
- **Be honest about precision.** A measured number and an estimate are
  different things and must be labelled differently, the way
  `usedPercent` is left absent rather than guessed.
- **Cost is disclosed before it is committed**, not after.
- **Degrade, don't detonate.** A tripped limit should pause and ask, not kill
  work in flight and lose it.
- **The user can always see where it went.** Quota that disappears without an
  explanation is the actual complaint.

## Layer 0 — The ledger

One append-only table, one row per _provider call_ — not per user turn, since
the gap between those two is the whole problem.

```
usage_ledger(
  id, occurred_at,
  provider_id, model_id, reasoning_effort,
  origin,            -- chat | council-seat | council-synthesis | automation | retry
  session_id, turn_id, seat_id,
  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
  measured,          -- true = provider reported it, false = we estimated
  wall_ms, outcome   -- done | failed | cancelled | timed-out
)
```

Most of the inputs already exist: `ProviderContextUsage` carries the token
breakdown off Claude and Codex streams today, and `estimateComposerContextUsage`
already estimates from characters when nothing is reported. The work is
persisting a row per call and tagging it with an origin, so a council turn
shows up as five rows rather than one.

`measured: false` rows are shown in the UI in a distinct, muted style with the
word "estimated". They still count against budgets — an unmeasured provider is
not a free one — but the user is never told a guess is a fact.

## Layer 1 — Budgets

User-set caps in config, per rolling window, with three thresholds rather than
one cliff:

| Threshold      | Behaviour                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| 70% — notify   | A quiet meter change. No interruption.                                                                 |
| 90% — throttle | Expensive actions (council, max/ultra effort, automations) require confirmation. Normal turns proceed. |
| 100% — stop    | New provider calls are refused with a clear reason and a one-click override. In-flight work finishes.  |

Defaults should be derived, not invented: when a provider reports its own
window (Codex) the budget tracks that window. When it reports only a reset time
(Claude) the budget is a local token cap over the same period. When it reports
nothing, the budget is a token cap the user sets, defaulting to conservative.

Budgets are per provider, because quota is per provider. A global "spend"
number across providers with different plans and prices would be a fiction.

## Layer 2 — Preflight

The disclosure happens at the composer, before Enter commits anything.

Gyro already computes the frozen context size and already renders a council
preflight strip listing the seats. Extend that strip from _who_ is running to
_what it costs_: "4 seats + synthesis ≈ 5× a normal turn, ~180K tokens of
context each." The number is an estimate and says so.

Confirmation is required — a real dialog, not a toast — when a single action
would consume more than a set share of what remains in the window (say 10%).
That is the specific guard against the "click and it's gone" case: the
expensive action is the one that has to be agreed to.

Two composer-level guards worth having:

- Selecting `ultra`/`max` effort with a large context shows the multiplier
  before the turn, not after.
- Council mode plus max effort across four seats is flagged as the most
  expensive combination available and cannot be triggered without a confirm.

## Layer 3 — Circuit breakers

Preflight covers deliberate actions. Breakers cover the ones nobody chose.

Built as `UsageGuardConfig` plus a pure `guard_decision`, enforced inside
`run_provider_chat_with_retry` so no provider path can be added that skips it.
Counts come from the ledger, so the breakers cover providers that report no
usage of their own. Defaults: a 10-minute window, 40 calls overall, 12
unattended calls, 3 re-syntheses, and a 2M-token ceiling per call.

A ledger the guard cannot read is not treated as proof of safety, but blocking
on a read failure would strand the user with no way to work, so the call runs
and the failure is logged. A pause is the exception: it holds even when the
ledger cannot be read at all.

The intended set, and what each does:

- **Per-turn ceiling.** A turn that exceeds N tokens is cancelled and reported,
  rather than running until the provider stops it.
- **Runaway loop detector.** More than N provider calls in M minutes with no
  intervening human message pauses the source and asks. This is aimed squarely
  at automations and at retry paths.
- **Retry budget.** Council re-synthesis and provider retries are capped per
  turn and are written to the ledger like any other call. A retry that isn't
  counted is exactly how quota disappears without a trace.
- **Concurrency ceiling.** A cap on simultaneous provider processes, so a
  workbench full of parallel sessions can't fan out without limit.
- **Pause everything.** One switch that stops all scheduled and queued provider
  work immediately, reachable without hunting through settings.

Automations get their own allocation out of the budget, and auto-pause on
exhaustion instead of competing with interactive work — an unattended job
should never be what eats the quota the user wanted for chat.

## Layer 4 — Visibility

- **Composer meter** reads from the ledger, so it works for providers that
  report nothing. Measured and estimated are visually distinct.
- **Composer limit rows** sit under the context bar: the provider's own plan
  windows where it reports them (OpenAI, Anthropic, xAI, Kimi), otherwise a
  local spend row from the ledger (`ledger-*` ids, labelled "· local").
- **Settings → Usage Limits** shows plan-window cards for providers with a
  usage source and ledger spend cards for the rest, so every provider in the
  catalog has something measured on screen (`ledgerWindows`,
  `ledgerWindowsCaption`).
- **Per-session cost line**: "this chat: 1.2M tokens over 14 turns, 5 of them
  council seats."
- **Where it went**: a breakdown by origin for the current window. When quota
  drops fast, this is the screen that answers why — and it is the piece that
  directly addresses the complaint.

## What is left

1. **The "where it went" breakdown**, grouped by origin for the current window.
   `UsageTotals.by_origin` already returns exactly this shape; the ledger
   windows carry it as `origins` but no screen renders it yet.
2. **Automation allocations**, so a schedule draws from its own budget rather
   than competing with interactive work.

The thresholds shipped as defaults are starting guesses. They are worth
revisiting once there is a week of real ledger data to look at — particularly
the 400K preflight confirm, which is the one a user meets most often.
