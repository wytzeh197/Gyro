import { AbsoluteFill, useCurrentFrame } from "remotion";
import { GyroApp, makeSessions, ev } from "../app/GyroApp";

const sessions = makeSessions([{ title: "Fix the checkout bug" }, { title: "Fix flaky editor file tests" }, { title: "Audit provider arguments" }]);
const T = "2026-11-17T09:00:00Z";
const act = (id: string, activityKind: string, label: string, extra: Record<string, unknown> = {}) =>
  ev("system-event", label, { kind: "provider-activity", activityKind, activityId: id, status: "completed", label, ...extra });

const user = ev("user-message", "Fix the checkout bug and open a PR.");
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
const plan = (done: number) => ({
  sessionId: "s-0", title: "Fix checkout total", sourceTurnId: "turn-1", updatedAt: T + done,
  items: ["Find where the total is computed", "Round discounts before summing", "Add a regression test", "Open a pull request"].map((title, i) => ({
    id: "p" + i, title, status: i < done ? "complete" : i === done ? "in-progress" : "todo", createdAt: T, updatedAt: T + done,
  })),
});

export const AppTest: React.FC<{ probe?: number }> = ({ probe }) => {
  const frame = useCurrentFrame();
  const f = probe ?? frame;
  const shown = Math.min(steps.length, Math.floor(f / 10));
  const events = [user, ...steps.slice(0, shown), ...(f > 50 ? [approval(f > 75 ? "approved" : "pending")] : [])];
  return (
    <AbsoluteFill
      style={{
        background: "#ECEEFB",
        alignItems: "center",
        justifyContent: "center",
        translate: "85px 0px"
      }}
    >
      <div style={{ transform: "scale(1.2)" }}>
        <GyroApp sessions={sessions} events={events} elapsedMs={f * 1000 / 30 * 4} chatProps={{ sessionPlan: plan(Math.min(3, shown)), isComposerSending: f < 75 }} />
      </div>
    </AbsoluteFill>
  );
};
