// Fixtures shared by the acts: one believable repo ("aurora") and its work.
import { ev, makeSessions } from "../app/GyroApp";

export const W = "/Users/demo/aurora";
export const T = "2026-11-17T09:00:00Z";
export const sessions = makeSessions([
  { title: "Fix the checkout bug" },
  { title: "Fix flaky editor file tests" },
  { title: "Audit provider arguments" },
]);

// ---- Chat -----------------------------------------------------------------
export const ASK = "Fix the checkout bug and open a PR.";
const act = (id: string, activityKind: string, label: string, extra: Record<string, unknown> = {}) =>
  ev("system-event", label, { kind: "provider-activity", activityKind, activityId: id, status: "completed", label, ...extra });
export const userMsg = ev("user-message", ASK);
export const steps = [
  act("a1", "search", "Searched for cartTotal", { detail: "4 results" }),
  act("a2", "read", "Read src/cart/total.ts", { path: "src/cart/total.ts" }),
  act("a3", "file", "Edited src/cart/total.ts", { path: "src/cart/total.ts", additions: 6, deletions: 2 }),
  act("a4", "command", "Ran pnpm test cart", { detail: "12 passed" }),
];
export const approval = (status: string) =>
  ev("approval-requested", "Run gh pr create", {
    kind: "provider-tool-approval", approvalId: "ap-1", approvalType: "command", providerLabel: "Claude Code",
    command: "gh pr create --fill --base main", cwd: W, reason: "Open a pull request with the fix", risk: "medium", status,
  });
export const reply = ev(
  "assistant-message",
  "Fixed. Discounts are now rounded to cents before the total is summed, so checkout matches the receipt. Added a regression test (12 passing) and opened **PR #214** against `main`.",
);
export const plan = (done: number) => ({
  sessionId: "s-0", title: "Fix checkout total", sourceTurnId: "turn-1", updatedAt: T + done,
  items: ["Find where the total is computed", "Round discounts before summing", "Add a regression test", "Open a pull request"].map((title, i) => ({
    id: "p" + i, title, status: i < done ? "complete" : i === done ? "in-progress" : "todo", createdAt: T, updatedAt: T + done,
  })),
});
export const MODELS = [
  { providerId: "anthropic", modelId: "claude-opus-5" },
  { providerId: "openai", modelId: "gpt-5.6" },
  { providerId: "anthropic", modelId: "claude-sonnet-5" },
];

// ---- Parallel chats -------------------------------------------------------
export const panes = [
  { title: "Fix the checkout bug", providerId: "anthropic", modelId: "claude-opus-5", ask: "Fix the checkout bug and open a PR.", acts: ["Edited src/cart/total.ts", "Ran pnpm test cart · 12 passed", "Opened PR #214"] },
  { title: "Audit provider arguments", providerId: "openai", modelId: "gpt-5.6", ask: "Audit provider arguments for unsafe flags.", acts: ["Scanned src/providers", "Patched src/providers/args.ts", "0 unsafe flags remain"] },
  { title: "Fix flaky editor file tests", providerId: "anthropic", modelId: "claude-sonnet-5", ask: "Fix the flaky editor file tests.", acts: ["Found a race in watcher teardown", "Edited src/editor/watcher.ts", "Ran pnpm test editor · 48 passed"] },
  { title: "Write release notes", providerId: "openai", modelId: "gpt-5.6", ask: "Write release notes from main..HEAD.", acts: ["Read 23 commits", "Wrote CHANGELOG.md"] },
];
/** Events for pane `i`, `t` frames after it opened. */
export const paneEvents = (i: number, t: number, every = 22) => {
  const p = panes[i];
  const base = { sessionId: "s-" + i, turnId: "turn-" + i, createdAt: T, payload: {} as Record<string, unknown> };
  const list = [{ ...base, id: `u${i}`, kind: "user-message", message: p.ask }];
  p.acts.slice(0, Math.max(0, Math.floor((t - 16) / every))).forEach((label, k) =>
    list.push({ ...base, id: `a${i}${k}`, kind: "system-event", message: label, payload: { kind: "provider-activity", activityKind: k === 0 ? "read" : "file", activityId: `a${i}${k}`, status: "completed", label } }),
  );
  if (t >= 16 + p.acts.length * every) list.push({ ...base, id: `r${i}`, kind: "assistant-message", message: "Done. " + p.acts[p.acts.length - 1] + "." });
  return list;
};
export const paneBusy = (i: number, t: number, every = 22) => t < 16 + panes[i].acts.length * every;
export const branch = (i: number) => (i === 0 ? "main" : "gyro/" + panes[i].title.toLowerCase().split(" ").slice(0, 2).join("-"));

// ---- Automations ----------------------------------------------------------
const D = "2026-11-17T";
const auto = (id: string, title: string, prompt: string, schedule: string, status: string, triage: string, result: string, runs: [string, string][], unread = 0) => ({
  id, title, prompt, schedule, status, triageState: triage, project: W, provider: "anthropic", branch: "main",
  workspaceMode: "worktree", worktreeName: id, lastRunAt: D + "03:00:00Z", nextRunAt: "2026-11-18T03:00:00Z", lastResult: result, unreadResults: unread,
  runHistory: runs.map(([status, summary], k) => ({ id: `${id}-r${k}`, status, summary, startedAt: D + "03:00:00Z", finishedAt: D + "03:14:00Z" })),
});
/** The automations list `f` frames into the act; `flip` turns the flaky hunt on. */
export const automations = (f: number, flipAt = 96) => {
  const done = f >= 60;
  return [
    auto("nightly-deps", "Update dependencies nightly", "Bump minor versions, run the full suite, open a PR if green.", "daily-at", "current", done ? "needs-review" : "none",
      done ? "PR #217 · 14 packages updated · all tests pass" : "Running pnpm test…", [[done ? "passed" : "running", done ? "14 packages updated, PR #217" : "Running"], ["passed", "9 packages updated, PR #209"]], done ? 1 : 0),
    auto("triage-issues", "Triage new issues", "Label new GitHub issues and draft a first reply.", "hourly", "current", "needs-review", "6 issues labelled · 2 replies drafted", [["passed", "6 issues labelled"]], 2),
    auto("flaky-hunt", "Hunt flaky tests", "Rerun the suite 20× and fix anything that flakes.", "weekly-at", f >= flipAt ? "current" : "paused", "none", "No flakes found in 20 runs", [["passed", "No flakes"]]),
  ];
};
