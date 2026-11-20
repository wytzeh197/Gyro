// One Gyro window, four ways to work. The pointer clicks through chat, CLI, the IDE and the pane grid.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { ChatGridSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp } from "../app/GyroApp";
import { ide } from "../app/ide";
import { cli } from "../scenes/Probe";
import { ASK, W, plan, reply, sessions, steps, userMsg } from "../cut/data";
import { Pane } from "../cut/Pane";
import { C, out } from "../ui/theme";
import { Key, TakeCam, TakePointer, TypeCard, camAt, p01 } from "./kit";

export const TOUR = 470;
const AX = 320, AY = 140;
const at = (x: number, y: number): [number, number] => [AX + x, AY + y];
const box = at(560, 715);
const send = at(1098, 762);
const cliBtn = at(216, 64);
const codeBtn = at(202, 23);
const chatBtn = at(149, 23);

const SEND = 70;
const CLI = 150;
const CODE = 250;
const GRID = 350;
const TILE = [GRID + 2, GRID + 24, GRID + 42, GRID + 58];

const keys: Key[] = [
  [0, 960, 480, 0.9],
  [26, 960, 480, 1.14],
  [SEND + 40, 960, 474, 1.22],
  [CLI - 6, 960, 480, 1.14],
  [CLI + 40, 960, 480, 1.2],
  [CODE - 6, 960, 480, 1.14],
  [CODE + 50, 980, 474, 1.22],
  [GRID - 6, 960, 480, 1.14],
  [GRID + 80, 960, 480, 1.16],
  [TOUR, 960, 480, 1.14],
];

const captions: [string, number, number][] = [
  ["Talk to AI.", 8, CLI - 6],
  ["Or use the CLI.", CLI + 6, CODE - 6],
  ["Check the code in-house.", CODE + 6, GRID - 6],
  ["Run them side by side.", GRID + 10, TOUR - 4],
];

const noop = () => undefined;

export const Tour: React.FC = () => {
  const f = useCurrentFrame();
  const cam = camAt(keys, f);
  const appIn = p01(f, 0, 20, out);
  const typed = ASK.slice(0, Math.max(0, Math.floor((f - 26) * 1.2)));
  const sent = f >= SEND + 2;
  const k = Math.floor((f - SEND - 14) / 10);
  const events = sent ? [userMsg, ...steps.slice(0, Math.max(0, Math.min(steps.length, k))), ...(k > steps.length ? [reply] : [])] : [];
  const replied = sent && k > steps.length;

  let app: React.ReactNode;
  if (f < CLI + 2) {
    app = <GyroApp sessions={sessions} events={events as never} draft={sent ? "" : typed} elapsedMs={sent ? ((f - SEND) * 1000) / 30 * 6 : 0} chatProps={{ sessionPlan: sent ? plan(Math.min(3, Math.max(0, k))) : undefined, isComposerSending: sent && !replied }} />;
  } else if (f < CODE + 2) {
    app = <GyroApp sessions={sessions} events={[]} className="film-grid4" content={cli(f - CLI)} chromeProps={{ activeWorkspaceLayout: "terminal-grid" }} />;
  } else if (f < GRID + 2) {
    app = <GyroApp sessions={sessions} events={[]} content={ide(f - CODE, [4, 9])} chromeProps={{ activeWorkspaceLayout: "code", workspaceSidebarHidden: true }} />;
  } else {
    const count = TILE.filter((t) => f >= t).length;
    const layout = {
      projectKey: W,
      focusedPaneId: `pane-${count - 1}`,
      arrangement: count >= 3 ? ("grid" as const) : ("columns" as const),
      slots: Array.from({ length: 4 }, (_, i) => (i < count ? { paneId: `pane-${i}`, kind: "session" as const, sessionId: `s-${i}`, workspacePath: W } : null)),
    };
    app = (
      <GyroApp
        sessions={sessions}
        events={[]}
        content={
          <ChatGridSurface
            layout={layout as never}
            onDropSession={() => false}
            onFocusPane={noop}
            onMovePane={() => false}
            onToggleMaximize={noop}
            renderPane={(pane: any, options: any) => {
              const i = Number(pane.paneId.split("-")[1]);
              return <Pane i={i} t={f - TILE[i]} options={options} />;
            }}
          />
        }
      />
    );
  }

  // A soft flash on each surface switch so the change reads as a click, not a cut.
  const flash = [CLI, CODE, GRID].reduce((m, s) => Math.max(m, f >= s + 2 && f < s + 12 ? 1 - (f - s - 2) / 10 : 0), 0);

  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <TakeCam cam={cam}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, background: C.canvas, opacity: appIn }} />
        <div style={{ position: "absolute", left: AX, top: AY, opacity: appIn, transform: `translateY(${(1 - appIn) * 40}px)`, boxShadow: "0 0 0 1px rgba(16,20,42,0.08), 0 30px 80px -24px rgba(16,20,42,0.35)", borderRadius: 14, overflow: "hidden" }}>
          {app}
          <div style={{ position: "absolute", inset: 0, background: "#fff", opacity: flash * 0.35, pointerEvents: "none" }} />
        </div>
      </TakeCam>
      <TakePointer
        cam={cam}
        keys={[
          [10, box[0] + 220, box[1] + 120],
          [22, box[0], box[1]],
          [SEND - 8, send[0], send[1]],
          [SEND + 30, send[0] - 120, send[1] - 200],
          [CLI - 4, cliBtn[0], cliBtn[1]],
          [CLI + 30, cliBtn[0] + 200, cliBtn[1] + 160],
          [CODE - 4, codeBtn[0], codeBtn[1]],
          [CODE + 30, codeBtn[0] + 240, codeBtn[1] + 200],
          [GRID - 4, chatBtn[0], chatBtn[1]],
          [GRID + 30, chatBtn[0] + 260, chatBtn[1] + 240],
        ]}
        clicks={[22, SEND, CLI, CODE, GRID]}
        at={10}
        until={GRID + 40}
      />
      {captions.map(([t, a, u]) => (
        <TypeCard key={t} text={t} at={a} cps={0.5} del={u - 24} until={u} size={56} y={78} />
      ))}
    </AbsoluteFill>
  );
};
