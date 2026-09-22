# Goal and plan unification

The goal is the outcome. The plan is a revisable route to it; checklist completion never automatically completes the goal.

The [status ramp](../../performance/design-language.md#goal-and-plan-status-ramp) defines marks, words, semantic colors and motion. Shared goal controls stay available in Document and Steps views. Chat modes preserve the goal and draft.

Verification uses the real ChatSurface in `apps/desktop/goal-plan-fixture.html` with seeded data and local state callbacks. This proves rendering and UI transitions, not provider execution or native persistence. The fixture seeds a goal set six seconds ago and a running toggle, so the strip's clock, its rotation gate and the three controls can all be exercised there.

The outcome is drawn as a strip on the composer, not as a row at the top of the transcript: mark, label, the goal text, its clock and the goal controls on one line, on screen for as long as the goal is open. Saving a goal changes that strip and nothing else — no line of prose to read and dismiss.
