import { useCurrentFrame } from "remotion";
import { AutomationsSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp, makeSessions } from "../app/GyroApp";
import { Camera } from "../ui/motion";
import { Stage, Window } from "../ui/film";
import { Marquee, Pop, Slab, INK, WHITE } from "../ui/bold";
import { C, mono } from "../ui/theme";

// 33–39s. Work that runs overnight and waits for review in the morning.
export const AUTOMATIONS = 180;
const sessions = makeSessions([{ title: "Fix the checkout bug" }, { title: "Fix flaky editor file tests" }, { title: "Audit provider arguments" }]);
const D = "2026-11-17T";
const auto = (id: string, title: string, prompt: string, schedule: string, status: string, triage: string, result: string, runs: [string, string][], unread = 0) => ({
  id, title, prompt, schedule, status, triageState: triage, project: "/Users/demo/aurora", provider: "anthropic", branch: "main",
  workspaceMode: "worktree", worktreeName: id, lastRunAt: D + "03:00:00Z", nextRunAt: "2026-11-18T03:00:00Z", lastResult: result, unreadResults: unread,
  runHistory: runs.map(([status, summary], k) => ({ id: `${id}-r${k}`, status, summary, startedAt: D + "03:00:00Z", finishedAt: D + "03:14:00Z" })),
});

const clock = (f: number) => {
  // 03:00 rolls forward to 07:58 as the beat plays.
  const m = Math.min(298, Math.floor(Math.max(0, f - 20) * 2.2));
  const h = 3 + Math.floor(m / 60);
  return `0${h}:${String(m % 60).padStart(2, "0")} AM`;
};

export const Automations: React.FC = () => {
  const f = useCurrentFrame();
  const nightly = f >= 70 ? "passed" : "running";
  const list = [
    auto("nightly-deps", "Update dependencies nightly", "Bump minor versions, run the full suite, open a PR if green.", "daily-at", "current", f >= 70 ? "needs-review" : "none",
      f >= 70 ? "PR #217 · 14 packages updated · all tests pass" : "Running pnpm test…", [[nightly, f >= 70 ? "14 packages updated, PR #217" : "Running"], ["passed", "9 packages updated, PR #209"]], f >= 70 ? 1 : 0),
    auto("triage-issues", "Triage new issues", "Label new GitHub issues and draft a first reply.", "hourly", "current", "needs-review", "6 issues labelled · 2 replies drafted", [["passed", "6 issues labelled"]], 2),
    auto("flaky-hunt", "Hunt flaky tests", "Rerun the suite 20× and fix anything that flakes.", "weekly-at", "current", "none", "No flakes found in 20 runs", [["passed", "No flakes"]]),
  ];
  return (
    <Stage color="ink">
      <Marquee text="WHILE YOU SLEEP ·" y={-30} size={300} speed={6} outline color="rgba(125,144,255,0.45)" />
      <Marquee text="WHILE YOU SLEEP ·" y={790} size={300} speed={-6} start={-1500} color="rgba(125,144,255,0.18)" />
      <Camera keys={[[0, 960, 560, 1.05], [40, 960, 540, 1], [100, 860, 420, 1.35], [AUTOMATIONS, 840, 400, 1.4]]}>
        <Window shadow={C.coral}>
          <GyroApp
            sessions={sessions}
            events={[]}
            chromeProps={{ activeDestination: "automations" }}
            content={<AutomationsSurface automations={list as never} selectedAutomationId="nightly-deps" />}
          />
        </Window>
      </Camera>
      <Pop at={20} x={1580} y={190} rot={5} bg={C.blue} fg={WHITE} size={96}>
        <span style={{ fontFamily: mono, fontWeight: 700 }}>{clock(f)}</span>
      </Pop>
      <Pop at={70} x={1520} y={360} rot={-4} bg={C.green} fg={WHITE} size={52}>✓ PR #217 ready</Pop>
      <Slab at={10} lines={[{ t: "Runs overnight.", bg: WHITE, fg: INK }, { t: "Ready by morning.", bg: C.coral, fg: WHITE }]} />
    </Stage>
  );
};
