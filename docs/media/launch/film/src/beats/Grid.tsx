import { useCurrentFrame } from "remotion";
import { ChatGridSurface, ChatSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp, makeSessions } from "../app/GyroApp";
import { config } from "../fixtures/config.js";
import { Camera } from "../ui/motion";
import { Stage, Window } from "../ui/film";
import { Marquee, Pop, Slab, INK, WHITE } from "../ui/bold";
import { C } from "../ui/theme";

// 25–33s. Split chats tile in one by one, each on its own worktree.
export const GRID = 240;
const W = "/Users/demo/aurora";
const panes = [
  { title: "Fix the checkout bug", providerId: "anthropic", modelId: "claude-opus-5", ask: "Fix the checkout bug and open a PR.", acts: ["Edited src/cart/total.ts", "Ran pnpm test cart · 12 passed", "Opened PR #214"] },
  { title: "Audit provider arguments", providerId: "openai", modelId: "gpt-5.6", ask: "Audit provider arguments for unsafe flags.", acts: ["Scanned src/providers", "Patched src/providers/args.ts", "0 unsafe flags remain"] },
  { title: "Fix flaky editor file tests", providerId: "anthropic", modelId: "claude-sonnet-5", ask: "Fix the flaky editor file tests.", acts: ["Found a race in watcher teardown", "Edited src/editor/watcher.ts", "Ran pnpm test editor · 48 passed"] },
  { title: "Write release notes", providerId: "openai", modelId: "gpt-5.6", ask: "Write release notes from main..HEAD.", acts: ["Read 23 commits", "Wrote CHANGELOG.md"] },
];
const sessions = makeSessions(panes.map((p) => ({ title: p.title })));
const TILE = [0, 34, 62, 88];

const paneEvents = (i: number, f: number) => {
  const p = panes[i];
  const t = f - TILE[i];
  const base = { sessionId: "s-" + i, turnId: "turn-" + i, createdAt: "2026-11-17T09:00:00Z", payload: {} as Record<string, unknown> };
  const list = [{ ...base, id: `u${i}`, kind: "user-message", message: p.ask }];
  p.acts.slice(0, Math.max(0, Math.floor((t - 16) / 22))).forEach((label, k) =>
    list.push({ ...base, id: `a${i}${k}`, kind: "system-event", message: label, payload: { kind: "provider-activity", activityKind: k === 0 ? "read" : "file", activityId: `a${i}${k}`, status: "completed", label } }),
  );
  if (t >= 16 + p.acts.length * 22) list.push({ ...base, id: `r${i}`, kind: "assistant-message", message: "Done. " + p.acts[p.acts.length - 1] + "." });
  return list;
};

export const Grid: React.FC = () => {
  const f = useCurrentFrame();
  const count = TILE.filter((t) => f >= t).length;
  const layout = {
    projectKey: W,
    focusedPaneId: `pane-${count - 1}`,
    arrangement: count >= 3 ? ("grid" as const) : ("columns" as const),
    slots: Array.from({ length: 4 }, (_, i) => (i < count ? { paneId: `pane-${i}`, kind: "session" as const, sessionId: `s-${i}`, workspacePath: W } : null)),
  };
  const noop = () => undefined;
  return (
    <Stage color="blue">
      <Marquee text="SPLIT · TILE · PARALLEL ·" y={-30} size={300} speed={7} outline color="rgba(255,255,255,0.32)" />
      <Marquee text="SPLIT · TILE · PARALLEL ·" y={790} size={300} speed={-7} start={-1800} />
      <Camera keys={[[0, 960, 540, 1.0], [120, 960, 540, 1.0], [165, 1220, 360, 1.45], [GRID, 1230, 370, 1.5]]}>
        <Window>
          <GyroApp
            sessions={sessions}
            events={[]}
            elapsedMs={f * 300}
            content={
              <ChatGridSurface
                layout={layout as never}
                onDropSession={() => false}
                onFocusPane={noop}
                onMovePane={() => false}
                onToggleMaximize={noop}
                renderPane={(pane: any, options: any) => {
                  const i = Number(pane.paneId.split("-")[1]);
                  const p = panes[i];
                  return (
                    <ChatSurface
                      config={config as never}
                      events={paneEvents(i, f) as never}
                      paneKey={pane.paneId}
                      sessionTitle={p.title}
                      workspacePath={W}
                      branchName={i === 0 ? "main" : "gyro/" + p.title.toLowerCase().split(" ").slice(0, 2).join("-")}
                      sessionModel={{ providerId: p.providerId, modelId: p.modelId } as never}
                      isTiled={options.isTiled}
                      isComposerSending={f - TILE[i] < 16 + p.acts.length * 22}
                      onPaneDragStart={options.onPaneDragStart}
                      onPaneDragEnd={options.onPaneDragEnd}
                      onPanePointerDown={options.onPanePointerDown}
                      onComposerAction={noop}
                      onSend={noop}
                      shellReady
                    />
                  );
                }}
              />
            }
          />
        </Window>
      </Camera>
      {TILE.map((t, i) => (
        <Pop key={i} at={t + 4} until={112} x={[1640, 1700, 1620, 1690][i]} y={[150, 250, 350, 450][i]} rot={[-5, 4, -3, 5][i]} bg={[WHITE, C.coral, INK, WHITE][i]} fg={[INK, WHITE, WHITE, C.blue][i]}>
          {["Chat 1", "Chat 2", "Chat 3", "Chat 4"][i]}
        </Pop>
      ))}
      <Slab at={10} until={110} lines={[{ t: "Split chats.", bg: WHITE, fg: INK }, { t: "One window.", bg: C.coral, fg: WHITE }]} />
      {["gyro/audit-provider", "gyro/fix-flaky", "gyro/write-release"].map((b, i) => (
        <Pop key={b} at={130 + i * 8} x={[420, 480, 400][i]} y={[150, 250, 350][i]} rot={[-4, 3, -2][i]} bg={[INK, WHITE, C.coral][i]} fg={[WHITE, INK, WHITE][i]} monoFont size={40}>
          ⎇ {b}
        </Pop>
      ))}
      <Slab at={122} lines={[{ t: "Each on its", bg: INK, fg: WHITE }, { t: "own worktree.", bg: WHITE, fg: C.blue }]} />
    </Stage>
  );
};
