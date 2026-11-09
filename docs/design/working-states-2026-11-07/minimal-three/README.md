# Minimal working-process choices

User correction, 2026-11-07: eliminate the nonminimal options and provide three choices. The previous set contained too many panels, nested surfaces, duplicate icons and status treatments for the desired minimal direction.

This shortlist replaces the ten-sheet set as the active visual selection. Previous artifacts are preserved as history.

Three proposed structures compare the same ordinary live run: plain log, fine rail, current action with collapsed history. The frame is illustrative and has no pending approval or failure. It is not a claim that those states should be hidden. After selection the chosen visual rules should be applied to the full state inventory.

Proposed scoped design rule for future working-process documentation: **Use plain text and a single disclosure for ordinary progress; introduce a container only when a decision or detailed content needs a boundary.** This keeps progress visually secondary and reduces repeated chrome. This proposal has not changed AGENTS.md, shared rules or memory.

Grounding: current source tokens in `packages/ui/src/styles-foundation.css`, compact run-row behavior in `packages/ui/src/chat-design.css:880`, captured production React fixture and the previous flat activity concept.

Generated with the built-in Image Gen tool. Full generation prompts are in [prompts.json](prompts.json). The option mapping will follow the order the three results appear in chat, not planned direction names. No app code is changed.

## Displayed selection order

1. [Option 1 — plain log](option-1.png)
2. [Option 2 — fine rail](option-2.png)
3. [Option 3 — current action](option-3.png)

These numbers match the three generated results displayed in the chat in this refinement turn. Preserve this mapping when the user selects a number.

## Static review

- Minimal framing: **pass**. No enclosing cards, nested panels, repeated badges or duplicate completed-status icons in these three choices.
- Hierarchy: **pass**. The current operation is visible; completed work is quieter. Option 3 has the smallest history footprint.
- Status meaning: **pass for this specimen**. Tests are visibly running; no result claims that they passed. Diff counts are illustrative sample data.
- Grounding: **pass with limits**. Palette and native type direction derive from the app; exact token sizes, motion, focus and interaction are **unverified** in raster concepts.
- Approval/error/empty variants: **not rendered in this comparison**. They remain in the source inventory and must stay explicit when applying the chosen treatment.
- No application code changed and no runtime tests run.

## Selected implementation — November 7, 2026

The user selected option 3 with expandable command groups and AI progress text between them, supplying a Codex screenshot as the behavior reference. The revised [selected mock](selected-option-3.png) is the implementation target. The compact production run now folds completed calls while preserving each narration boundary and keeping active/failed calls visible. See [implementation QA](../implementation/design-qa.md) for evidence and verification limits. This section supersedes the earlier ideation-only status above.
