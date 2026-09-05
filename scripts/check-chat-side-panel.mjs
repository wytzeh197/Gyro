#!/usr/bin/env node
/**
 * Structural checks for the chat side rail — the column that hosts the
 * environment launcher and the Browser, Changes and Terminal tools.
 *
 * Every assertion here stands in for a defect that was visible on screen:
 * a rail that overflowed the window, a toolbar clipped past its own edge, a
 * header that counted files the body never showed. They are written against
 * the source because the rail's failures are layout failures — the wrong
 * track, the wrong specificity, a control group that cannot wrap.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

/// Every declaration block whose selector list matches `selector` exactly.
function cssRules(source, selector) {
  const rules = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`${selector} {`, from);
    if (start === -1) return rules;
    const open = source.indexOf("{", start);
    const close = source.indexOf("}", open);
    if (close === -1) return rules;
    rules.push(source.slice(open + 1, close));
    from = close + 1;
  }
}

const surfaces = read("packages/ui/src/surfaces.tsx");
const styles = read("packages/ui/src/styles.css");

// --- The rail column itself -------------------------------------------------

expect(
  /@media \(min-width: 981px\) \{\s*\.gyro-chat-surface\.has-environment:not\(\.is-tiled\):has\(\.gyro-browser-rail\) \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/.test(
    styles,
  ),
  "The rail track must follow the browser card's drag width, or the card's own controls sit outside the column that draws it.",
);

expect(
  cssRules(
    styles,
    ".gyro-chat-surface.has-environment .gyro-environment-rail.is-tool",
  ).some(
    (rule) =>
      rule.includes("align-self: stretch") &&
      rule.includes("max-height: none") &&
      rule.includes("overflow: hidden"),
  ),
  "A hosted tool must fill the rail column at the same specificity as the launcher rule that would otherwise shrink-wrap it.",
);

expect(
  surfaces.includes("const clampWidth = useCallback(") &&
    /useEffect\(\(\) => \{[\s\S]{0,600}?const fit = \(\) => \{[\s\S]{0,400}?clampWidth\(current, parentWidth\)[\s\S]{0,400}?window\.addEventListener\("resize", fit\)/.test(
      surfaces,
    ),
  "A persisted rail width outlives its window, so the browser rail must re-clamp on mount and on resize.",
);

// --- Browser card -----------------------------------------------------------

expect(
  styles.includes(".gyro-chat-companion.is-browser-focus {") &&
    styles.includes("grid-template-columns: minmax(360px, 1fr) auto") &&
    surfaces.includes("browserCompanionWidth") &&
    surfaces.includes("browserTabLabel"),
  "A selected Browser tab must become the broad in-app page canvas, retain a readable chat column, and identify the page in its tab.",
);

expect(
  cssRules(styles, ".gyro-browser-preview").some(
    (rule) =>
      rule.includes("container-name: gyro-browser") &&
      rule.includes("container-type: inline-size"),
  ) &&
    styles.includes("@container gyro-browser (max-width: 470px)") &&
    styles.includes("@container gyro-browser (max-width: 340px)"),
  "The browser toolbar must reflow against the card's own width — the rail drags down to 280px, far below the single-row toolbar's needs.",
);

expect(
  (() => {
    const frame = cssRules(styles, ".gyro-browser-frame").at(-1) ?? "";
    return (
      frame.includes("justify-content: stretch") &&
      frame.includes("background: var(--gyro-code-bg)")
    );
  })(),
  "The browser stage must stretch to the frame and take its colour from the theme, or the preview sits in hardcoded dark bars.",
);

// --- Changes ----------------------------------------------------------------

expect(
  surfaces.includes("const reviewFiles = diffReview?.files.length ?? 0;") &&
    surfaces.includes(
      "const uncommittedFiles = sourceControl?.files.length ?? 0;",
    ) &&
    /changesLabel =[\s\S]{0,320}?reviewFiles > 0[\s\S]{0,160}?uncommittedFiles > 0[\s\S]{0,80}?uncommitted/.test(
      surfaces,
    ),
  "The Changes row counts what its panel reviews; the working tree is a different number and has to say so.",
);

expect(
  surfaces.includes('hasFiles ? "" : "is-empty"'),
  "The diff review must mark its empty state so the rail can drop the chrome that only acts on files.",
);

expect(
  /\{hasFiles \? \(\s*<div className="gyro-diff-review-toolbar">/.test(
    surfaces,
  ) &&
    /\{review\.commitMessage\.trim\(\) \? \(\s*<div>\s*<strong>Commit message preview<\/strong>/.test(
      surfaces,
    ),
  "An empty review must not show a toolbar of dead buttons or a commit heading with nothing under it.",
);

expect(
  cssRules(
    styles,
    ".gyro-environment-rail.is-tool .gyro-diff-review,\n.gyro-environment-rail.is-tool .gyro-diff-review.is-compact",
  ).some((rule) => rule.includes("grid-template-columns: minmax(0, 1fr)")) &&
    cssRules(
      styles,
      ".gyro-environment-rail.is-tool .gyro-diff-file-list",
    ).some(
      (rule) =>
        rule.includes("max-height: 38%") && rule.includes("min-height: 96px"),
    ),
  "At rail width the file list stacks above the diff and keeps a floor and a ceiling — side by side leaves the diff about 40px wide.",
);

expect(
  cssRules(styles, ".gyro-diff-review.is-empty .gyro-diff-main").some((rule) =>
    rule.includes("grid-template-rows: minmax(0, 1fr) auto"),
  ),
  "Dropping the toolbar from an empty review leaves two children, so the diff column must drop to two rows or the footer stretches over half the panel.",
);

expect(
  styles.includes(
    ".gyro-environment-rail.is-tool .gyro-diff-review.is-empty .gyro-diff-file-list",
  ),
  "An empty review already says so in the middle of the panel; the empty file list above it must not repeat that in a third of the rail.",
);

expect(
  cssRules(
    styles,
    ".gyro-environment-rail.is-tool .gyro-git-action-strip,\n.gyro-environment-rail.is-tool .gyro-diff-review-footer > div:last-child",
  ).some((rule) =>
    rule.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"),
  ) &&
    styles.includes(
      ".gyro-environment-rail.is-tool .gyro-git-action-strip > button > small",
    ),
  "Footer actions go two-up in the rail and drop their trailing status word, or right-aligned wrapping turns the footer into a staircase of truncated labels.",
);

// --- Terminal ---------------------------------------------------------------

expect(
  cssRules(
    styles,
    ".gyro-environment-rail.is-tool .gyro-terminal-toolbar.is-empty",
  ).some((rule) => rule.includes("max-width: 100%")),
  "The terminal empty-state card must cap at the rail width instead of bleeding past both edges.",
);

// --- Launcher and the way back ---------------------------------------------

expect(
  surfaces.includes(
    'const backToLauncher = () => onSelectPanel?.("environment")',
  ) &&
    /aria-label="Changes"[\s\S]{0,400}?onBack=\{backToLauncher\}/.test(
      surfaces,
    ) &&
    /aria-label="Terminal"[\s\S]{0,400}?onBack=\{backToLauncher\}/.test(
      surfaces,
    ) &&
    surfaces.includes("onBack={onSelectPanel ? backToLauncher : undefined}") &&
    /aria-label="Back to environment"/.test(surfaces),
  "A tool takes the rail over in place, so every hosted tool needs a way back to the launcher rather than only a way to close the pane.",
);

expect(
  cssRules(styles, ".gyro-environment-rail header.gyro-chat-tool-header").some(
    (rule) => rule.includes("justify-content: flex-start"),
  ),
  "A tool header opens with a back chevron and reads left to right; the launcher's spread-apart header pushes its title against the rail's right edge.",
);

expect(
  surfaces.includes('browserLabel === "Idle" ? null'),
  "The launcher hides a row's detail only for its own neutral state — the browser's is Idle, which is what its label actually says.",
);

expect(
  !surfaces.includes("<small>Open</small>"),
  'The Files row has no state worth a detail: "Open" restated the button, and the folder it opens is already in the rail header.',
);

if (failures.length > 0) {
  console.error(`check-chat-side-panel failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("check-chat-side-panel: ok");
