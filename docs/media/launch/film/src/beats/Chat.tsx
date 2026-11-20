import { useCurrentFrame } from "remotion";
import { GyroApp, makeSessions, ev } from "../app/GyroApp";
import { Camera } from "../ui/motion";
import { Stage, Window } from "../ui/film";
import { Marquee, Pop, Slab, INK, WHITE } from "../ui/bold";
import { C } from "../ui/theme";

// 4–12s. Ask in plain words, watch the work, approve the one command that matters.
export const CHAT = 240;
const sessions = makeSessions([{ title: "Fix the checkout bug" }, { title: "Fix flaky editor file tests" }, { title: "Audit provider arguments" }]);
const T = "2026-11-17T09:00:00Z";
const ASK = "Fix the checkout bug and open a PR.";
const act = (id: string, activityKind: string, label: string, extra: Record<string, unknown> = {}) =>
  ev("system-event", label, { kind: "provider-activity", activityKind, activityId: id, status: "completed", label, ...extra });
const user = ev("user-message", ASK);
const steps = [
  act("a1", "search", "Searched for cartTotal", { detail: "4 results" }),
  act("a2", "read", "Read src/cart/total.ts", { path: "src/cart/total.ts" }),
  act("a3", "file", "Edited src/cart/total.ts", { path: "src/cart/total.ts", additions: 6, deletions: 2 }),
  act("a4", "command", "Ran pnpm test cart", { detail: "12 passed" }),
];
const approval = (status: string) =>
  ev("approval-requested", "Run gh pr create", {
    kind: "provider-tool-approval", approvalId: "ap-1", approvalType: "command", providerLabel: "Claude Code",
    command: "gh pr create --fill --base main", cwd: "/Users/demo/aurora", reason: "Open a pull request with the fix", risk: "medium", status,
  });
const reply = ev(
  "assistant-message",
  "Fixed. Discounts are now rounded to cents before the total is summed, so checkout matches the receipt. Added a regression test (12 passing) and opened **PR #214** against `main`.",
);
const plan = (done: number) => ({
  sessionId: "s-0", title: "Fix checkout total", sourceTurnId: "turn-1", updatedAt: T + done,
  items: ["Find where the total is computed", "Round discounts before summing", "Add a regression test", "Open a pull request"].map((title, i) => ({
    id: "p" + i, title, status: i < done ? "complete" : i === done ? "in-progress" : "todo", createdAt: T, updatedAt: T + done,
  })),
});

export const SENT = 40;
export const ASK_AT = 104;
export const APPROVE = 156;
export const REPLY = 176;

export const Chat: React.FC<{ probe?: number }> = ({ probe }) => {
  const frame = useCurrentFrame();
  const f = probe ?? frame;
  const sent = f >= SENT;
  const typed = sent ? "" : ASK.slice(0, Math.max(0, Math.floor((f - 6) / 0.9)));
  const shown = sent ? Math.min(steps.length, Math.floor((f - SENT) / 14)) : 0;
  const events = sent
    ? [
        user,
        ...steps.slice(0, shown),
        ...(f >= ASK_AT ? [approval(f >= APPROVE ? "approved" : "pending")] : []),
        ...(f >= REPLY ? [reply] : []),
      ]
    : [];
  const elapsed = sent ? ((f - SENT) * 1000) / 30 * 5 : 0;
  return (
    <Stage color="blue">
      <Marquee text="ASK · WATCH · APPROVE ·" y={-30} size={300} speed={6} />
      <Marquee text="ASK · WATCH · APPROVE ·" y={790} size={300} speed={-6} start={-1800} outline color="rgba(255,255,255,0.3)" />
      <Camera keys={[[0, 960, 600, 1.12], [36, 960, 560, 1], [ASK_AT, 960, 540, 1], [ASK_AT + 14, 1000, 430, 1.32], [APPROVE + 10, 1000, 430, 1.32], [APPROVE + 30, 960, 540, 1.02], [CHAT, 960, 530, 1.05]]}>
        <Window>
          <GyroApp
            sessions={sessions}
            events={events}
            draft={typed}
            elapsedMs={elapsed}
            chatProps={{ sessionPlan: sent ? plan(Math.min(3, shown)) : undefined, isComposerSending: sent && f < REPLY }}
          />
        </Window>
      </Camera>
      <Slab at={8} until={92} lines={[{ t: "Ask in", bg: WHITE, fg: INK }, { t: "plain words.", bg: C.coral, fg: WHITE }]} />
      <Pop at={70} until={ASK_AT} x={1560} y={190} rot={5} bg={C.green} fg={WHITE}>✓ 12 passed</Pop>
      <Slab at={ASK_AT + 6} until={REPLY + 30} lines={[{ t: "You approve", bg: INK, fg: WHITE }, { t: "what runs.", bg: WHITE, fg: C.blue }]} />
      <Pop at={APPROVE} x={1540} y={230} rot={-6} bg={WHITE} fg={C.green} size={56}>✓ Approved</Pop>
      <Slab at={REPLY + 36} lines={[{ t: "PR #214 opened.", bg: C.coral, fg: WHITE }]} size={110} />
    </Stage>
  );
};
