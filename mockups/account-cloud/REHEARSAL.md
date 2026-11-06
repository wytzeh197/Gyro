# Rehearsal — Gyro Account and Cloud

Gold reference is Stageshow static-card, rendered as gold.png through ?gold. Retained its sidebar/detail hierarchy and calm selection treatment. Adapted the composition for complete settings navigation and real copy. Uses the actual Stage, Window, Avatar and Icon components. The Stage measures its container and content to keep text at authored size. At narrow widths the Account detail becomes a page crop.

Captured light and dark at 1200px, desktop minimum width at 860px and stacked review at 390px. Still film gates passed at all four combinations. Ordinary navigation selection generates non-blocking lopsided warnings because labels align left within full-width rows. The library border generates a non-blocking near-tangent warning. The composition was inspected in addition to the gates.

Host-layout at 390px reports no issues. verify.cjs checks failed name save and retry, draft retention, sidebar name update, sign-out/sign-in, Cloud visibility, restoration, deletion confirmation and empty library, setup, unlock, absent plan, unnamed long-email profile, keyboard focus, and larger text at 860×620. Browser page errors and horizontal overflow checks passed.

Fresh-eye reviewer inspected light, dark, narrow and gold frames. Fixed recovery-card distribution, Account spacing, avatar consistency, theme control wrapping, and the Account sidebar surface stopping early.

The isolated mockup TypeScript check passes:
stageshow/node_modules/.bin/tsc -p stageshow/tsconfig.json

The application-wide typecheck still fails on existing duplicate Monaco declarations and missing workspace-open-folder capability metadata. Stageshow dependencies and TypeScript configuration are isolated in this mockup.

All account, plan, recovery and chat actions are local simulations. No remote authentication, profile persistence or backup operation occurs. Sidebar links in the comparison are illustrative. This is a still design review, so motion playback and animated state-sheet validation do not apply.

Open http://127.0.0.1:1429/account-cloud-review.html with desktop Vite running on port 1429. The ?gold route renders the original reference. Scripts use CHROME_PATH for the installed Chromium browser. verify.cjs uses Brave on this Mac.
