// 0–12s. Along the dock, click Gyro, the window opens, type, send. The arrow lifts into white.
import { useFrame } from "../pace";
import { AbsoluteFill } from "remotion";
import { GyroApp } from "../app/GyroApp";
import { ASK, sessions } from "../cut/data";
import { C, out } from "../ui/theme";
import { Cam, Desktop, GYRO_ICON, Key, TakeCam, TakePointer, Window, camAt, p01, toScreen, winPt } from "./kit";

export const OPEN = 360;
const CLICK_ICON = 94;
const WIN_IN: [number, number] = [112, 150];
const CLICK_BOX = 187;
const TYPE = 206;
const CLICK_SEND = 281;
const LIFT = 286;

const box = winPt(560, 715);
const send = winPt(1098, 762);
const composerC = winPt(757, 715);

const keys: Key[] = [
  [0, 650, 1004, 2.6],
  [18, 650, 1004, 2.6],
  [76, 960, 1004, 2.6],
  [WIN_IN[0], 960, 1004, 2.6],
  [WIN_IN[1] + 4, 960, 520, 1.0],
  [196, 960, 520, 1.0],
  [234, composerC[0], composerC[1], 1.9],
];

/** After the send, the camera follows the lifting button up. */
const liftY = (f: number) => send[1] - 1500 * p01(f, LIFT, 344, (t) => t * t * (3 - 2 * t));
const camFor = (f: number): Cam => {
  const base = camAt(keys, f);
  if (f < LIFT) return base;
  const k = p01(f, LIFT, 316);
  const y = liftY(f);
  return { cx: base.cx + (send[0] - base.cx) * k, cy: base.cy + (y + 40 - base.cy) * k, s: base.s + (1.5 - base.s) * p01(f, LIFT, 340) };
};

const pad = (n: number) => String(n).padStart(2, "0");
export const clockText = (min: number) => `Tue 17 Nov  ${pad(Math.floor(min / 60) % 24)}:${pad(Math.floor(min % 60))}`;

export const Open: React.FC = () => {
  const f = useFrame();
  const cam = camFor(f);
  const typed = f < TYPE ? "" : ASK.slice(0, Math.floor((f - TYPE) * 0.75));
  // Window grows out of the dock icon.
  const w = p01(f, WIN_IN[0], WIN_IN[1], out);
  const winC = winPt(640, 400);
  const sc = 0.04 + 0.96 * w;
  const dy = (GYRO_ICON[1] - winC[1]) * (1 - w);
  const sent = f >= CLICK_SEND + 2;
  const lifting = f >= LIFT;
  const [ax, ay] = toScreen(cam, send[0], liftY(f));
  const btn = 15.4 * cam.s; // button radius on screen
  const shrink = 1 - p01(f, 344, 358, out);
  const white = p01(f, 300, 336);
  const pointerX = f < 90 ? 600 + (960 - 600) * p01(f, 4, 84) : 960;
  return (
    <AbsoluteFill style={{ background: C.canvas }}>
      <TakeCam cam={cam}>
        <Desktop clock={clockText(9 * 60 + 41)} hoverX={f < WIN_IN[1] ? pointerX : undefined} bounceAt={CLICK_ICON} gyroRunning={f >= CLICK_ICON}>
          {f >= WIN_IN[0] && (
            <div style={{ position: "absolute", inset: 0, transformOrigin: `${winC[0]}px ${winC[1]}px`, transform: `translateY(${dy}px) scale(${sc})`, opacity: Math.min(1, w * 4) }}>
              <Window>
                <GyroApp sessions={sessions} events={[]} draft={sent ? "" : typed} />
              </Window>
              {/* The real send button is covered once its arrow lifts away. */}
              {lifting && <div style={{ position: "absolute", left: send[0] - 18, top: send[1] - 18, width: 36, height: 36, borderRadius: 18, background: "#fff" }} />}
            </div>
          )}
        </Desktop>
      </TakeCam>
      <TakePointer
        cam={cam}
        keys={[
          [0, 560, 1046],
          [84, 960, 1030],
          [WIN_IN[1], 960, 1030],
          [CLICK_BOX - 4, box[0], box[1]],
          [TYPE + 30, box[0] + 120, box[1] + 60],
          [CLICK_SEND - 3, send[0], send[1]],
        ]}
        clicks={[CLICK_ICON, CLICK_BOX, CLICK_SEND]}
        at={2}
        until={CLICK_SEND + 6}
      />
      <AbsoluteFill style={{ background: "#fff", opacity: white }} />
      {lifting && shrink > 0 && (
        <div style={{ position: "absolute", left: ax - btn, top: ay - btn, width: btn * 2, height: btn * 2, borderRadius: "50%", background: C.ink, transform: `scale(${shrink})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width={btn} height={btn} viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
          </svg>
        </div>
      )}
    </AbsoluteFill>
  );
};
