// Demo project data for the workbench beats. Everything here is fiction about
// a sample repo ("aurora"); the UI that renders it is the real Gyro UI.
const W = "/Users/demo/aurora";
const T = "2026-11-17T09:00:00Z";

type Kind = "context" | "added" | "removed";
const lines = (rows: [Kind, string][]) => rows.map(([kind, content], i) => ({ number: 40 + i, kind, content }));

export const diffReview = (selected = "src/cart/total.ts", approval: "pending" | "approved" = "pending", prDone = false) => ({
  files: [
    {
      path: "src/cart/total.ts", additions: 6, deletions: 2, source: "agent-generated", state: approval === "approved" ? "accepted" : "pending", comments: 0, turnId: "turn-1",
      lines: lines([
        ["context", "export function cartTotal(items: CartItem[], discount: Discount) {"],
        ["context", "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);"],
        ["removed", "  const off = subtotal * discount.rate;"],
        ["removed", "  return subtotal - off;"],
        ["added", "  // Round each discount to cents before summing, so totals match the receipt."],
        ["added", "  const off = roundCents(subtotal * discount.rate);"],
        ["added", "  const total = roundCents(subtotal - off);"],
        ["added", "  if (total < 0) throw new RangeError(\"Discount exceeds subtotal\");"],
        ["added", "  return total;"],
        ["added", "}"],
        ["context", ""],
        ["context", "const roundCents = (n: number) => Math.round(n * 100) / 100;"],
      ]),
    },
    {
      path: "src/cart/total.test.ts", additions: 14, deletions: 0, source: "agent-generated", state: approval === "approved" ? "accepted" : "pending", comments: 0, turnId: "turn-1",
      lines: lines([
        ["added", "test(\"rounds discounted totals to cents\", () => {"],
        ["added", "  expect(cartTotal([{ price: 19.99, qty: 3 }], { rate: 0.15 })).toBe(50.97);"],
        ["added", "});"],
      ]),
    },
  ],
  selectedPath: `${selected}`,
  approvalState: approval,
  commitMessage: "Round cart discounts to cents",
  activeTurnId: "turn-1",
  collapsedDirectories: [],
  gitActions: [
    { id: "create-branch", label: "Create branch", detail: "fix/checkout-total", status: "done" },
    { id: "commit", label: "Commit", detail: "2 files", status: approval === "approved" ? "done" : "ready" },
    { id: "push", label: "Push", detail: "origin", status: approval === "approved" ? "done" : "blocked" },
    { id: "open-pr", label: "Open pull request", detail: "main ← fix/checkout-total", status: prDone ? "done" : approval === "approved" ? "ready" : "blocked" },
  ],
});

export const files = [
  { path: `${W}/src`, kind: "directory", depth: 0 },
  { path: `${W}/src/cart`, kind: "directory", depth: 1 },
  { path: `${W}/src/cart/total.ts`, kind: "file", depth: 2 },
  { path: `${W}/src/cart/total.test.ts`, kind: "file", depth: 2 },
  { path: `${W}/src/checkout.ts`, kind: "file", depth: 1 },
  { path: `${W}/package.json`, kind: "file", depth: 0 },
];

const pane = (id: string, title: string, profileId: string, command: string, output: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, title, profileId, command, output, status, lastEvent: "", workspaceMode: "local", branch: "main", projectPath: W, workingDirectory: W, createdAt: T, ...extra,
});

/** `upTo` reveals output line by line so panes feel alive. */
const reveal = (text: string, upTo: number) => text.split("\n").slice(0, Math.max(1, Math.floor(upTo))).join("\n");

export const terminalPanes = (t: number) => [
  pane("t1", "claude", "claude", "claude", reveal(
`✻ Claude Code
> fix the flaky editor file tests
● Read src/editor/files.test.ts
● Found a race in the watcher teardown
● Edited src/editor/watcher.ts (+9 −3)
● Ran pnpm test editor — 48 passed
✓ Done in 1m 12s`, t), "running", { hasForegroundJob: true }),
  pane("t2", "codex", "codex", "codex", reveal(
`>_ OpenAI Codex
user: audit provider arguments for unsafe flags
• Scanning src/providers/**/*.ts
• 3 call sites pass --dangerously-skip
• Patched src/providers/args.ts
• Added args.test.ts
✓ 0 unsafe flags remain`, t - 1), "running", { hasForegroundJob: true, worktreeName: "audit-args", workspaceMode: "worktree", branch: "audit-args" }),
  pane("t3", "gemini", "gemini", "gemini", reveal(
`✦ Gemini CLI
> write release notes from main..HEAD
✦ Reading 23 commits
✦ Grouped into Features, Fixes, Docs
✦ Wrote CHANGELOG.md
✓ Ready for review`, t - 2), "running", { hasForegroundJob: true }),
  pane("t4", "dev server", "shell", "pnpm dev", reveal(
`$ pnpm dev
  VITE v7.1.2  ready in 412 ms
  ➜  Local:   http://localhost:5173/
  ➜  press h + enter to show help
  12:04:31 [vite] hmr update /src/cart/total.ts
  12:04:33 [vite] hmr update /src/checkout.ts`, t - 1), "running", { hasForegroundJob: true }),
];
